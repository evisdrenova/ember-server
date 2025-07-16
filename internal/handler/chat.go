package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	pb "github.com/evisdrenova/ember-server/pkg/proto/assistant/v1"
	"github.com/jackc/pgx/v5"
	"github.com/openai/openai-go"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type ChatHandler struct {
	pb.UnimplementedAssistantServiceServer
	openaiClient *openai.Client
	db_conn      *pgx.Conn
	sessions     map[string]*ConversationSession
}

type Memory struct {
	Id        string    `db:"id"`
	Memory    string    `db:"memory"`
	Embedding []float32 `db:"embedding"`
	CreatedAt time.Time `db:"created_at"`
}

type ConversationSession struct {
	SessionId    string
	Messages     []openai.ChatCompletionMessageParamUnion
	CreatedAt    time.Time
	LastActivity time.Time
}

type ConversationMessage struct {
	Id        string    `db:"id"`
	SessionId string    `db:"session_id"`
	Role      string    `db:"role"`
	Content   string    `db:"content"`
	CreatedAt time.Time `db:"created_at"`
}

func NewChatHandler(ctx context.Context, openaiClient *openai.Client, db_conn *pgx.Conn) *ChatHandler {
	handler := &ChatHandler{
		openaiClient: openaiClient,
		db_conn:      db_conn,
		sessions:     make(map[string]*ConversationSession),
	}

	// Start cleanup routine for old sessions
	go handler.cleanupOldSessions()

	log.Printf("✅ Chat handler initialized")
	return handler
}

func (h *ChatHandler) Chat(stream pb.AssistantService_ChatServer) error {
	for {
		req, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			log.Printf("stream recv error: %v", err)
			return status.Errorf(codes.Internal, "stream error: %v", err)
		}

		log.Printf("📨 Received message: session=%s, text='%s'", req.SessionId, req.Message)

		// Get or create conversation session
		session, err := h.getOrCreateSession(req.SessionId)
		if err != nil {
			log.Printf("Failed to get/create session: %v", err)
			return status.Errorf(codes.Internal, "session error: %v", err)
		}

		// Add user message to session
		userMessage := openai.UserMessage(req.Message)
		session.Messages = append(session.Messages, userMessage)
		session.LastActivity = time.Now()

		// Save user message to database
		err = h.saveMessage(context.Background(), req.SessionId, "user", req.Message)
		if err != nil {
			log.Printf("Failed to save user message: %v", err)
		}

		// Get AI response with tool support
		chatCompletion, err := h.openaiClient.Chat.Completions.New(context.TODO(), openai.ChatCompletionNewParams{
			Messages: session.Messages,
			Model:    openai.ChatModelGPT4o,
			Tools: []openai.ChatCompletionToolParam{
				{
					Function: openai.FunctionDefinitionParam{
						Name:        "save_memory",
						Description: openai.String("Save important personal information or facts about the user for future reference. Only use this for significant personal details like preferences, important dates, family information, or other facts that would be useful to remember in future conversations."),
						Parameters: openai.FunctionParameters{
							"type": "object",
							"properties": map[string]interface{}{
								"memory": map[string]interface{}{
									"type":        "string",
									"description": "The personal fact or information to remember about the user",
								},
							},
							"required": []string{"memory"},
						},
					},
				},
			},
		})
		if err != nil {
			log.Printf("OpenAI API error: %v", err)
			return status.Errorf(codes.Internal, "AI error: %v", err)
		}

		choice := chatCompletion.Choices[0]
		responseContent := ""

		// Handle tool calls if present
		if len(choice.Message.ToolCalls) > 0 {
			// Add the assistant message with tool calls to session
			session.Messages = append(session.Messages, choice.Message.ToParam())

			// Process each tool call
			for _, toolCall := range choice.Message.ToolCalls {
				if toolCall.Function.Name == "save_memory" {
					result, err := h.handleSaveMemoryTool(context.Background(), toolCall.Function.Arguments)
					if err != nil {
						log.Printf("Failed to handle save_memory tool: %v", err)
						result = fmt.Sprintf("Error saving memory: %v", err)
					}

					// Add tool call result to session
					session.Messages = append(session.Messages, openai.ToolMessage(result, toolCall.ID))
				}
			}

			// Get final response after tool execution
			finalCompletion, err := h.openaiClient.Chat.Completions.New(context.TODO(), openai.ChatCompletionNewParams{
				Messages: session.Messages,
				Model:    openai.ChatModelGPT4o,
			})
			if err != nil {
				log.Printf("OpenAI API error on tool follow-up: %v", err)
				return status.Errorf(codes.Internal, "AI error: %v", err)
			}

			responseContent = finalCompletion.Choices[0].Message.Content
		} else {
			// No tool calls, just regular response
			responseContent = choice.Message.Content
		}

		// Add final assistant response to session
		if responseContent != "" {
			session.Messages = append(session.Messages, openai.AssistantMessage(responseContent))
		}

		// Save assistant message to database
		err = h.saveMessage(context.Background(), req.SessionId, "assistant", responseContent)
		if err != nil {
			log.Printf("Failed to save assistant message: %v", err)
		}

		resp := &pb.ChatResponse{
			SessionId:    req.SessionId,
			TextResponse: responseContent,
			IsFinal:      true,
		}

		log.Printf("📤 Sending response: '%s'", resp.TextResponse)

		if err := stream.Send(resp); err != nil {
			log.Printf("stream send error: %v", err)
			return status.Errorf(codes.Internal, "send error: %v", err)
		}
	}
}

