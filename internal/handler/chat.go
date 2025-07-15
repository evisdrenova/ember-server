// internal/handler/chat.go
package handler

import (
	"context"
	"fmt"
	"io"
	"log"

	pb "github.com/evisdrenova/ember-server/pkg/proto/assistant/v1"
	"github.com/openai/openai-go"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type ChatHandler struct {
	pb.UnimplementedAssistantServiceServer
	rdb          *redis.Client
	openaiClient *openai.Client
}

func NewChatHandler(rdb *redis.Client, openaiClient *openai.Client) *ChatHandler {
	return &ChatHandler{
		rdb:          rdb,
		openaiClient: openaiClient,
	}
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

		fmt.Println("the incoming text", req.Message)

		log.Printf("📨 Received message: session=%s, text='%s'", req.SessionId, req.Message)

		// Store message in Redis (only if Redis client exists)
		if h.rdb != nil && req.SessionId != "" && req.Message != "" {
			key := "session:" + req.SessionId
			if err := h.rdb.LPush(stream.Context(), key, req.Message).Err(); err != nil {
				log.Printf("redis error: %v", err)
			}
		}

		chatCompletion, err := h.openaiClient.Chat.Completions.New(context.TODO(), openai.ChatCompletionNewParams{
			Messages: []openai.ChatCompletionMessageParamUnion{
				openai.UserMessage("what dog shoud i get?"),
			},
			Model: openai.ChatModelGPT4o,
		})
		if err != nil {
			panic(err.Error())
		}
		println(chatCompletion.Choices[0].Message.Content)

		// Echo response for now
		resp := &pb.ChatResponse{
			SessionId:    req.SessionId,
			TextResponse: chatCompletion.Choices[0].Message.Content,
			IsFinal:      true,
		}

		log.Printf("📤 Sending response: '%s'", resp.TextResponse)

		if err := stream.Send(resp); err != nil {
			log.Printf("stream send error: %v", err)
			return status.Errorf(codes.Internal, "send error: %v", err)
		}
	}
}
