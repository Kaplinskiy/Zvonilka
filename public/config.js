// public/config.js
// Публичный конфиг для фронтенда. Теперь эндпоинты берём с текущего origin.
// Это работает и в DEV (через Vite proxy), и в PROD (через nginx/node).

window.__APP_CONFIG__ = {
  SERVER_URL: `${location.origin}/signal`,
  WS_URL:     `${location.origin.replace(/^http/, 'ws')}/ws`
};

// Загружаем динамические TURN креды с бэкенда
async function loadTurnConfig() {
  try {
    const res = await fetch('/turn-credentials');
    if (!res.ok) throw new Error('TURN not available');
    const data = await res.json();
    window.__TURN__ = {
      iceServers: data.iceServers,
      forceRelay: true
    };
    console.log('TURN config loaded', window.__TURN__);
  } catch (e) {
    console.warn('TURN disabled, fallback to STUN only');
    // fallback на пустой список — WebRTC попробует прямое соединение
    window.__TURN__ = { iceServers: [], forceRelay: false };
  }
}
loadTurnConfig();