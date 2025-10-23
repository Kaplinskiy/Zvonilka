function buildIceConfig(){
    const t = (window && window.__TURN__) ? window.__TURN__ : {};
    const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    if (!t || !Array.isArray(t.iceServers) || t.ather) { // keep fallback if no valid servers
      return fallback;
    }
    const fallbackHost = String((window.__APP_CONFIG && window.__APP_CONFIG.TURN_URL) || 'turns:turn.zababba.com:443?transport=tcp')
      .replace(/^turns?:\/{0,2}/i, '')
      .split(/[/?#:]/)[0]
      .split(':')[0] || 'turn.zababba.com';

    const norm = t.iceServers.map((s) => {
      const rawList = Array.isArray(s.urls) ? s.urls : (s.urls ? [s.urls] : []);
      const out = new Set();
      for (let u of rawList) {
        if (!u) continue;
        let raw = String(u).trim();
        // If it already has a TURN scheme, strip scheme and any duplicated scheme fragments
        if (/^turns?:/i.test(raw)) {
          let after = raw.replace(/^turns?:\/{0,2}/i, ''); // drop scheme and // if present
          // handle accidental "turns:turns:host" → keep only host part after the first scheme
          after = after.replace(/^turns:\/\//i, '').replace(/^turns:/i, '');
          let host = after.split(/[/?#:]/)[0].split(':')[0];
          if (!host) host = fallbackHost;
          out.add(`turns:${host}:443?transport=tcp`);
          continue;
        }
        // Bare host: coerce to TURNS on 443
        let host = raw.replace(/^https?:\/{0,2}/i, '').split(/[/?#:]/)[0].split(':')[0];
        if (!host) host = fallbackHost;
        out.add(`turns:${host}:443?transport=tcp`);
      }
      return {
        urls: Array.from(out),
        username: s.username,
        credential: s.credential,
        credentialType: s.credentialType || 'password',
      };
    });

    const cfg = { iceServers: norm };
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
  if (typeof window !== 'undefined') { window.waitTurnReady = waitTurnReady; }
window.__TURN_PROMISE__ = loadTurnConfig().catch(()=>({}));
