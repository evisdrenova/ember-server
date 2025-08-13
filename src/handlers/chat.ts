// src/handlers/chat-handler.ts
import * as grpc from "@grpc/grpc-js";
import { Pool, PoolClient } from "pg";
import OpenAI from "openai";
import {
  ResponseInput,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { v7 as uuidv7 } from "uuid";

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

interface WeatherResponse {
  current: {
    time: string;
    interval: number;
    temperature_2m: number;
    wind_speed_10m: number;
  };
  current_units: {
    time: string;
    interval: string;
    temperature_2m: string;
    wind_speed_10m: string;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    wind_speed_10m: number[];
  };
  hourly_units: {
    time: string;
    temperature_2m: string;
    relative_humidity_2m: string;
    wind_speed_10m: string;
  };
}

const tools: OpenAI.Responses.Tool[] = [
  {
    type: "function",
    name: "save_memory",
    strict: false,
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
    type: "function",
    name: "get_weather",
    description:
      "Get current temperature for provided coordinates in fahrenheit.",
    parameters: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
      },
      required: ["latitude", "longitude"],
      additionalProperties: false,
    },
    strict: true,
  },
  // {
  //   type: "mcp",
  //   server_label: "deepwiki",
  //   server_url: "https://mcp.deepwiki.com/mcp",
  //   require_approval: "never",
  // },
];

//TODO: try making this a unary call both ways and then update to streaming later

export default class ChatHandler {
  private openaiClient: OpenAI;
  private dbPool: Pool;
  private sessions: Map<string, ConversationSession> = new Map();

  constructor(openaiClient: OpenAI, dbPool: Pool) {
    this.openaiClient = openaiClient;
    this.dbPool = dbPool;
    console.log("Chat handler initialized");
  }

  // async chat(call: grpc.ServerDuplexStream<ChatRequest, ChatResponse>) {
  //   call.on("data", async (request: ChatRequest) => {

  //     try {

  //       console.log(
  //         `Received message from pi: session=${request.sessionId}, text='${request.message}'`
  //       );

  //       const session = await this.getOrCreateSession(request.sessionId);

  //       const userMessage: ResponseInputItem = {
  //         role: "user",
  //         content: request.message,
  //       };

  //       session.messages.push(userMessage);
  //       session.lastActivity = new Date();

  //       // save user message
  //       await this.saveMessage(session.sessionId, "user", request.message);

  //       const response = await this.openaiClient.responses.create({
  //         input: session.messages,
  //         instructions: this.getDefaultSystemPrompt(),
  //         model: "gpt-4o",
  //         tools,
  //       });

  //       // the entire output
  //       console.log("response from llm ", response.output);
  //       // hjust the text output
  //       console.log("output_text", response.output_text);
  //       // how the model should seelct the tool
  //       console.log(
  //         "response && response.output[0] ",
  //         response && response.output[0]
  //       );

  //       // if (response.output) {
  //       //   response.tools?.forEach((toolCall, i) => {
  //       //     console.log(`🔍 Tool call ${i}: ${toolCall.type}`);
  //       //   });
  //       // }

  //       // Handle tool calls if present
  //       if (response.output && response.output.length > 0) {
  //         // Process each tool call
  //         for (const res of response.output) {
  //           if (res.type == "function_call") {
  //             switch (res.name) {
  //               case "save_memory":
  //                 console.log(`saving memory`);
  //                 await this.handleSaveMemoryTool(JSON.parse(res.arguments));
  //                 break;
  //               case "get_weather":
  //                 const args = JSON.parse(res.arguments);
  //                 console.log(`gettng weather`, args);
  //                 const weather = await this.getWeather(
  //                   args.latitude,
  //                   args.longitude
  //                 );
  //                 // push back into the messages to send back to model
  //                 session.messages.push(res);
  //                 session.messages.push({
  //                   type: "function_call_output",
  //                   call_id: res.call_id,
  //                   output: weather,
  //                 });
  //                 break;
  //               default:
  //                 console.log(`Unknown function call: ${res.name}`);
  //                 break;
  //             }
  //           }
  //         }
  //       }

  //       const updatedResponse = await this.openaiClient.responses.create({
  //         input: session.messages,
  //         instructions: this.getDefaultSystemPrompt(),
  //         model: "gpt-4o",
  //         tools,
  //       });

  //       // Get the text content from the response
  //       const responseContent = updatedResponse.output_text;

  //       // Add final assistant response to session
  //       if (responseContent) {
  //         session.messages.push({
  //           role: "assistant",
  //           content: responseContent,
  //         });
  //       }

  //       // Save assistant message to database
  //       await this.saveMessage(session.sessionId, "assistant", responseContent);

  //       const chatResponse: ChatResponse = {
  //         sessionId: session.sessionId,
  //         textResponse: responseContent,
  //         isFinal: true,
  //       };

