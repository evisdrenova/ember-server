// cmd/server/main.go
package main

import (
	"log"
	"net"
	"os"

	// Updated import path for the correctly generated files
	pb "github.com/evisdrenova/ember-server/pkg/proto/assistant/v1"
	"github.com/joho/godotenv"
	"github.com/openai/openai-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/reflection"

	"github.com/evisdrenova/ember-server/internal/handler"
	"github.com/openai/openai-go/option"
)

func main() {

	if err := godotenv.Load(); err != nil {
		log.Printf("⚠️  No .env file found or error loading it: %v", err)
		log.Printf("🔄 Continuing with system environment variables...")
	} else {
		log.Printf("✅ Loaded .env file successfully")
	}

	grpcOpts := []grpc.ServerOption{
		grpc.MaxRecvMsgSize(10 << 20), // 10 MB
		grpc.MaxSendMsgSize(10 << 20),
	}

	// TLS is optional for LAN; use insecure creds if no cert present
	if certFile, keyFile := os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY"); certFile != "" && keyFile != "" {
		creds, err := credentials.NewServerTLSFromFile(certFile, keyFile)
		if err != nil {
			log.Fatalf("load TLS: %v", err)
		}
		grpcOpts = append(grpcOpts, grpc.Creds(creds))
	} else {
		grpcOpts = append(grpcOpts, grpc.Creds(insecure.NewCredentials()))
		log.Print("[WARN] running without TLS – use only on trusted LAN")
	}

	srv := grpc.NewServer(grpcOpts...)

	openaiClient := openai.NewClient(
		option.WithAPIKey(os.Getenv("OPENAI_API_KEY")),
	)

	chatHandler := handler.NewChatHandler(nil, &openaiClient)
	pb.RegisterAssistantServiceServer(srv, chatHandler)

	// Enable reflection for debugging
	reflection.Register(srv)

	log.Printf("✅ Registered AssistantService at assistant.v1.AssistantService")

	ln, err := net.Listen("tcp", ":8080")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("🚀 gRPC Server listening on %s", ln.Addr())

	if err := srv.Serve(ln); err != nil {
		log.Fatalf("serve: %v", err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
