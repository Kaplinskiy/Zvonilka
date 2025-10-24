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
async function loadTurnConfig() {
  try {
    const base = (window.__APP_CONFIG__ && window.__APP_CONFIG__.SERVER_URL) || '';
    const url = base ? `${String(base).replace(/\/+$/,'')}/signal/turn-credentials` : '/signal/turn-credentials';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      console.warn('[WEBRTC] loadTurnConfig: failed to fetch TURN credentials, status:', res.status);
      const cfg = {
        iceServers: [{ urls: ['turns:turn.zababba.com:5349?transport=tcp','turn:turn.zababba.com:3478?transport=udp'], username: '', credential: '', credentialType: 'password' }],
        forceRelay: true,
        expiresAt: Date.now() + 120000
      };
      window.__TURN__ = cfg;
      return cfg;
    }
    const data = await res.json();
    const urls = [
      'turns:turn.zababba.com:5349?transport=tcp',
      'turn:turn.zababba.com:3478?transport=udp'
    ];
    const iceServers = [{
      urls,
      username: data.iceServers && data.iceServers[0] ? (data.iceServers[0].username || '') : (data.username || ''),
      credential: data.iceServers && data.iceServers[0] ? (data.iceServers[0].credential || '') : (data.credential || ''),
      credentialType: 'password'
    }];
    const cfg = { iceServers, forceRelay: true, expiresAt: data.expiresAt || 0 };
    window.__TURN__ = cfg;
    console.log('TURN config loaded (TCP+UDP relay)', cfg);
    return cfg;
  } catch (err) {
    console.warn('[WEBRTC] loadTurnConfig: error fetching TURN credentials', err);
    const cfg = {
      iceServers: [{ urls: ['turns:turn.zababba.com:5349?transport=tcp','turn:turn.zababba.com:3478?transport=udp'], username: '', credential: '', credentialType: 'password' }],
      forceRelay: true,
      expiresAt: Date.now() + 120000
    };
    window.__TURN__ = cfg;
    return cfg;
  }
}
if (typeof window !== 'undefined') {
  window.__TURN_PROMISE__ = loadTurnConfig().catch(() => ({}));
}
