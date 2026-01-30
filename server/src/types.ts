import type { WebSocket } from "ws";

// Forward declaration for TelnetEnvironHandler (defined in proxy.ts)
export interface TelnetEnvironHandlerInterface {
  setClientIp(ip: string): void;
  isNegotiated(): boolean;
  buildIpInfoMessage(): Buffer;
  processUpstreamData(data: Buffer): { response: Buffer | null; passThrough: Buffer };
}

/**
 * Represents a buffered message to be replayed on reconnection
 */
export interface BufferedMessage {
  data: Buffer | string;
  timestamp: number;
}

/**
 * Represents a client session with persistence support
 */
export interface Session {
  /** Unique session identifier */
  id: string;
  /** WebSocket connection to the upstream MUD server */
  upstream: WebSocket | null;
  /** WebSocket connection from the client browser */
  client: WebSocket | null;
  /** Messages buffered while client is disconnected */
  buffer: BufferedMessage[];
  /** Total size of buffered messages in bytes */
  bufferSize: number;
  /** Timestamp when client last disconnected */
  disconnectedAt: number | null;
  /** Timeout handle for session cleanup */
  cleanupTimeout: NodeJS.Timeout | null;
  /** Whether the upstream connection is established */
  upstreamConnected: boolean;
  /** Creation timestamp */
  createdAt: number;
  /** Original client IP address */
  clientIp?: string;
  /** Original client port */
  clientPort?: number;
  /** Telnet NEW-ENVIRON handler for IP forwarding */
  telnetEnvHandler?: TelnetEnvironHandlerInterface;
}

/**
 * Configuration for the proxy server
 */
export interface ProxyConfig {
  /** Port for the proxy server to listen on */
  port: number;
  /** URL of the upstream MUD server */
  upstreamUrl: string;
  /** How long to keep sessions alive after client disconnect (ms) */
  persistenceTimeout: number;
  /** Maximum number of messages to buffer per session */
  maxBufferMessages: number;
  /** Maximum total size of buffered messages per session (bytes) */
  maxBufferSize: number;
}

/**
 * Message sent from proxy to client for session management
 */
export interface ProxyMessage {
  type: "session" | "error" | "reconnected";
  sessionId?: string;
  bufferedCount?: number;
  error?: string;
}

/**
 * Statistics about current proxy state
 */
export interface ProxyStats {
  activeSessions: number;
  persistedSessions: number;
  totalConnections: number;
}
