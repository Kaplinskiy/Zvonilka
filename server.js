// server.js (ESM)
// Minimal signaling server for development purposes: HTTP create-room + WebSocket /ws endpoint.
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// TURN dynamic credentials configuration (compatible with coturn REST API style)
// Required: TURN_SECRET must match coturn's static-auth-secret for HMAC authentication.
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || 'turn.zababba.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// TTL (time-to-live in seconds) clamped to reasonable bounds (between 60 and 3600 seconds)
const _ttl = Number.parseInt(process.env.TURN_TTL || '120', 10);
const TURN_TTL = Number.isFinite(_ttl) ? Math.min(Math.max(_ttl, 60), 3600) : 120;

// Build canonical TURN URL set (TLS/TCP and UDP)
function buildTurnUrls(urls) {
  const out = new Set();
  const list = Array.isArray(urls) ? urls : (urls ? [urls] : []);
  for (let u of list) {
    if (!u) continue;
    const raw = String(u).trim();
    // If full TURN/TURNS url -> extract host and normalize to both tcp/udp variants
    if (/^turns?:\/\//i.test(raw)) {
      let host = raw.replace(/^turns?:\/{0,2}/i, '').split(/[/?#:]/)[0].split(':')[0];
      if (!host || host.toLowerCase() === 'turns') host = 'turn.zababba.com';
      out.add(`turns:${host}:5349?transport=tcp`);
      out.add(`turn:${host}:3478?transport=udp`);
      continue;
    }
    // Host-only token -> add both tcp/udp
    let host = raw
      .replace(/^https?:\/\//i, '')
      .replace(/^turns?:/i, '')
      .replace(/\/$/, '')
      .split('?')[0]
      .split(':')[0]
      .trim();
    if (!host || host.toLowerCase() === 'turns') host = 'turn.zababba.com';
    out.add(`turns:${host}:5349?transport=tcp`);
    out.add(`turn:${host}:3478?transport=udp`);
  }
  return Array.from(out);
}

// Limit for incoming WebSocket message size (default 64 KiB)
const MAX_MSG_BYTES = Number.parseInt(process.env.WS_MAX_MSG_BYTES || '65536', 10);

// Generic handler for room creation, compatible with /signal and /signal/create endpoints.
// Generates a random 6-character uppercase room ID and responds with JSON.
function createRoomHandler(_req, res) {
  const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  res.json({ roomId });
}

// Legacy and compatible routes for room creation (accept GET and POST)
app.all('/signal', createRoomHandler);
app.all('/signal/create', createRoomHandler);
app.all('/signal/rooms', createRoomHandler);
// совместимость с фронтом: /signal/create/rooms
app.all('/signal/create/rooms', createRoomHandler);

// Endpoint to issue temporary TURN credentials using HMAC-SHA1 as per coturn "REST API" specification.
// Returns iceServers configuration with credentials valid for TURN_TTL seconds.
function issueTurnCreds(req, res) {
  try {
    if (!TURN_SECRET) {
      console.error('[TURN] TURN_SECRET is not set on server (env)');
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'TURN misconfigured: TURN_SECRET missing' });
    }
    const user = (req.query.user || 'zvonilka').toString().slice(0, 32);
    const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
    const username = `${expiry}:${user}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');

    // Respect env and normalize to canonical TCP+UDP list
    const urls = buildTurnUrls(TURN_URLS);

    res.set('Cache-Control', 'no-store');
    return res.json({
      iceServers: [{ urls, username, credential, credentialType: 'password' }],
      ttl: TURN_TTL,
      expiresAt: expiry,
    });
  } catch (e) {
    console.error('[TURN] credentials failure', e && (e.message || e));
    return res.status(500).json({ error: 'turn-credentials failure' });
  }
}
app.get('/turn-credentials', issueTurnCreds);
// compatibility alias for older clients
app.get('/signal/turn-credentials', issueTurnCreds);

// readiness/liveness probe
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// In-memory room storage: maps roomId to a Set of WebSocket clients connected to that room.
const rooms = new Map();
// Track peers per role and buffer ICE when the peer is not yet available
const roomPeers = new Map(); // roomId -> { caller: WebSocket|null, callee: WebSocket|null }
const iceBuffers = new Map(); // roomId -> { toCaller: [], toCallee: [] }
// Buffer the latest offer per room until the callee connects
const offerBuffers = new Map(); // roomId -> { type:'offer', sdp, offer? }

// Add a WebSocket client to a room; create the room if it doesn't exist.
// Assigns a private _roomId property to the WebSocket for easy reference.
function addToRoom(roomId, ws) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
  ws._roomId = roomId; // internal property to track the room
}

function ensureRoomStruct(roomId) {
  if (!roomPeers.has(roomId)) roomPeers.set(roomId, { caller: null, callee: null });
  if (!iceBuffers.has(roomId)) iceBuffers.set(roomId, { toCaller: [], toCallee: [] });
}
function otherRole(role) { return role === 'caller' ? 'callee' : 'caller'; }

// Remove a WebSocket client from its room; if room becomes empty, delete it.
function removeFromRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const set = rooms.get(roomId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    rooms.delete(roomId);
    // full cleanup to avoid leaks
    roomPeers.delete(roomId);
    iceBuffers.delete(roomId);
    offerBuffers.delete(roomId);
  }
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

    ensureRoomStruct(roomId);
    if (role === 'caller' || role === 'callee') {
      roomPeers.get(roomId)[role] = ws;
      // Flush buffered ICE for this role (messages destined "toCaller" or "toCallee")
      const buf = iceBuffers.get(roomId);
      const key = role === 'caller' ? 'toCaller' : 'toCallee';
      const list = buf[key];
      if (Array.isArray(list) && list.length) {
        for (const m of list.splice(0)) {
          try { ws.send(JSON.stringify(m)); } catch {}
        }
      }
      // If a callee just connected and there is a buffered offer, deliver it now
      if (role === 'callee') {
        const buffered = offerBuffers.get(roomId);
        if (buffered) {
          console.log('[ROUTE]', roomId, 'replay buffered offer -> callee');
          try { ws.send(JSON.stringify(buffered)); } catch {}
          offerBuffers.delete(roomId);
        }
      }
    }

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
        const raw = data && data.toString ? data.toString() : '';
        if (raw && /^candidate:/.test(raw)) {
          msg = { type: 'ice', candidate: raw };
        } else {
          // Ignore invalid non-ICE JSON messages silently.
          return;
        }
      }

      if (msg?.type) {
        console.log(`[SIGNAL IN] ${roomId}`, msg.type, msg.candidate ? 'ICE' : '', msg.sdp ? 'SDP' : '');
      }

      // Normalize alias ICE message types
      if (msg && typeof msg === 'object') {
        const t = String(msg.type || '').toLowerCase();
        if (t === 'candidate' || t === 'icecandidate') {
          const cand = (msg.candidate ?? msg.payload ?? msg.data ?? null);
          msg = { type: 'ice', candidate: cand };
        }
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

      // Normalize signaling message formats before relaying
      if (msg && typeof msg === 'object') {
        if (msg.type === 'offer' && msg.payload && !msg.sdp) {
          msg = { type: 'offer', sdp: msg.payload };
        } else if (msg.type === 'answer' && msg.payload && !msg.sdp) {
          msg = { type: 'answer', sdp: msg.payload };
        } else if (msg.type === 'ice') {
          // Preserve full RTCIceCandidateInit fields when forwarding
          const pick = (v) => (v && typeof v === 'object') ? v : (v !== undefined ? { candidate: v } : null);
          let candObj = null;
          if (msg && typeof msg === 'object') {
            if (msg.payload && typeof msg.payload === 'object') {
              // payload may be {candidate, sdpMid, sdpMLineIndex}
              candObj = pick('candidate' in msg.payload ? msg.payload : msg.payload.candidate);
            } else if ('candidate' in msg) {
              candObj = pick(msg.candidate);
            } else if (msg.payload === null || msg.candidate === null || msg.data === null) {
              candObj = null; // end-of-candidates
            }
          }
          if (candObj === null) {
            msg = { type: 'ice', candidate: null };
          } else if (candObj) {
            // Ensure at least {candidate: string, sdpMid|sdpMLineIndex}
            msg = { type: 'ice', ...candObj };
          } else {
            // If still unknown shape, leave as-is
          }
        }
      }
      if (msg?.type) {
        console.log(`[SIGNAL OUT] ${roomId}`, msg.type);
      }
      const srcRole = (ws._query && ws._query.role) || 'unknown';
      const dstRole = otherRole(srcRole);
      if (msg && (msg.type === 'ice' || msg.type === 'offer' || msg.type === 'answer' || msg.type === 'renegotiate')) {
        ensureRoomStruct(roomId);
        const peer = roomPeers.get(roomId)[dstRole];
        const payload = JSON.stringify(msg);
        if (peer && peer.readyState === WebSocket.OPEN) {
          console.log('[ROUTE]', roomId, 'type=', msg.type, 'to=', dstRole, 'online');
          try { peer.send(payload); } catch {}
        } else {
          // Peer not yet connected: buffer what we safely can
          console.log('[ROUTE]', roomId, 'type=', msg.type, 'to=', dstRole, 'buffered');
          if (msg.type === 'ice' && msg.candidate) {
            const buf = iceBuffers.get(roomId);
            const key = dstRole === 'caller' ? 'toCaller' : 'toCallee';
            buf[key].push(msg);
          }
          if (msg.type === 'offer') {
            // keep only the latest offer for this room
            offerBuffers.set(roomId, msg);
          }
          // answers cannot be meaningfully buffered; if no peer, drop
        }
      } else {
        // Non-RTC control messages are broadcast
        broadcast(roomId, msg, ws);
      }
    });

    ws.on('close', () => {
      console.log(`[WS CLOSE] ${roomId}`);
      // Notify remaining clients in the room that a peer has left.
      broadcast(roomId, { type: 'bye', reason: 'peer-left' }, ws);
      removeFromRoom(ws);
      try {
        const { roomId: rid, role: r } = ws._query || {};
        if (rid && (r === 'caller' || r === 'callee') && roomPeers.has(rid)) {
          if (roomPeers.get(rid)[r] === ws) roomPeers.get(rid)[r] = null;
        }
      } catch {}
    });
    ws.on('error', () => {
      console.error(`[WS ERROR] ${roomId}`);
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
