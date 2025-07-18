// src/handlers/chat-handler.ts
import * as grpc from "@grpc/grpc-js";
import { Pool, PoolClient } from "pg";
import OpenAI from "openai";
import {
  ResponseInput,
  ResponseInputItem,
} from "openai/resources/responses/responses";

interface Memory {
  id: string;
  memory: string;
  embedding?: number[];
  created_at: Date;
}

interface ConversationSession {
  sessionId: string;
  messages: ResponseInputItem[];
  createdAt: Date;
  lastActivity: Date;
}

interface ConversationMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: Date;
}

interface ChatRequest {
  sessionId: string;
  message: string;
}

interface ChatResponse {
  sessionId: string;
  textResponse: string;
  isFinal: boolean;
}

export default class ChatHandler {
  private openaiClient: OpenAI;
  private dbPool: Pool;
  private sessions: Map<string, ConversationSession> = new Map();

  constructor(openaiClient: OpenAI, dbPool: Pool) {
    this.openaiClient = openaiClient;
    this.dbPool = dbPool;
    console.log("Chat handler initialized");
  }

  async chat(call: grpc.ServerDuplexStream<ChatRequest, ChatResponse>) {
    console.log("📞 New chat stream opened");

    call.on("data", async (request: ChatRequest) => {
      try {
        console.log(
          `📨 Received message: session=${request.sessionId}, text='${request.message}'`
        );

        const session = await this.getOrCreateSession(request.sessionId);

        const userMessage: ResponseInputItem = {
          role: "user",
          content: request.message,
        };
        session.messages.push(userMessage);
        session.lastActivity = new Date();

        await this.saveMessage(request.sessionId, "user", request.message);

        const response = await this.openaiClient.responses.create({
          input: session.messages,
          instructions: this.getDefaultSystemPrompt(),
          model: "gpt-4o",
          tools: [
            {
              type: "function",
              name: "save_memory",
              strict: true,
              description:
                "Save personal information about the user that would be helpful to remember in future conversations. This includes: location/address, preferences, family details, important dates, interests, or any personal facts the user shares. Use this whenever the user mentions something personal about themselves.",
              parameters: {
                type: "object",
                properties: {
                  memory: {
                    type: "string",
                    description:
                      "The personal information to remember about the user. Be specific and include context.",
                  },
                },
                required: ["memory"],
              },
            },
            {
              type: "mcp",
              server_label: "deepwiki",
              server_url: "https://mcp.deepwiki.com/mcp",
              require_approval: "never",
            },
          ],
        });

        const tools = response && response.tools;

        if (tools) {
          tools?.forEach((toolCall, i) => {
            console.log(`🔍 Tool call ${i}: ${toolCall.type}`);
          });
        }

        // Handle tool calls if present
        if (tools && tools.length > 0) {
          // Process each tool call
          for (const toolCall of tools) {
            if (
              toolCall.type == "function" &&
              toolCall.name === "save_memory"
            ) {
              await this.handleSaveMemoryTool(toolCall.parameters);
            }
          }
        }

        // Get the text content from the response
        const responseContent = response.output_text;

        // Add final assistant response to session
        if (responseContent) {
          session.messages.push({
            role: "assistant",
            content: responseContent,
          });
        }

        // Save assistant message to database
        await this.saveMessage(request.sessionId, "assistant", responseContent);

        const chatResponse: ChatResponse = {
          sessionId: request.sessionId,
          textResponse: responseContent,
          isFinal: true,
        };

        console.log(`📤 Sending response: '${chatResponse.textResponse}'`);

        call.write(chatResponse);
      } catch (error) {
        console.error("❌ Error processing chat message:", error);
        call.emit("error", {
          code: grpc.status.INTERNAL,
          message: `Internal error: ${error}`,
        });
      }
    });

    call.on("end", () => {
      console.log("📞 Chat stream ended");
      call.end();
    });

    call.on("error", (error) => {
      console.error("❌ Chat stream error:", error);
    });
  }

  private async getOrCreateSession(
    sessionId: string
  ): Promise<ConversationSession> {
    // Check if session exists in memory
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    // Try to load from database
    try {
      const session = await this.loadSessionFromDB(sessionId);
      this.sessions.set(sessionId, session);
      return session;
    } catch (error) {
      console.log("Failed to load session from DB:", error);
      // Create new session if loading fails
      const session = await this.createNewSession(sessionId);
      this.sessions.set(sessionId, session);
      return session;
    }
  }

  private async loadSessionFromDB(
    sessionId: string
  ): Promise<ConversationSession> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query(
        "SELECT role, content, created_at FROM conversations WHERE session_id = $1 ORDER BY created_at ASC",
        [sessionId]
      );