func (h *ChatHandler) getOrCreateSession(sessionId string) (*ConversationSession, error) {
	// Check if session exists in memory
	if session, exists := h.sessions[sessionId]; exists {
		return session, nil
	}

	// Try to load from database
	session, err := h.loadSessionFromDB(sessionId)
	if err != nil {
		log.Printf("Failed to load session from DB: %v", err)
		// Create new session if loading fails
		session = h.createNewSession(sessionId)
	}

	// Store in memory
	h.sessions[sessionId] = session
	return session, nil
}

func (h *ChatHandler) loadSessionFromDB(sessionId string) (*ConversationSession, error) {
	rows, err := h.db_conn.Query(context.Background(), `
		SELECT role, content, created_at 
		FROM conversations 
		WHERE session_id = $1 
		ORDER BY created_at ASC
	`, sessionId)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	session := &ConversationSession{
		SessionId:    sessionId,
		Messages:     []openai.ChatCompletionMessageParamUnion{},
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
	}

	var hasSystemMessage bool
	for rows.Next() {
		var role, content string
		var createdAt time.Time

		if err := rows.Scan(&role, &content, &createdAt); err != nil {
			return nil, err
		}

		if session.CreatedAt.After(createdAt) {
			session.CreatedAt = createdAt
		}

		switch role {
		case "system":
			hasSystemMessage = true
			session.Messages = append(session.Messages, openai.SystemMessage(content))
		case "user":
			session.Messages = append(session.Messages, openai.UserMessage(content))
		case "assistant":
			session.Messages = append(session.Messages, openai.AssistantMessage(content))
		}
	}

	// If no system message found, add one (this handles existing conversations)
	if !hasSystemMessage {
		systemPrompt, err := h.constructSystemPromptWithMemories()
		if err != nil {
			log.Printf("Failed to construct system prompt: %v", err)
			systemPrompt = getDefaultSystemPrompt()
		}

		// Prepend system message
		messages := []openai.ChatCompletionMessageParamUnion{openai.SystemMessage(systemPrompt)}
		session.Messages = append(messages, session.Messages...)
	}

	return session, nil
}

func (h *ChatHandler) createNewSession(sessionId string) *ConversationSession {
	// Construct system prompt with memories
	systemPrompt, err := h.constructSystemPromptWithMemories()
	if err != nil {
		log.Printf("Failed to construct system prompt: %v", err)
		systemPrompt = getDefaultSystemPrompt()
	}

	session := &ConversationSession{
		SessionId: sessionId,
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(systemPrompt),
		},
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
	}

	// Save system message to database
	err = h.saveMessage(context.Background(), sessionId, "system", systemPrompt)
	if err != nil {
		log.Printf("Failed to save system message: %v", err)
	}

	return session
}

