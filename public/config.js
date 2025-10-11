// public/config.js
// Публичный конфиг для фронтенда. Теперь эндпоинты берём с текущего origin.
// Это работает и в DEV (через Vite proxy), и в PROD (через nginx/node).

window.__APP_CONFIG__ = {
  SERVER_URL: `${location.origin}/signal`,
  WS_URL:     `${location.origin.replace(/^http/, 'ws')}/ws`
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

    // Нормализуем iceServers: превращаем urls в массив и добавляем transport=tcp для TURN(S),
    // а также гарантируем наличие UDP-вариантов как запасного плана.
    const iceServers = (Array.isArray(data.iceServers) ? data.iceServers : [])
      .map(s => ({ ...s }))
      .map(s => {
        const list = Array.isArray(s.urls) ? s.urls : (s.urls ? [s.urls] : []);
        // Базовый список без дубликатов
        const norm = new Set();
        for (let u of list) {
          if (!/^turns?:/i.test(u)) { norm.add(u); continue; }
          // TCP-вариант
          const hasQ = u.includes('?');
          const withTcp = /transport=tcp/i.test(u) ? u : (u + (hasQ ? '&' : '?') + 'transport=tcp');
          norm.add(withTcp);
          // UDP-вариант (на случай, если TCP недоступен у провайдера)
          const withoutTcp = u.replace(/([?&])transport=tcp(&|$)/i, '$1').replace(/[?&]$/, '');
          const withUdp = /transport=udp/i.test(withoutTcp) ? withoutTcp : (withoutTcp.includes('?') ? withoutTcp + '&' : withoutTcp + '?') + 'transport=udp';
          norm.add(withUdp);
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
    console.log('TURN config loaded (relay via TCP; UDP fallback kept)', window.__TURN__);

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