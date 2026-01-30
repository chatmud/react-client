import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import type {
  Session,
  ProxyConfig,
  BufferedMessage,
  ProxyMessage,
} from "./types.js";

// Telnet protocol constants
const enum Telnet {
  IAC = 255,   // Interpret As Command
  DONT = 254,
  DO = 253,
  WONT = 252,
  WILL = 251,
  SB = 250,    // Subnegotiation Begin
  SE = 240,    // Subnegotiation End
  NEW_ENVIRON = 39,  // RFC 1572
}

// NEW-ENVIRON subnegotiation commands (RFC 1572)
const enum NewEnviron {
  IS = 0,      // Response to SEND
  SEND = 1,    // Request variables
  INFO = 2,    // Unsolicited update
  VAR = 0,     // Well-known variable
  VALUE = 1,   // Variable value follows
  ESC = 2,     // Escape character
  USERVAR = 3, // User-defined variable
}

/**
 * Generate a random session ID
 */
function generateSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Escape special bytes in NEW-ENVIRON data per RFC 1572
 * - IAC (255) -> IAC IAC
 * - VAR (0) -> ESC VAR
 * - VALUE (1) -> ESC VALUE
 * - ESC (2) -> ESC ESC
 * - USERVAR (3) -> ESC USERVAR
 */
function escapeEnvironData(data: Buffer): Buffer {
  const escaped: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const byte = data[i];

    if (byte === 255) {  // IAC
      escaped.push(255, 255);
    } else if (byte === NewEnviron.VAR) {
      escaped.push(NewEnviron.ESC, NewEnviron.VAR);
    } else if (byte === NewEnviron.VALUE) {
      escaped.push(NewEnviron.ESC, NewEnviron.VALUE);
    } else if (byte === NewEnviron.ESC) {
      escaped.push(NewEnviron.ESC, NewEnviron.ESC);
    } else if (byte === NewEnviron.USERVAR) {
      escaped.push(NewEnviron.ESC, NewEnviron.USERVAR);
    } else {
      escaped.push(byte);
    }
  }

  return Buffer.from(escaped);
}

/**
 * Build a telnet NEW-ENVIRON IS response for IPADDRESS
 * Format: IAC SB NEW-ENVIRON IS VAR "IPADDRESS" VALUE "<ip>" IAC SE
 * Data is escaped per RFC 1572
 */
function buildNewEnvironResponse(varName: string, value: string): Buffer {
  const varNameBytes = escapeEnvironData(Buffer.from(varName, "ascii"));
  const valueBytes = escapeEnvironData(Buffer.from(value, "ascii"));

  // IAC SB NEW-ENVIRON IS VAR <name> VALUE <value> IAC SE
  const buffer = Buffer.alloc(6 + varNameBytes.length + 1 + valueBytes.length + 2);
  let offset = 0;

  buffer[offset++] = Telnet.IAC;
  buffer[offset++] = Telnet.SB;
  buffer[offset++] = Telnet.NEW_ENVIRON;
  buffer[offset++] = NewEnviron.IS;
  buffer[offset++] = NewEnviron.VAR;
  varNameBytes.copy(buffer, offset);
  offset += varNameBytes.length;
  buffer[offset++] = NewEnviron.VALUE;
  valueBytes.copy(buffer, offset);
  offset += valueBytes.length;
  buffer[offset++] = Telnet.IAC;
  buffer[offset++] = Telnet.SE;

  return buffer;
}

/**
 * Build a telnet NEW-ENVIRON INFO (unsolicited update)
 * Format: IAC SB NEW-ENVIRON INFO VAR "IPADDRESS" VALUE "<ip>" IAC SE
 * Data is escaped per RFC 1572
 */
