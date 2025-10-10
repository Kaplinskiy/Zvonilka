// public/config.js
// Публичный конфиг для фронтенда. Теперь эндпоинты берём с текущего origin.
// Это работает и в DEV (через Vite proxy), и в PROD (через nginx/node).

window.__APP_CONFIG__ = {
  SERVER_URL: `${location.origin}/signal`,
  WS_URL:     `${location.origin.replace(/^http/, 'ws')}/ws`
};

// Загружаем динамические TURN креды с бэкенда (принудительно TCP/443)
async function loadTurnConfig() {
  try {
    const res = await fetch('/turn-credentials');
    if (!res.ok) throw new Error('TURN not available');
    const data = await res.json();

    // Нормализуем iceServers: превращаем urls в массив и добавляем transport=tcp для TURN(S)
    const iceServers = (Array.isArray(data.iceServers) ? data.iceServers : [])
      .map(s => ({ ...s }))
      .map(s => {
        const list = Array.isArray(s.urls) ? s.urls : (s.urls ? [s.urls] : []);
        s.urls = list.map(u => {
          if (/^turns?:/i.test(u) && !/transport=tcp/i.test(u)) {
            return u + (u.includes('?') ? '&' : '?') + 'transport=tcp';
          }
          return u;
        });
        return s;
      });

    window.__TURN__ = {
      iceServers,
      forceRelay: true // всегда через relay для устойчивости на мобиле/за NAT
    };
    console.log('TURN config loaded (relay via TCP)', window.__TURN__);
  } catch (e) {
    console.warn('TURN disabled, fallback to STUN/direct');
    // fallback на прямое соединение; без TURN relay невозможен
    window.__TURN__ = { iceServers: [], forceRelay: false };
  }
}
loadTurnConfig();