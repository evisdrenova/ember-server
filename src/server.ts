// src/server.ts
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { config } from "dotenv";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Pool } from "pg";
import OpenAI from "openai";
import ChatHandler from "./handlers/chat";

// Load environment variables
config();

interface ServerCredentials {
  cert?: string;
  key?: string;
}

async function main() {
  console.log("🚀 Starting TypeScript gRPC server...");

  // Load environment variables
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY environment variable is required");
    process.exit(1);
  }

  if (!process.env.SUPABASE_DB_URL) {
    console.error("❌ SUPABASE_DB_URL environment variable is required");
    process.exit(1);
  }

  // Load the protobuf definition
  const PROTO_PATH = resolve(__dirname, "../proto/assistant.proto");
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const assistantProto = grpc.loadPackageDefinition(packageDefinition) as any;

  // Initialize OpenAI client
  const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Initialize database connection pool
  const dbPool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  // Test database connection
  try {
    const client = await dbPool.connect();
    await client.query("SELECT 1");
    client.release();
    console.log("✅ Database connection pool established");
  } catch (error) {
    console.error("❌ Failed to connect to database:", error);
    process.exit(1);
  }

  // Initialize chat handler
  const chatHandler = new ChatHandler(openaiClient, dbPool);

  // Create gRPC server
  const server = new grpc.Server({
    "grpc.max_receive_message_length": 10 * 1024 * 1024, // 10 MB
    "grpc.max_send_message_length": 10 * 1024 * 1024, // 10 MB
  });

  // Add the service
  server.addService(assistantProto.assistant.v1.AssistantService.service, {
    Chat: chatHandler.chat.bind(chatHandler),
  });

  // Setup credentials (TLS or insecure)
  let credentials: grpc.ServerCredentials;
  const { TLS_CERT, TLS_KEY } = process.env;

  if (TLS_CERT && TLS_KEY) {
    try {
      const cert = readFileSync(TLS_CERT);
      const key = readFileSync(TLS_KEY);
      credentials = grpc.ServerCredentials.createSsl(null, [
        { cert_chain: cert, private_key: key },
      ]);
      console.log("✅ TLS credentials loaded");
    } catch (error) {
      console.error("❌ Failed to load TLS credentials:", error);
      process.exit(1);
    }
  } else {
    credentials = grpc.ServerCredentials.createInsecure();
    console.warn("⚠️  Running without TLS – use only on trusted LAN");
  }

  // Start the server
  const port = process.env.PORT || "8080";
  const bindAddress = `0.0.0.0:${port}`;

  server.bindAsync(bindAddress, credentials, (error, port) => {
    if (error) {
      console.error("❌ Failed to bind server:", error);
      process.exit(1);
    }
    console.log(`🚀 gRPC Server listening on ${bindAddress}`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n🛑 Received SIGINT, shutting down gracefully...");
    server.tryShutdown(() => {
      dbPool.end();
      console.log("✅ Server shut down complete");
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
    server.tryShutdown(() => {
      dbPool.end();
      console.log("✅ Server shut down complete");
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error("❌ Server startup failed:", error);
  process.exit(1);
});
