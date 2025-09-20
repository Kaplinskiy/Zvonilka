// server.js (ESM)
// Minimal signaling server for development purposes: HTTP create-room + WebSocket /ws endpoint.
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'url';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

// TURN dynamic credentials configuration (compatible with coturn REST API style)
// Required: TURN_SECRET must match coturn's static-auth-secret for HMAC authentication.
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || 'turns:turn.zababba.com:443?transport=tcp')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// TTL (time-to-live in seconds) clamped to reasonable bounds (between 60 and 3600 seconds)
const _ttl = Number.parseInt(process.env.TURN_TTL || '120', 10);
const TURN_TTL = Number.isFinite(_ttl) ? Math.min(Math.max(_ttl, 60), 3600) : 120;

// Limit for incoming WebSocket message size (default 64 KiB)
const MAX_MSG_BYTES = Number.parseInt(process.env.WS_MAX_MSG_BYTES || '65536', 10);

// Generic handler for room creation, compatible with /signal and /signal/create endpoints.
// Generates a random 6-character uppercase room ID and responds with JSON.
function createRoomHandler(_req, res) {
  const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  res.json({ roomId });
}

// Legacy and compatible routes for room creation.
app.post('/signal', createRoomHandler);
app.post('/signal/create', createRoomHandler);
app.post('/signal/rooms', createRoomHandler);

// Endpoint to issue temporary TURN credentials using HMAC-SHA1 as per coturn "REST API" specification.
// Returns iceServers configuration with credentials valid for TURN_TTL seconds.
app.get('/turn-credentials', (req, res) => {
  try {
    if (!TURN_SECRET) {
      return res.status(500).json({ error: 'TURN_SECRET is not set on server' });
    }
    // User identifier limited to 32 characters; default is 'zvonilka'.
    const user = (req.query.user || 'zvonilka').toString().slice(0, 32);
    const expiry = Math.floor(Date.now() / 1000) + TURN_TTL; // UNIX timestamp in seconds
    const username = `${expiry}:${user}`;
    // Generate HMAC-SHA1 credential based on username and TURN_SECRET
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');

    // Prevent caching of credentials by clients
    res.set('Cache-Control', 'no-store');
    return res.json({
      iceServers: [{ urls: TURN_URLS, username, credential }],
      ttl: TURN_TTL
    });
  } catch {
    return res.status(500).json({ error: 'turn-credentials failure' });
  }
});

const server = http.createServer(app);

// In-memory room storage: maps roomId to a Set of WebSocket clients connected to that room.
const rooms = new Map();

// Add a WebSocket client to a room; create the room if it doesn't exist.
// Assigns a private _roomId property to the WebSocket for easy reference.
function addToRoom(roomId, ws) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
  ws._roomId = roomId; // internal property to track the room
}

// Remove a WebSocket client from its room; if room becomes empty, delete it.
function removeFromRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const set = rooms.get(roomId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(roomId);
}

// Broadcast a JSON message to all clients in a room except optionally one WebSocket client.
// Serializes the message to JSON string before sending.
function broadcast(roomId, msg, exceptWs) {
  const set = rooms.get(roomId);
  if (!set) return;
  const payload = JSON.stringify(msg);
  for (const client of set) {
    if (client !== exceptWs && client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {
        // Ignore send errors to avoid crashing the server
      }
    }
  }
}

const wss = new WebSocketServer({ noServer: true });

// Handle HTTP upgrade requests for WebSocket connections on the /ws path.
// Parses query parameters from the URL and attaches them to the WebSocket instance.
server.on('upgrade', (request, socket, head) => {
  const { pathname, query } = parseUrl(request.url, true);
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws._query = query || {};
    wss.emit('connection', ws, request);
  });
});

// WebSocket connection handler: manages signaling messages within a room.
wss.on('connection', (ws) => {
  try {
    const { roomId, role } = ws._query || {};
    if (!roomId || typeof roomId !== 'string') {
      // Close connection if roomId is not provided or invalid.
      ws.close(1008, 'roomId required');
      return;
    }
    addToRoom(roomId, ws);

    // Send a welcome message with a unique memberId to the connecting client.
    ws.send(JSON.stringify({ type: 'hello', memberId: Math.random().toString(36).slice(2) }));
    // Notify other members in the room that a new member has joined, including their role if provided.
    broadcast(roomId, { type: 'member.joined', role: role || 'unknown' }, ws);

    ws.on('message', (data, isBinary) => {
      // Reject binary messages as unsupported.
      if (isBinary) {
        try { ws.close(1003, 'binary not supported'); } catch {}
        return;
      }
      // Reject messages exceeding the configured maximum size.
      if (typeof data === 'string' && Buffer.byteLength(data, 'utf8') > MAX_MSG_BYTES) {
        try { ws.close(1009, 'message too big'); } catch {}
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        // Ignore invalid JSON messages silently.
        return;
      }

      // Handle ping messages by responding with a ping to keep the connection alive.
      if (msg?.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        return;
      }
      // Handle voluntary disconnect messages; broadcast 'bye' and close the connection.
      if (msg?.type === 'bye') {
        broadcast(roomId, { type: 'bye', reason: 'user-hangup' }, ws);
        try { ws.close(1000, 'user-hangup'); } catch {}
        return;
      }

      // Relay all other messages transparently to other clients in the same room.
      broadcast(roomId, msg, ws);
    });

    ws.on('close', () => {
      // Notify remaining clients in the room that a peer has left.
      broadcast(roomId, { type: 'bye', reason: 'peer-left' }, ws);
      removeFromRoom(ws);
    });
    ws.on('error', () => {
      // Suppress errors; can be enhanced with debug logging if needed.
    });
  } catch {
    // Attempt to close the connection gracefully on unexpected errors.
    try { ws.close(); } catch {}
  }
});

// Local server startup; in test environments, the server does not listen on a port.
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`Signal server listening on http://localhost:${PORT}`);
  });
}

// Export Express app and HTTP server instances for testing purposes.
export { app, server };
export default app;