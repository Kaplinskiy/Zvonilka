// public/config.js
// Публичный конфиг для фронтенда. Теперь эндпоинты берём с текущего origin.
// Это работает и в DEV (через Vite proxy), и в PROD (через nginx/node).

window.__APP_CONFIG__ = {
  SERVER_URL: 'https://call.zababba.com/signal/create',
  WS_URL: 'wss://call.zababba.com/ws',
  TURN_URL: 'turns:turn.zababba.com:443?transport=tcp'
};

// Guard flags to avoid repeated loads and updates during active calls
window.__TURN_LOADING = false;

// Загружаем динамические TURN креды с бэкенда (принудительно добавляем TCP и оставляем UDP как фолбэк)
async function loadTurnConfig() {
  try {
    // Do not overwrite creds while a call is active (PC exists and not closed)
    try {
      const pc = (window.getPC && window.getPC()) || (window.__WEBRTC__ && window.__WEBRTC__.getPC && window.__WEBRTC__.getPC());
      const cs = pc && (pc.connectionState || pc.iceConnectionState);
      if (pc && cs && cs !== 'closed') {
        // schedule a short retry later instead of hot-swapping creds mid-call
        if (window.__TURN_REFRESH_T) clearTimeout(window.__TURN_REFRESH_T);
        window.__TURN_REFRESH_T = setTimeout(loadTurnConfig, 30_000);
        return;
      }
    } catch {}

    // Skip if already loading
    if (window.__TURN_LOADING) return;
    window.__TURN_LOADING = true;

    // no-cache to avoid stale creds
    const res = await fetch('/turn-credentials?ts=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('TURN not available');
    const data = await res.json();

    const credType = data.credentialType || 'password';
    const ttlSec = Number(data.ttl || 0);
    const expiresAt = data.expires ? Date.parse(data.expires) : (ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0);

    // Нормализуем iceServers: оставляем ТОЛЬКО TURNS/TCP и корректируем кривые значения ("turns" → turn.zababba.com).
    const iceServers = (Array.isArray(data.iceServers) ? data.iceServers : [])
      .map(s => ({ ...s }))
      .map(s => {
        const list = Array.isArray(s.urls) ? s.urls : (s.urls ? [s.urls] : []);
        const norm = new Set();
        // derive default host from APP_CONFIG if available
        const fallbackTurn = (window.__APP_CONFIG__ && window.__APP_CONFIG__.TURN_URL) || 'turns:turn.zababba.com:443?transport=tcp';
        const fallbackHost = String(fallbackTurn).replace(/^turns?:\/{0,2}/i, '').split(/[/?#:]/)[0].split(':')[0] || 'turn.zababba.com';
        for (let u of list) {
          const raw = (u || '').trim();
          // If full TURN url provided, normalize to TURNS/TCP and extract host
          if (/^turns?:\/\//i.test(raw)) {
            const host = raw.replace(/^turns?:\/{0,2}/i, '').split(/[/?#:]/)[0].split(':')[0] || fallbackHost;
            norm.add(`turns:${host}:443?transport=tcp`);
            continue;
          }
          // Host-only or malformed token (e.g. "turns"): coerce to canonical TURNS/TCP
          let hostOnly = raw.replace(/^https?:\/{0,2}/i, '').replace(/^turns?:/i, '').replace(/\/$/, '').split(/[/?#:]/)[0].split(':')[0];
          if (!hostOnly || hostOnly.toLowerCase() === 'turns') hostOnly = fallbackHost;
          norm.add(`turns:${hostOnly}:443?transport=tcp`);
        }
        return {
          urls: Array.from(norm),
          username: s.username || data.username,
          credential: s.credential || data.credential,
          credentialType: s.credentialType || credType
        };
      });

    // Сохраняем и форсим relay
    window.__TURN__ = { iceServers, forceRelay: true, expiresAt };
    console.log('TURN config loaded (TCP-only relay)', window.__TURN__);

    // Авто-обновление: за 60 сек до истечения
    if (window.__TURN_REFRESH_T) clearTimeout(window.__TURN_REFRESH_T);
    if (expiresAt && expiresAt > Date.now()) {
      const refreshMs = Math.max(5_000, (expiresAt - Date.now()) - 60_000);
      window.__TURN_REFRESH_T = setTimeout(loadTurnConfig, refreshMs);
    }
    window.__TURN_LOADING = false;
  } catch (e) {
    console.warn('TURN disabled or fetch failed, fallback to direct/STUN only');
    window.__TURN__ = { iceServers: [], forceRelay: false, expiresAt: 0 };
    if (window.__TURN_REFRESH_T) clearTimeout(window.__TURN_REFRESH_T);
    window.__TURN_LOADING = false;
  }
}
loadTurnConfig();
