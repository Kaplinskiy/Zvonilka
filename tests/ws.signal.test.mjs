import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';

describe('WS signaling /ws', () => {
  let server, baseURL, a, b;

  beforeAll(async () => {
    // ensure server.js does not auto-listen
    process.env.NODE_ENV = 'test';
    process.env.TURN_SECRET = 'testsecret';
    const mod = await import('../server.js');
    server = mod.server;
    await new Promise((r) => server.listen(0, r));
    const { port } = server.address();
    baseURL = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    try { a && a.readyState === WebSocket.OPEN && a.close(); } catch {}
    try { b && b.readyState === WebSocket.OPEN && b.close(); } catch {}
    await new Promise((r) => server.close(r));
  });

  const onceOpen = (ws) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('open timeout')), 5000);
    ws.on('open', () => { clearTimeout(t); res(); });
    ws.on('error', rej);
  });

  it('relays offer from A to B in same room and responds to ping', async () => {
    const roomId = 'r1';

    a = new WebSocket(`${baseURL}?roomId=${roomId}&role=caller`);
    b = new WebSocket(`${baseURL}?roomId=${roomId}&role=callee`);

    // Pre-buffer all incoming messages to avoid race with early 'hello'
    const qA = [];
    const qB = [];
    a.on('message', (buf) => { try { qA.push(JSON.parse(buf.toString())); } catch {} });
    b.on('message', (buf) => { try { qB.push(JSON.parse(buf.toString())); } catch {} });

    await Promise.all([onceOpen(a), onceOpen(b)]);

    const onceMsg = (ws, pred = () => true, timeoutMs = 8000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('message timeout')), timeoutMs);
      const queue = (ws === a) ? qA : (ws === b) ? qB : null;
      if (queue && queue.length) {
        for (let i = 0; i < queue.length; i++) {
          const msg = queue[i];
          if (pred(msg)) {
            clearTimeout(t);
            queue.splice(i, 1);
            return res(msg);
          }
        }
      }
      const handler = (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          if (pred(msg)) { clearTimeout(t); ws.off('message', handler); res(msg); }
        } catch { /* ignore */ }
      };
      ws.on('message', handler);
    });

    // both should receive hello
    const helloA = onceMsg(a, (m) => m.type === 'hello');
    const helloB = onceMsg(b, (m) => m.type === 'hello');
    await Promise.all([helloA, helloB]);

    // send offer from A, expect B to receive it unchanged
    const offer = { type: 'offer', payload: { type: 'offer', sdp: 'dummy-sdp' } };
    const gotOfferOnB = onceMsg(b, (m) => m.type === 'offer' && m.payload?.sdp === 'dummy-sdp', 5000);
    a.send(JSON.stringify(offer));
    const recv = await gotOfferOnB;

    expect(recv).toMatchObject(offer);

    // ping should echo ping
    const pingEcho = onceMsg(a, (m) => m.type === 'ping', 5000);
    a.send(JSON.stringify({ type: 'ping' }));
    await pingEcho;
  }, 20000);
});