function buildIceConfig(){
  const t = (typeof window !== 'undefined' && window.__TURN__) ? window.__TURN__ : {};
  const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  if (!t || !Array.isArray(t.iceServers) || !t.iceServers.length) return fallback;
  const cfg = { iceServers: t.iceServers };
  if (t.forceRelay) cfg.iceTransportPolicy = 'relay';
  try { console.log('[ICE CONFIG DEBUG]', JSON.stringify(cfg, null, 2)); } catch {}
  return cfg;
}

// Wait until TURN config (window.__TURN__.iceServers) is available, up to a timeout
async function waitTurnReady(ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const t = window && window.__TURN__;
      if (t && Array.isArray(t.iceServers) && t.iceServers.length) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  console.warn('[WEBRTC] waitTurnReady: timed out; proceeding with current config');
  return false;
}
if (typeof window !== 'undefined') {
  window.waitTurnReady = waitTurnReady;
  // ensure the promise exists even if loadTurnConfig is not defined in this file
  if (!window.__TURN_PROMISE__) window.__TURN_PROMISE__ = Promise.resolve();
}

// Load TURN configuration asynchronously (TCP-only relay)
async function loadTurnConfig(force = false) {
  const url = '/signal/turn-credentials';
  try {
    // если уже есть валидный набор и не просили принудительно — вернём его
    if (!force && window.__TURN__ && Array.isArray(window.__TURN__.iceServers) && window.__TURN__.iceServers.length) {
      return window.__TURN__;
    }
    const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error('turn fetch ' + r.status);
    const j = await r.json();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Number(j.expiresAt || 0);
    const ice = Array.isArray(j.iceServers) ? j.iceServers : [];

    // нормализация URL и жёсткий набор (без «turns:turn:...» дубликатов)
    const norm = ice.map(s => ({
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(Boolean).map(u => {
        const str = String(u).trim();
        if (/^turns?:/i.test(str)) return str;
        const host = str.replace(/^https?:\/\//i,'').split(/[/?#:]/)[0];
        return `turns:${host || 'turn.zababba.com'}:443?transport=tcp`;
      }),
      username: s.username,
      credential: s.credential,
      credentialType: s.credentialType || 'password'
    }));

    window.__TURN__ = {
      iceServers: norm,
      forceRelay: true,
      issuedAt: now,
      expiresAt: expiresAt || 0
    };
    console.log('TURN config loaded (authoritative)', window.__TURN__);
    return window.__TURN__;
  } catch (e) {
    console.warn('[WEBRTC] loadTurnConfig failed, using last or fallback', e && (e.message || e));
    if (window.__TURN__ && Array.isArray(window.__TURN__.iceServers) && window.__TURN__.iceServers.length) return window.__TURN__;
    // минимальный фоллбек, если нет вообще ничего
    window.__TURN__ = {
      iceServers: [
        { urls: ['turns:turn.zababba.com:443?transport=tcp', 'turn:turn.zababba.com:443?transport=udp'] }
      ],
      forceRelay: true,
      issuedAt: Math.floor(Date.now()/1000),
      expiresAt: 0
    };
    return window.__TURN__;
  }
}

if (typeof window !== 'undefined') {
  window.loadTurnConfig = loadTurnConfig;
}

