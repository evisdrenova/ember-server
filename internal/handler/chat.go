package handler

import (
	"io"
	"log"

	"github.com/redis/go-redis/v9"
	pb "github.com/evisdrenova/ember-server/pkg/proto"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type ChatHandler struct {
	pb.UnimplementedAssistantServiceServer
	rdb *redis.Client
}

func NewChatHandler(rdb *redis.Client) *ChatHandler {
	return &ChatHandler{
		rdb: rdb,
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

		// Store message in Redis
		if req.SessionId != "" && req.Message != "" {
			key := "session:" + req.SessionId
			if err := h.rdb.LPush(stream.Context(), key, req.Message).Err(); err != nil {
				log.Printf("redis error: %v", err)
			}
		}

		// Echo response for now
		resp := &pb.ChatResponse{
			SessionId:    req.SessionId,
			TextResponse: "Echo: " + req.Message,
			IsFinal:      true,
		}

		if err := stream.Send(resp); err != nil {
			log.Printf("stream send error: %v", err)
			return status.Errorf(codes.Internal, "send error: %v", err)
		}
	}
}