function buildNewEnvironInfo(varName: string, value: string): Buffer {
  const varNameBytes = escapeEnvironData(Buffer.from(varName, "ascii"));
  const valueBytes = escapeEnvironData(Buffer.from(value, "ascii"));

  const buffer = Buffer.alloc(6 + varNameBytes.length + 1 + valueBytes.length + 2);
  let offset = 0;

  buffer[offset++] = Telnet.IAC;
  buffer[offset++] = Telnet.SB;
  buffer[offset++] = Telnet.NEW_ENVIRON;
  buffer[offset++] = NewEnviron.INFO;
  buffer[offset++] = NewEnviron.VAR;
  varNameBytes.copy(buffer, offset);
  offset += varNameBytes.length;
  buffer[offset++] = NewEnviron.VALUE;
  valueBytes.copy(buffer, offset);
  offset += valueBytes.length;
  buffer[offset++] = Telnet.IAC;
  buffer[offset++] = Telnet.SE;

  return buffer;
}

/**
 * Build IAC WILL NEW-ENVIRON
 */
function buildWillNewEnviron(): Buffer {
  return Buffer.from([Telnet.IAC, Telnet.WILL, Telnet.NEW_ENVIRON]);
}

/**
 * Handles telnet NEW-ENVIRON negotiation for passing client IP to upstream
 */
class TelnetEnvironHandler {
  private clientIp: string;
  private newEnvironNegotiated: boolean = false;
  private parseBuffer: Buffer = Buffer.alloc(0);

  constructor(clientIp: string) {
    this.clientIp = clientIp;
  }

  /**
   * Update the client IP (e.g., on reconnection)
   */
  setClientIp(ip: string): void {
    this.clientIp = ip;
  }

  /**
   * Check if NEW-ENVIRON has been negotiated
   */
  isNegotiated(): boolean {
    return this.newEnvironNegotiated;
  }

  /**
   * Build an INFO message to send updated IP (for reconnection)
   */
  buildIpInfoMessage(): Buffer {
    return buildNewEnvironInfo("IPADDRESS", this.clientIp);
  }

  /**
   * Process data from upstream, intercept NEW-ENVIRON negotiation
   * Returns: { response: Buffer | null, passThrough: Buffer }
   * - response: telnet response to send back to upstream
   * - passThrough: data to forward to client
   */
  processUpstreamData(data: Buffer): { response: Buffer | null; passThrough: Buffer } {
    // Accumulate data for parsing
    this.parseBuffer = Buffer.concat([this.parseBuffer, data]);

    const responses: Buffer[] = [];
    const passThrough: Buffer[] = [];
    let i = 0;

    while (i < this.parseBuffer.length) {
      // Look for IAC
      if (this.parseBuffer[i] === Telnet.IAC) {
        // Need at least 2 bytes for a command
        if (i + 1 >= this.parseBuffer.length) {
          break; // Wait for more data
        }

        const cmd = this.parseBuffer[i + 1];

        // Handle IAC IAC (escaped 255)
        if (cmd === Telnet.IAC) {
          passThrough.push(Buffer.from([Telnet.IAC, Telnet.IAC]));
          i += 2;
          continue;
        }

        // Handle IAC DO/DONT/WILL/WONT (3-byte sequences)
        if (cmd === Telnet.DO || cmd === Telnet.DONT || cmd === Telnet.WILL || cmd === Telnet.WONT) {
          if (i + 2 >= this.parseBuffer.length) {
            break; // Wait for more data
          }

          const opt = this.parseBuffer[i + 2];

          // Intercept DO NEW-ENVIRON
          if (cmd === Telnet.DO && opt === Telnet.NEW_ENVIRON) {
            console.log("[TelnetEnv] Received DO NEW-ENVIRON, responding with WILL");
            responses.push(buildWillNewEnviron());
            this.newEnvironNegotiated = true;
            i += 3;
            continue;
          }

          // Pass through other negotiation to client
          passThrough.push(this.parseBuffer.slice(i, i + 3));
          i += 3;
          continue;
        }

        // Handle IAC SB ... IAC SE (subnegotiation)
        if (cmd === Telnet.SB) {
          if (i + 2 >= this.parseBuffer.length) {
            break; // Wait for more data
          }

          const opt = this.parseBuffer[i + 2];

          // Find IAC SE to get full subnegotiation
          const seIndex = this.findSubnegotiationEnd(i + 3);
          if (seIndex === -1) {
            break; // Wait for more data
          }

          // Intercept NEW-ENVIRON subnegotiation
          if (opt === Telnet.NEW_ENVIRON) {
            const subData = this.parseBuffer.slice(i + 3, seIndex);
            const subResponse = this.handleSubnegotiation(subData);
            if (subResponse) {
              responses.push(subResponse);
            }
            i = seIndex + 2; // Skip past IAC SE
            continue;
          }

          // Pass through other subnegotiations to client
          passThrough.push(this.parseBuffer.slice(i, seIndex + 2));
          i = seIndex + 2;
          continue;
        }

        // Other 2-byte IAC commands (NOP, etc.) - pass through
        passThrough.push(this.parseBuffer.slice(i, i + 2));
        i += 2;
        continue;
      }

      // Not an IAC - find next IAC or end of buffer
      let nextIac = i + 1;
      while (nextIac < this.parseBuffer.length && this.parseBuffer[nextIac] !== Telnet.IAC) {
        nextIac++;
      }

      // Pass through data up to next IAC
      passThrough.push(this.parseBuffer.slice(i, nextIac));
      i = nextIac;
    }

    // Keep unprocessed data in buffer
    this.parseBuffer = this.parseBuffer.slice(i);

    return {
      response: responses.length > 0 ? Buffer.concat(responses) : null,
      passThrough: passThrough.length > 0 ? Buffer.concat(passThrough) : Buffer.alloc(0),
    };
  }

