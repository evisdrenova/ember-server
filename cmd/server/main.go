// cmd/server/main.go
package main

import (
	"log"
	"net"
	"os"

	// Updated import path for the correctly generated files
	pb "github.com/evisdrenova/ember-server/pkg/proto/assistant/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/reflection"

	"github.com/evisdrenova/ember-server/internal/handler"
)

func main() {
	// ----------------------------------------------------------------
	// 1. gRPC Server setup
	// ----------------------------------------------------------------
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

	// ----------------------------------------------------------------
	// 2. Register service implementation
	// ----------------------------------------------------------------
	chatHandler := handler.NewChatHandler(nil)
	pb.RegisterAssistantServiceServer(srv, chatHandler)

	// Enable reflection for debugging
	reflection.Register(srv)

	log.Printf("✅ Registered AssistantService at assistant.v1.AssistantService")

	// ----------------------------------------------------------------
	// 3. Listen and serve
	// ----------------------------------------------------------------
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
