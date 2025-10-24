
function buildIceConfig(){
    const t = (window && window.__TURN__) ? window.__TURN__ : {};
    const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    if (!t || !Array.isArray(t.iceServers) || !t.iceServers.length) { // keep fallback if no valid servers
      return fallback;
    }
    const fallbackHost = String((window.__APP_CONFIG && window.__APP_CONFIG.TURN_URL) || 'turns:turn.zababba.com:5349?transport=tcp')
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
          after = after.replace(/^turns?:\/\//i, '').replace(/^turns?:/i, '');
          let host = after.split(/[/?#:]/)[0].split(':')[0];
          if (!host) host = fallbackHost;
          out.add(`turns:${host}:5349?transport=tcp`);
          out.add(`turn:${host}:3478?transport=udp`);
          continue;
        }
        // Bare host: coerce to TURNS on 5349
        let host = raw.replace(/^https?:\/{0,2}/i, '').split(/[/?#:]/)[0].split(':')[0];
        if (!host) host = fallbackHost;
        out.add(`turns:${host}:5349?transport=tcp`);
        out.add(`turn:${host}:3478?transport=udp`);
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
          iceServers: [{ urls: ['turns:turn.zababba.com:5349?transport=tcp'], username: '', credential: '', credentialType: 'password' }],
          forceRelay: true,
          expiresAt: Date.now() + 120000
        };
        window.__TURN__ = cfg;
        return cfg;
      }
      const data = await res.json();
      const fallbackHost = 'turn.zababba.com';
      // normalize to TURNS/TCP and TURN/UDP and sanitize malformed entries
      let iceServers = (Array.isArray(data.iceServers) ? data.iceServers : []).map(s => ({
        ...s,
        urls: (Array.isArray(s.urls) ? s.urls : [s.urls])
          .filter(Boolean)
          .map(u => {
            let url = String(u).trim();
            if (/^turns:turns:/i.test(url)) url = `turns:${fallbackHost}:5349?transport=tcp`;
            if (/^turns?:\/\//i.test(url)) {
              let host = url.replace(/^turns?:\/{0,2}/i, '').split(/[/?#:]/)[0].split(':')[0];
              if (!host || host.toLowerCase() === 'turns') host = fallbackHost;
              return [
                `turns:${host}:5349?transport=tcp`,
                `turn:${host}:3478?transport=udp`
              ];
            }
            let host = url.replace(/^https?:\/{0,2}/i, '').split(/[/?#:]/)[0].split(':')[0];
            if (!host || host.toLowerCase() === 'turns') host = fallbackHost;
            return [
              `turns:${host}:5349?transport=tcp`,
              `turn:${host}:3478?transport=udp`
            ];
          })
          .flat()
          .filter(Boolean)
      }));
      const cfg = { iceServers, forceRelay: true, expiresAt: data.expiresAt || 0 };
      window.__TURN__ = cfg;
      console.log('TURN config loaded (TCP+UDP relay)', cfg);
      return cfg;
    } catch (err) {
      console.warn('[WEBRTC] loadTurnConfig: error fetching TURN credentials', err);
      const cfg = {
        iceServers: [{ urls: ['turns:turn.zababba.com:5349?transport=tcp'], username: '', credential: '', credentialType: 'password' }],
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
