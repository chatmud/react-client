import express from "express";
import { createServer } from "http";
import path from "path";
import { MudProxy } from "./proxy.js";
import type { ProxyConfig } from "./types.js";

// Configuration from environment variables with defaults
const config: ProxyConfig = {
  port: parseInt(process.env.PORT || "3001", 10),
  upstreamUrl: process.env.UPSTREAM_URL || "wss://chatmud.com:9876",
  persistenceTimeout: parseInt(
    process.env.PERSISTENCE_TIMEOUT_MS || "300000",
    10
  ),
  maxBufferMessages: parseInt(process.env.MAX_BUFFER_MESSAGES || "100", 10),
  maxBufferSize: parseInt(process.env.MAX_BUFFER_SIZE || "10240", 10), // 10KB
};

// Create Express app
const app = express();

// Serve static files from the public directory (React client build)
const publicPath = path.join(process.cwd(), "public");
app.use(express.static(publicPath));

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Stats endpoint
let proxy: MudProxy | null = null;
app.get("/stats", (_req, res) => {
  if (proxy) {
    const stats = proxy.getStats();
    res.json({
      activeSessions: stats.active,
      persistedSessions: stats.persisted,
      config: {
        upstreamUrl: config.upstreamUrl,
        persistenceTimeout: config.persistenceTimeout,
        maxBufferMessages: config.maxBufferMessages,
        maxBufferSize: config.maxBufferSize,
      },
    });
  } else {
    res.status(503).json({ error: "Proxy not initialized" });
  }
});

// Catch-all route to serve React app for client-side routing
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// Create HTTP server
const server = createServer(app);

// Initialize WebSocket proxy
proxy = new MudProxy(server, config);

// Start server
server.listen(config.port, () => {
  console.log(`[Server] ChatMUD Proxy Server running on port ${config.port}`);
  console.log(`[Server] Static files served from: ${publicPath}`);
  console.log(`[Server] WebSocket proxy available at: ws://localhost:${config.port}/ws`);
  console.log(`[Server] Health check: http://localhost:${config.port}/health`);
  console.log(`[Server] Stats: http://localhost:${config.port}/stats`);
});

// Graceful shutdown
const shutdown = () => {
  console.log("\n[Server] Received shutdown signal, closing gracefully...");

  if (proxy) {
    proxy.shutdown();
  }

  server.close(() => {
    console.log("[Server] HTTP server closed");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("[Server] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
