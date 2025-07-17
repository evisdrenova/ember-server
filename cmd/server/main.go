// // cmd/server/main.go
// package main

// import (
// 	"context"
// 	"fmt"
// 	"log"
// 	"net"
// 	"os"

// 	// Updated import path for the correctly generated files
// 	pb "github.com/evisdrenova/ember-server/pkg/proto/assistant/v1"
// 	"github.com/jackc/pgx/v5"
// 	"github.com/joho/godotenv"
// 	"github.com/openai/openai-go"
// 	"google.golang.org/grpc"
// 	"google.golang.org/grpc/credentials"
// 	"google.golang.org/grpc/credentials/insecure"
// 	"google.golang.org/grpc/reflection"

// 	"github.com/evisdrenova/ember-server/internal/handler"
// 	"github.com/openai/openai-go/option"
// )

// func main() {

// 	if err := godotenv.Load(); err != nil {
// 		log.Printf("No .env file found or error loading it: %v", err)
// 	} else {
// 		log.Printf("✅ Loaded .env file successfully")
// 	}

// 	grpcOpts := []grpc.ServerOption{
// 		grpc.MaxRecvMsgSize(10 << 20), // 10 MB
// 		grpc.MaxSendMsgSize(10 << 20),
// 	}

// 	// TLS is optional for LAN; use insecure creds if no cert present
// 	if certFile, keyFile := os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY"); certFile != "" && keyFile != "" {
// 		creds, err := credentials.NewServerTLSFromFile(certFile, keyFile)
// 		if err != nil {
// 			log.Fatalf("load TLS: %v", err)
// 		}
// 		grpcOpts = append(grpcOpts, grpc.Creds(creds))
// 	} else {
// 		grpcOpts = append(grpcOpts, grpc.Creds(insecure.NewCredentials()))
// 		log.Print("[WARN] running without TLS – use only on trusted LAN")
// 	}

// 	srv := grpc.NewServer(grpcOpts...)

// 	openaiClient := openai.NewClient(
// 		option.WithAPIKey(os.Getenv("OPENAI_API_KEY")),
// 	)

// 	url := os.Getenv("SUPABASE_DB_URL")
// 	conn, err := pgx.Connect(context.Background(), url)
// 	if err != nil {
// 		fmt.Fprintf(os.Stderr, "Unable to connect to database: %v\n", err)
// 		os.Exit(1)
// 	}
// 	defer conn.Close(context.Background())

// 	ctx := context.Background()

// 	chatHandler := handler.NewChatHandler(ctx, &openaiClient, conn)
// 	pb.RegisterAssistantServiceServer(srv, chatHandler)

// 	reflection.Register(srv)

// 	ln, err := net.Listen("tcp", ":8080")
// 	if err != nil {
// 		log.Fatalf("listen: %v", err)
// 	}
// 	log.Printf("🚀 gRPC Server listening on %s", ln.Addr())

// 	if err := srv.Serve(ln); err != nil {
// 		log.Fatalf("serve: %v", err)
// 	}
// }

// cmd/server/main.go
package main

import (
	"context"
	"log"
	"net"
	"os"

	// Updated import path for the correctly generated files
	pb "github.com/evisdrenova/ember-server/pkg/proto/assistant/v1"
	"github.com/jackc/pgx/v5/pgxpool"
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
		log.Printf("No .env file found or error loading it: %v", err)
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

	// Create connection pool instead of single connection
	dbURL := os.Getenv("SUPABASE_DB_URL")
	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		log.Fatalf("Unable to create connection pool: %v", err)
	}
	defer pool.Close()

	// Test the connection
	if err := pool.Ping(context.Background()); err != nil {
		log.Fatalf("Unable to ping database: %v", err)
	}
	log.Printf("✅ Database connection pool established")

	ctx := context.Background()

	chatHandler := handler.NewChatHandler(ctx, &openaiClient, pool)
	pb.RegisterAssistantServiceServer(srv, chatHandler)

	reflection.Register(srv)

	ln, err := net.Listen("tcp", ":8080")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("🚀 gRPC Server listening on %s", ln.Addr())

	if err := srv.Serve(ln); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
