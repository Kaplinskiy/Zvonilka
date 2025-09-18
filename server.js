// server.js (ESM)
// Минимальный signaling-сервер для DEV: HTTP create-room + WS /ws.
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { parse as parseUrl } from 'url';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

// TURN dynamic credentials config (coturn REST API style)
// Required: TURN_SECRET must match coturn's static-auth-secret.
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || 'turns:turn.zababba.com:443?transport=tcp').split(',').map(s => s.trim()).filter(Boolean);
const TURN_TTL = parseInt(process.env.TURN_TTL || '120', 10); // seconds

// Универсальный хэндлер создания комнаты (совместим с /signal и /signal/create)
function createRoomHandler(_req, res) {
  const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  res.json({ roomId });
}

// Старый путь
app.post('/signal', createRoomHandler);

// Совместимый путь (если фронт вызывает /signal/create)
app.post('/signal/create', createRoomHandler);

// Совместимый путь (если фронт вызывает /signal/rooms)
app.post('/signal/rooms', createRoomHandler);

// Issue temporary TURN credentials (HMAC-SHA1 per coturn "REST API")
app.get('/turn-credentials', (req, res) => {
  try {
    if (!TURN_SECRET) {
      return res.status(500).json({ error: 'TURN_SECRET is not set on server' });
    }
    const user = (req.query.user || 'zvonilka').toString().slice(0, 32);
    const expiry = Math.floor(Date.now() / 1000) + TURN_TTL; // unix ts
    const username = `${expiry}:${user}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');

    res.set('Cache-Control', 'no-store');
    return res.json({
      iceServers: [
        { urls: TURN_URLS, username, credential }
      ],
      ttl: TURN_TTL
    });
  } catch (e) {
    return res.status(500).json({ error: 'turn-credentials failure' });
  }
});

const server = http.createServer(app);

// Память комнат: roomId -> Set(ws)
const rooms = new Map();

function addToRoom(roomId, ws) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
  ws._roomId = roomId;
}
function removeFromRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const set = rooms.get(roomId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(roomId);
}
function broadcast(roomId, msg, exceptWs) {
  const set = rooms.get(roomId);
  if (!set) return;
  const payload = JSON.stringify(msg);
  for (const client of set) {
    if (client !== exceptWs && client.readyState === 1) {
      try { client.send(payload); } catch {}
    }
  }
}

const wss = new WebSocketServer({ noServer: true });

// Апгрейд на /ws
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

wss.on('connection', (ws) => {
  try {
    const { roomId, role } = ws._query || {};
    if (!roomId) {
      ws.close(1008, 'roomId required');
      return;
    }
    addToRoom(roomId, ws);

    ws.send(JSON.stringify({ type: 'hello', memberId: Math.random().toString(36).slice(2) }));
    broadcast(roomId, { type: 'member.joined', role: role || 'unknown' }, ws);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} return; }
      if (msg.type === 'bye') {
        // Рассылаем bye всем в комнате и закрываем соединение
        broadcast(roomId, { type: 'bye', reason: 'user-hangup' }, ws);
        try { ws.close(1000, 'user-hangup'); } catch {}
        return;
      }
      broadcast(roomId, msg, ws);
    });

    ws.on('close', () => {
      broadcast(roomId, { type: 'bye', reason: 'peer-left' }, ws);
      removeFromRoom(ws);
    });
    ws.on('error', () => {});
  } catch {
    try { ws.close(); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signal server listening on http://localhost:${PORT}`);
});