  /**
   * Find IAC SE in buffer starting from offset
   */
  private findSubnegotiationEnd(start: number): number {
    for (let i = start; i < this.parseBuffer.length - 1; i++) {
      if (this.parseBuffer[i] === Telnet.IAC && this.parseBuffer[i + 1] === Telnet.SE) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Handle NEW-ENVIRON subnegotiation
   */
  private handleSubnegotiation(data: Buffer): Buffer | null {
    if (data.length === 0) return null;

    const subCmd = data[0];

    // Handle SEND command
    if (subCmd === NewEnviron.SEND) {
      console.log("[TelnetEnv] Received NEW-ENVIRON SEND");
      return this.handleSendRequest(data.slice(1));
    }

    return null;
  }

  /**
   * Handle NEW-ENVIRON SEND request
   * Format: SEND [VAR <name>]* [USERVAR <name>]*
   * Handles ESC sequences per RFC 1572
   */
  private handleSendRequest(data: Buffer): Buffer | null {
    // Parse requested variables
    const requestedVars: string[] = [];
    let i = 0;

    while (i < data.length) {
      const type = data[i];
      if (type === NewEnviron.VAR || type === NewEnviron.USERVAR) {
        i++;
        const nameBytes: number[] = [];

        // Read variable name until next VAR/USERVAR/end, handling ESC
        while (i < data.length) {
          if (data[i] === NewEnviron.ESC && i + 1 < data.length) {
            // ESC escapes the next byte - take it literally
            i++;
            nameBytes.push(data[i]);
            i++;
          } else if (data[i] === NewEnviron.VAR || data[i] === NewEnviron.USERVAR) {
            // End of this variable name
            break;
          } else {
            nameBytes.push(data[i]);
            i++;
          }
        }

        const varName = Buffer.from(nameBytes).toString("ascii");
        if (varName.length > 0) {
          requestedVars.push(varName);
        }
      } else {
        i++;
      }
    }

    console.log("[TelnetEnv] Server requested variables:", requestedVars);

    // If IPADDRESS is requested, or no specific variables requested (send all), respond with it
    if (requestedVars.includes("IPADDRESS") || requestedVars.length === 0) {
      console.log(`[TelnetEnv] Responding with IPADDRESS=${this.clientIp}`);
      return buildNewEnvironResponse("IPADDRESS", this.clientIp);
    }

    return null;
  }
}

/**
 * WebSocket proxy with connection persistence
 */
export class MudProxy {
  private wss: WebSocketServer;
  private sessions: Map<string, Session> = new Map();
  private config: ProxyConfig;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(server: Server, config: ProxyConfig) {
    this.config = config;
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Start ping interval to keep connections alive
    this.startPingInterval();

    console.log(`[Proxy] WebSocket proxy initialized on /ws`);
    console.log(`[Proxy] Upstream: ${config.upstreamUrl}`);
    console.log(
      `[Proxy] Persistence timeout: ${config.persistenceTimeout / 1000}s`
    );
  }

  /**
   * Start periodic ping to keep WebSocket connections alive
   */
  private startPingInterval(): void {
    // Ping every 30 seconds
    this.pingInterval = setInterval(() => {
      for (const session of this.sessions.values()) {
        // Ping client if connected
        if (session.client && session.client.readyState === WebSocket.OPEN) {
          session.client.ping();
        }
        // Ping upstream if connected
        if (session.upstream && session.upstream.readyState === WebSocket.OPEN) {
          session.upstream.ping();
        }
      }
    }, 30000);
  }

  /**
   * Extract real client IP from request, checking X-Forwarded-For header
   */
  private getClientInfo(req: IncomingMessage): { ip: string; port: number } {
    // Check X-Forwarded-For header first (for clients behind load balancer)
    const forwardedFor = req.headers["x-forwarded-for"];
    let clientIp: string;

    if (forwardedFor) {
      // X-Forwarded-For can be comma-separated list, take first (original client)
      const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      clientIp = forwarded.split(",")[0].trim();
    } else {
      // Fall back to socket remote address
      clientIp = req.socket.remoteAddress || "127.0.0.1";
    }

    // Handle IPv6-mapped IPv4 addresses (::ffff:192.168.1.1)
    if (clientIp.startsWith("::ffff:")) {
      clientIp = clientIp.substring(7);
    }

    // Get port from X-Forwarded-Port or socket
    const forwardedPort = req.headers["x-forwarded-port"];
    const clientPort = forwardedPort
      ? parseInt(Array.isArray(forwardedPort) ? forwardedPort[0] : forwardedPort, 10)
      : req.socket.remotePort || 0;

    return { ip: clientIp, port: clientPort };
  }

  /**
   * Handle new WebSocket connection from client
   */
  private handleConnection(clientWs: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");
    const clientInfo = this.getClientInfo(req);

    console.log(
      `[Proxy] New connection from ${clientInfo.ip}:${clientInfo.port}${sessionId ? ` with sessionId: ${sessionId}` : ""}`
    );

    if (sessionId && this.sessions.has(sessionId)) {
      this.handleReconnection(clientWs, sessionId, clientInfo.ip);
    } else {
      this.createNewSession(clientWs, clientInfo.ip, clientInfo.port);
    }
  }

  /**
   * Create a new session for a client
   */
  private createNewSession(clientWs: WebSocket, clientIp: string, clientPort: number): void {
    const sessionId = generateSessionId();

    const session: Session = {
      id: sessionId,
      upstream: null,
      client: clientWs,
      buffer: [],
      bufferSize: 0,
      disconnectedAt: null,
      cleanupTimeout: null,
      upstreamConnected: false,
      createdAt: Date.now(),
      clientIp,
      clientPort,
    };

    this.sessions.set(sessionId, session);

    // Send session ID to client
    this.sendProxyMessage(clientWs, {
      type: "session",
      sessionId,
    });

    // Connect to upstream - client IP will be sent via NEW-ENVIRON
    this.connectUpstream(session, clientIp);

    // Set up client event handlers
    this.setupClientHandlers(session, clientWs);

    console.log(`[Proxy] Created new session: ${sessionId}`);
  }

  /**
   * Handle client reconnection to existing session
   */
  private handleReconnection(clientWs: WebSocket, sessionId: string, newClientIp: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendProxyMessage(clientWs, {
        type: "error",
        error: "Session not found",
      });
      clientWs.close();
      return;
    }

    // Cancel cleanup timeout
    if (session.cleanupTimeout) {
      clearTimeout(session.cleanupTimeout);
      session.cleanupTimeout = null;
    }

    // Check if client IP changed
    const ipChanged = session.clientIp !== newClientIp;
    if (ipChanged) {
      console.log(`[Proxy] Client IP changed from ${session.clientIp} to ${newClientIp}`);
      session.clientIp = newClientIp;

      // Update telnet handler and send INFO to upstream if negotiated
      if (session.telnetEnvHandler) {
        session.telnetEnvHandler.setClientIp(newClientIp);

        if (session.telnetEnvHandler.isNegotiated() &&
            session.upstream &&
            session.upstream.readyState === WebSocket.OPEN) {
          // Send NEW-ENVIRON INFO with updated IP
          const infoMsg = session.telnetEnvHandler.buildIpInfoMessage();
          console.log(`[Proxy] Sending NEW-ENVIRON INFO with updated IP: ${newClientIp}`);
          session.upstream.send(infoMsg);
        }
      }
    }

    // Update session with new client
    session.client = clientWs;
    session.disconnectedAt = null;

    console.log(
      `[Proxy] Client reconnected to session: ${sessionId}, buffered messages: ${session.buffer.length}`
    );

    // Send reconnection confirmation with buffer info
    this.sendProxyMessage(clientWs, {
      type: "reconnected",
      sessionId,
      bufferedCount: session.buffer.length,
    });

    // Replay buffered messages
    for (const msg of session.buffer) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg.data);
      }
    }

    // Clear buffer after replay
    session.buffer = [];
    session.bufferSize = 0;

    // Set up client event handlers
    this.setupClientHandlers(session, clientWs);
  }

  /**
   * Connect to upstream MUD server
   */
  private connectUpstream(session: Session, clientIp: string): void {
    console.log(`[Proxy] Connecting to upstream: ${this.config.upstreamUrl}`);

    const upstream = new WebSocket(this.config.upstreamUrl);

    // Create telnet handler for NEW-ENVIRON negotiation
    session.telnetEnvHandler = new TelnetEnvironHandler(clientIp);

    session.upstream = upstream;

    upstream.on("open", () => {
      console.log(`[Proxy] Upstream connected for session: ${session.id}`);
      session.upstreamConnected = true;
      // Client IP will be sent via NEW-ENVIRON when server requests it
    });

    upstream.on("message", (data: Buffer | string) => {
      this.handleUpstreamMessage(session, data);
    });

    upstream.on("close", (code, reason) => {
      console.log(
        `[Proxy] Upstream closed for session ${session.id}: ${code} ${reason}`
      );
      session.upstreamConnected = false;

      // Notify client if connected
      if (session.client && session.client.readyState === WebSocket.OPEN) {
        session.client.close(1000, "Upstream connection closed");
      }

      // Clean up session
      this.cleanupSession(session.id);
    });

    upstream.on("error", (error) => {
      console.error(`[Proxy] Upstream error for session ${session.id}:`, error);
    });
  }

  /**
   * Handle message from upstream MUD server
   */
  private handleUpstreamMessage(
    session: Session,
    data: Buffer | string
  ): void {
    // Convert to Buffer if string
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    // Process through telnet handler to intercept NEW-ENVIRON negotiation
    let dataToForward: Buffer = buffer;

    if (session.telnetEnvHandler) {
      const result = session.telnetEnvHandler.processUpstreamData(buffer);

      // Send any telnet responses back to upstream
      if (result.response && session.upstream && session.upstream.readyState === WebSocket.OPEN) {
        session.upstream.send(result.response);
      }

      // Use filtered data for forwarding to client
      dataToForward = result.passThrough;
    }

    // Only forward if there's data to forward
    if (dataToForward.length === 0) {
      return;
    }

    if (session.client && session.client.readyState === WebSocket.OPEN) {
      // Client connected - forward directly
      session.client.send(dataToForward);
    } else if (session.disconnectedAt !== null) {
      // Client disconnected - buffer the message
      this.bufferMessage(session, dataToForward);
    }
  }

  /**
   * Buffer a message for later replay
   */
  private bufferMessage(session: Session, data: Buffer | string): void {
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);

    // Check if we'd exceed limits
    if (session.buffer.length >= this.config.maxBufferMessages) {
      // Remove oldest message
      const removed = session.buffer.shift();
      if (removed) {
        const removedSize = Buffer.isBuffer(removed.data)
          ? removed.data.length
          : Buffer.byteLength(removed.data);
        session.bufferSize -= removedSize;
      }
    }

    // If single message exceeds max buffer size, skip it
    if (size > this.config.maxBufferSize) {
      console.warn(
        `[Proxy] Message too large to buffer (${size} bytes), skipping`
      );
      return;
    }

    // Remove old messages if we'd exceed size limit
    while (
      session.bufferSize + size > this.config.maxBufferSize &&
      session.buffer.length > 0
    ) {
      const removed = session.buffer.shift();
      if (removed) {
        const removedSize = Buffer.isBuffer(removed.data)
          ? removed.data.length
          : Buffer.byteLength(removed.data);
        session.bufferSize -= removedSize;
      }
    }

    const message: BufferedMessage = {
      data,
      timestamp: Date.now(),
    };

    session.buffer.push(message);
    session.bufferSize += size;
  }

  /**
   * Set up event handlers for client WebSocket
   */
  private setupClientHandlers(session: Session, clientWs: WebSocket): void {
    clientWs.on("message", (data: Buffer | string) => {
      // Forward to upstream if connected
      if (session.upstream && session.upstream.readyState === WebSocket.OPEN) {
        session.upstream.send(data);
      }
    });

    clientWs.on("close", (code, reason) => {
      console.log(
        `[Proxy] Client disconnected from session ${session.id}: ${code}`
      );
      this.handleClientDisconnect(session);
    });

    clientWs.on("error", (error) => {
      console.error(`[Proxy] Client error for session ${session.id}:`, error);
    });
  }

  /**
   * Handle client disconnect - start persistence timer
   */
  private handleClientDisconnect(session: Session): void {
    session.client = null;
    session.disconnectedAt = Date.now();

    // Check if upstream is still alive
    if (!session.upstream || session.upstream.readyState !== WebSocket.OPEN) {
      // Upstream already dead, clean up immediately
      this.cleanupSession(session.id);
      return;
    }

    console.log(
      `[Proxy] Starting persistence timer for session ${session.id} (${this.config.persistenceTimeout / 1000}s)`
    );

    // Start cleanup timeout
    session.cleanupTimeout = setTimeout(() => {
      console.log(`[Proxy] Persistence timeout reached for session ${session.id}`);
      this.cleanupSession(session.id);
    }, this.config.persistenceTimeout);
  }

  /**
   * Clean up a session completely
   */
  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`[Proxy] Cleaning up session: ${sessionId}`);

    // Clear timeout if any
    if (session.cleanupTimeout) {
      clearTimeout(session.cleanupTimeout);
    }

    // Close upstream connection
    if (session.upstream) {
      try {
        session.upstream.close();
      } catch {
        // Ignore errors on close
      }
    }

    // Close client connection if still open
    if (session.client && session.client.readyState === WebSocket.OPEN) {
      try {
        session.client.close(1000, "Session ended");
      } catch {
        // Ignore errors on close
      }
    }

    // Remove from map
    this.sessions.delete(sessionId);
  }

  /**
   * Send a proxy control message to client
   */
  private sendProxyMessage(ws: WebSocket, message: ProxyMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      // Send as a special binary message with a marker prefix
      const payload = JSON.stringify(message);
      // Use a prefix byte 0x00 to distinguish proxy messages from MUD data
      const buffer = Buffer.alloc(1 + payload.length);
      buffer[0] = 0x00; // Proxy message marker
      buffer.write(payload, 1);
      ws.send(buffer);
    }
  }

  /**
   * Get current proxy statistics
   */
  public getStats(): { active: number; persisted: number } {
    let active = 0;
    let persisted = 0;

    for (const session of this.sessions.values()) {
      if (session.client && session.client.readyState === WebSocket.OPEN) {
        active++;
      } else if (session.disconnectedAt !== null) {
        persisted++;
      }
    }

    return { active, persisted };
  }

  /**
   * Shut down the proxy gracefully
   */
  public shutdown(): void {
    console.log("[Proxy] Shutting down...");

    // Stop ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Clean up all sessions
    for (const sessionId of this.sessions.keys()) {
      this.cleanupSession(sessionId);
    }

    // Close WebSocket server
    this.wss.close();
  }
}