      const session: ConversationSession = {
        sessionId,
        messages: [],
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      let hasSystemMessage = false;
      for (const row of result.rows) {
        const { role, content, created_at } = row;

        if (session.createdAt > created_at) {
          session.createdAt = created_at;
        }

        switch (role) {
          case "system":
            hasSystemMessage = true;
            session.messages.push({ role: "system", content });
            break;
          case "user":
            session.messages.push({ role: "user", content });
            break;
          case "assistant":
            session.messages.push({ role: "assistant", content });
            break;
        }
      }

      // If no system message found, add one
      if (!hasSystemMessage) {
        const systemPrompt = await this.constructSystemPromptWithMemories();
        session.messages.unshift({ role: "system", content: systemPrompt });
      }

      return session;
    } finally {
      client.release();
    }
  }

  private async createNewSession(
    sessionId: string
  ): Promise<ConversationSession> {
    // Construct system prompt with memories
    const systemPrompt = await this.constructSystemPromptWithMemories();

    const session: ConversationSession = {
      sessionId,
      messages: [{ role: "system", content: systemPrompt }],
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    // Save system message to database
    await this.saveMessage(sessionId, "system", systemPrompt);

    return session;
  }

  private async constructSystemPromptWithMemories(): Promise<string> {
    try {
      const memories = await this.getRelevantMemories();
      const basePrompt = this.getDefaultSystemPrompt();

      if (memories.length === 0) {
        return basePrompt;
      }

      // Build memory context
      let memoryContext = "\n\nRELEVANT MEMORIES:\n";
      memoryContext +=
        "Here are some relevant memories from past conversations:\n";

      for (const memory of memories) {
        memoryContext += `- ${memory.memory}\n`;
      }

      memoryContext +=
        "\nUse these memories to provide more personalized and contextual responses.\n";

      return basePrompt + memoryContext;
    } catch (error) {
      console.error("Failed to construct system prompt:", error);
      return this.getDefaultSystemPrompt();
    }
  }

  private async handleSaveMemoryTool(
    argumentsJSON: Record<string, unknown> | null
  ): Promise<string> {
    try {
      if (!argumentsJSON) {
        throw new Error("No arguments provided");
      }

      const args = argumentsJSON as { memory: string };

      if (!args.memory || typeof args.memory !== "string") {
        throw new Error("Invalid memory argument");
      }

      console.log(`💾 Saving memory: ${args.memory}`);

      await this.saveMemory(args.memory);
      return `Successfully saved memory: ${args.memory}`;
    } catch (error) {
      console.error("Failed to handle save_memory tool:", error);
      return `Error saving memory: ${error}`;
    }
  }

  private async saveMessage(
    sessionId: string,
    role: string,
    content: string
  ): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query(
        "INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)",
        [sessionId, role, content]
      );
    } catch (error) {
      console.error("Failed to save message:", error);
    } finally {
      client.release();
    }
  }

  private async saveMemory(text: string): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query("INSERT INTO memories (memory) VALUES ($1)", [text]);
    } catch (error) {
      console.error("Failed to save memory:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async getRelevantMemories(): Promise<Memory[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query(
        "SELECT id, memory, created_at FROM memories ORDER BY created_at DESC LIMIT 5"
      );

      return result.rows.map((row) => ({
        id: row.id,
        memory: row.memory,
        created_at: row.created_at,
      }));
    } catch (error) {
      console.error("Failed to get relevant memories:", error);
      return [];
    } finally {
      client.release();
    }
  }

  private getDefaultSystemPrompt(): string {
    return `PERSONAL HOME ASSISTANT: VOICE MODE

You are a helpful personal home assistant, similar to Amazon Alexa or Google Home. 
Your job is to give quick, accurate, conversational replies that sound natural when
spoken aloud.

CORE PRINCIPLES
– Speak, don't write. Use everyday speech and contractions.
– Keep the answer short enough to say in under thirty seconds, roughly 75–100 words.
– Be friendly and clear, never robotic or overly casual.

MEMORY MANAGEMENT
When users share personal information (location, preferences, family details, etc.), 
always save it using the save_memory tool. This helps provide better personalized 
responses in future conversations.

CONCISENESS
Give only the information the listener needs right now. Offer more detail only if
they ask. Put the most important point first.

LIVE INFORMATION
Any question that involves "today", "now", "current", times, weather, news, stock
prices, traffic, or live scores must trigger a real-time search before you answer.
Use stored knowledge for stable facts such as math, history, or definitions.

HOW TO ANSWER
For a question:
• Start with the direct answer in one sentence.
• Add one brief sentence of helpful context if needed.
For a request:
• Acknowledge what you will do.
• State the result or confirm it is done.

TIME-SENSITIVE DATA
If you searched, mention when the info was last updated if useful, and clarify the
time zone if you give a clock time.

EXAMPLES
Weather: "Right now in San Francisco it's 68 degrees and partly cloudy. The high 
will reach 72 with no rain expected."

News: "The top story this morning is the transit strike that started at 6 a.m. 
Would you like more details?"

Fact: "Canberra is the capital of Australia. It was chosen in 1913 as a compromise
between Sydney and Melbourne."

Calculation: "Fifteen percent of 250 dollars is 37 dollars and 50 cents."

ERROR HANDLING
If you cannot find current information: 
"I'm sorry, I don't have live data on that right now. Let me try another source."
If the user's request is unclear:
"I want to help. Could you tell me a bit more about what you need?"

TONE
Sound like a knowledgeable, patient friend. Stay positive and encouraging.

IMPORTANT
Return plain sentences ready for text-to-speech. Do not use Markdown, HTML, 
asterisks, numbered lists, code fences, or emojis.`;
  }
}
