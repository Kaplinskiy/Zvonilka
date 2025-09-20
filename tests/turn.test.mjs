import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import http from 'http';

describe('/turn-credentials', () => {
  let app, server, base, request;

  // стартуем app на свободном порту
  beforeAll(async () => {
    process.env.TURN_SECRET = 'testsecret';
    const mod = await import('../server.js');
    app = mod.app || mod.default;
    const httpServer = http.createServer(app);
    await new Promise(r => httpServer.listen(0, r));
    server = httpServer;
    const { port } = httpServer.address();
    base = `http://127.0.0.1:${port}`;
    request = supertest(base);
  });

  afterAll(async () => server && server.close());

  it('returns valid HMAC credentials', async () => {
    const res = await request.get('/turn-credentials?user=tester');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      iceServers: expect.any(Array),
      ttl: expect.any(Number)
    });
    const s = res.body.iceServers?.[0];
    expect(s).toMatchObject({
      urls: expect.any(Array),
      username: expect.stringMatching(/^\d+:tester$/),
      credential: expect.any(String)
    });
    expect(res.body.ttl).toBeGreaterThan(60);
  });
});