func (h *ChatHandler) constructSystemPromptWithMemories() (string, error) {
	memories, err := h.getRelevantMemories(context.Background())
	if err != nil {
		return "", err
	}

	basePrompt := getDefaultSystemPrompt()

	if len(memories) == 0 {
		return basePrompt, nil
	}

	// Build memory context
	var memoryContext strings.Builder
	memoryContext.WriteString("\n\nRELEVANT MEMORIES:\n")
	memoryContext.WriteString("Here are some relevant memories from past conversations:\n")

	for _, memory := range memories {
		memoryContext.WriteString(fmt.Sprintf("- %s\n", memory.Memory))
	}

	memoryContext.WriteString("\nUse these memories to provide more personalized and contextual responses.\n")

	return basePrompt + memoryContext.String(), nil
}

func (h *ChatHandler) handleSaveMemoryTool(ctx context.Context, argumentsJSON string) (string, error) {
	// Parse the tool call arguments
	var args struct {
		Memory string `json:"memory"`
	}

	if err := json.Unmarshal([]byte(argumentsJSON), &args); err != nil {
		return "", fmt.Errorf("failed to parse arguments: %v", err)
	}

	log.Printf("💾 Saving memory: %s", args.Memory)

	// Generate a simple embedding (you can replace this with actual embeddings later)
	// For now, just create a placeholder embedding
	embedding := make([]float32, 768)
	for i := range embedding {
		embedding[i] = 0.0 // Placeholder - replace with real embeddings
	}

	// Save to database
	err := h.saveMemory(ctx, args.Memory, embedding)
	if err != nil {
		return "", fmt.Errorf("failed to save memory: %v", err)
	}

	return fmt.Sprintf("Successfully saved memory: %s", args.Memory), nil
}

func (h *ChatHandler) saveMessage(ctx context.Context, sessionId, role, content string) error {
	_, err := h.db_conn.Exec(ctx, `
		INSERT INTO conversations (session_id, role, content) 
		VALUES ($1, $2, $3)
	`, sessionId, role, content)
	return err
}

func (h *ChatHandler) saveMemory(ctx context.Context, text string, embedding []float32) error {
	_, err := h.db_conn.Exec(ctx, `
		INSERT INTO memories (memory, embedding) 
		VALUES ($1, $2)
	`, text, embedding)
	return err
}

func (h *ChatHandler) getRelevantMemories(ctx context.Context) ([]Memory, error) {
	// For now, get recent memories. Later you can implement vector similarity search
	rows, err := h.db_conn.Query(ctx, `
		SELECT id, memory, created_at 
		FROM memories 
		ORDER BY created_at DESC 
		LIMIT 5
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var memories []Memory
	for rows.Next() {
		var memory Memory
		if err := rows.Scan(&memory.Id, &memory.Memory, &memory.CreatedAt); err != nil {
			return nil, err
		}
		memories = append(memories, memory)
	}

	return memories, nil
}

func (h *ChatHandler) cleanupOldSessions() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		cutoff := time.Now().Add(-24 * time.Hour)

		for sessionId, session := range h.sessions {
			if session.LastActivity.Before(cutoff) {
				delete(h.sessions, sessionId)
				log.Printf("🧹 Cleaned up old session: %s", sessionId)
			}
		}
	}
}

func getDefaultSystemPrompt() string {
	return `PERSONAL HOME ASSISTANT: VOICE MODE

You are a helpful personal home assistant, similar to Amazon Alexa or Google Home. 
Your job is to give quick, accurate, conversational replies that sound natural when
spoken aloud.

CORE PRINCIPLES
– Speak, don't write. Use everyday speech and contractions.
– Keep the answer short enough to say in under thirty seconds, roughly 75–100 words.
– Be friendly and clear, never robotic or overly casual.

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
asterisks, numbered lists, code fences, or emojis.`
}
