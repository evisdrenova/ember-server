// cmd/server/main.go
// ------------------------------------------------------------------
// Orange‑Pi Voice Assistant – Gateway Server (Go)
// ------------------------------------------------------------------
// Responsibilities:
//   - Accept bidirectional gRPC stream from edge devices (Orange Pi)
//   - Maintain session history in Redis
//   - Call LLM backend and tool plugins
//   - Stream neural‑TTS audio chunks back to the client
//
// Build:
//
//	go run ./cmd/server            # dev
//	CGO_ENABLED=0 go build -o gateway ./cmd/server
//
// Env vars:
//
//	REDIS_ADDR   (default "localhost:6379")
//	OPENAI_KEY   (optional)
//	TTS_PROVIDER ("openai" | "elevenlabs" | "xtts")
//
// ------------------------------------------------------------------
package main

import (
	"log"
	"net"
	"os"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	// ----------------------------------------------------------------
	// 1. Configuration
	// ----------------------------------------------------------------
	// redisAddr := getenv("REDIS_ADDR", "localhost:6379")

	// ----------------------------------------------------------------
	// 2. External Clients (Redis, LLM/TTS soon)
	// ----------------------------------------------------------------
	// rdb := redis.NewClient(&redis.Options{
	// 	Addr:         redisAddr,
	// 	MinIdleConns: 4,
	// })
	// if _, err := rdb.Ping(context.Background()).Result(); err != nil {
	// 	log.Fatalf("redis ping: %v", err)
	// }

	// ----------------------------------------------------------------
	// 3. gRPC Server setup
	// ----------------------------------------------------------------
	grpcOpts := []grpc.ServerOption{
		grpc.MaxRecvMsgSize(10 << 20), // 10 MB
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
	// 4. Register service implementation
	// ----------------------------------------------------------------
	// pb.RegisterAssistantServiceServer(srv, handler.NewChatHandler(rdb))

	// ----------------------------------------------------------------
	// 5. Listen and serve
	// ----------------------------------------------------------------
	ln, err := net.Listen("tcp", ":8080")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("🚀 gRPC Gateway listening on %s", ln.Addr())

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