  //       console.log(`📤 Sending response: '${chatResponse.textResponse}'`);

  //       call.write(chatResponse);
  //       call.end();
  //     } catch (error) {
  //       console.error("❌ Error processing chat message:", error);
  //       call.emit("error", {
  //         code: grpc.status.INTERNAL,
  //         message: `Internal error: ${error}`,
  //       });
  //     }
  //   });

  //   // call.on("end", () => {
  //   //   console.log("📞 Chat stream ended");
  //   //   call.end();
  //   // });

  //   call.on("error", (error) => {
  //     console.error("❌ Chat stream error:", error);
  //   });
  // }
  // async chat(call: grpc.ServerWritableStream<ChatRequest, ChatResponse>) {
  //   try {
  //     const { sessionId, message } = call.request;

  //     const stream = await this.openaiClient.responses.stream({
  //       model: "gpt-4o",
  //       input: [{ role: "user", content: message }],
  //       instructions: this.getDefaultSystemPrompt(),
  //       tools,
  //     });

  //     let finalText = "";

  //     // token deltas
  //     stream.on("response.output_text.delta", (delta) => {
  //       finalText += delta;
  //       call.write({ sessionId, textResponse: delta.delta, isFinal: false });
  //     });

  //     // final text (per OutputText tool)
  //     stream.on("response.output_text.done", () => {
  //       // optional: nothing needed here if you also send on 'response.completed'
  //     });

  //     // entire response finished
  //     stream.on("response.completed", () => {
  //       call.write({ sessionId, textResponse: finalText, isFinal: true });
  //       call.end();
  //     });

  //     // errors
  //     stream.on("response.failed", (err: unknown) => {
  //       console.error("OpenAI stream error:", err);
  //       call.destroy(err as any);
  //     });

  //     // make sure we await the stream lifecycle so it doesn’t get GC’d early
  //     await stream.done();
  //   } catch (err) {
  //     console.error("❌ Chat handler error:", err);
  //     call.destroy(err as any);
  //   }
  // }

  async chat(call: grpc.ServerWritableStream<ChatRequest, ChatResponse>) {
    try {
      const { sessionId, message } = call.request;

      const stream = await this.openaiClient.responses.stream({
        model: "gpt-4o",
        input: [{ role: "user", content: message }],
        instructions: this.getDefaultSystemPrompt(),
        tools,
      });

      let completeText = "";

      for await (const evt of stream) {
        switch (evt.type) {
          case "response.output_text.delta":
            // this is a string chunk
            completeText += evt.delta;
            break;

          case "response.completed":
            call.write({
              sessionId,
              textResponse: completeText,
              isFinal: true,
            });
            call.end();
            break;

          case "response.failed":
            console.error("OpenAI stream error:", evt);
            call.destroy(
              new Error(
                typeof (evt as any).error === "string"
                  ? (evt as any).error
                  : JSON.stringify(evt)
              )
            );
            break;

          default:
            break;
        }
      }

      // Safety: if the stream finished without emitting response.completed
      if (completeText && !call.closed) {
        call.write({ sessionId, textResponse: completeText, isFinal: true });
        call.end();
      }
    } catch (err) {
      console.error("❌ Chat handler error:", err);
      call.destroy(err as any);
    }
  }

  private async getWeather(
    latitude: number,
    longitude: number
  ): Promise<string> {
    try {
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`
      );

      if (!response.ok) {
        throw new Error(
          `Weather API request failed: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as WeatherResponse;

      if (!data.current || typeof data.current.temperature_2m !== "number") {
        throw new Error("Invalid weather data received");
      }

      const temperature = data.current.temperature_2m;
      const windSpeed = data.current.wind_speed_10m;
      const tempUnit = data.current_units.temperature_2m;
      const windUnit = data.current_units.wind_speed_10m;

      return `Current weather: ${temperature}${tempUnit}, wind speed ${windSpeed} ${windUnit}`;
    } catch (error) {
      console.error("Failed to fetch weather data:", error);
      throw new Error(
        `Unable to fetch weather data: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private async getOrCreateSession(
    sessionId: string
  ): Promise<ConversationSession> {
    // early return if the session doesn't exist
    if (!sessionId) {
      const session = await this.createNewSession();
      this.sessions.set(sessionId, session);
      return session;
    }

    // Check if session exists in memory
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    } else {
      // try to pull from db
      const session = await this.loadSessionFromDB(sessionId);
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

  private generateSessionId(): string {
    return uuidv7();
  }

  private async createNewSession(): Promise<ConversationSession> {
    // Construct system prompt with memories
    const systemPrompt = await this.constructSystemPromptWithMemories();

    const newSessionId = this.generateSessionId();

    const session: ConversationSession = {
      sessionId: newSessionId,
      messages: [{ role: "system", content: systemPrompt }],
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    await this.saveMessage(newSessionId, "system", systemPrompt);

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
