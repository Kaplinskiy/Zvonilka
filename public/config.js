// public/config.js
// Публичный конфиг, который можно менять без перекомпиляции.
// Здесь же задаём TURN-конфиг для WebRTC.

// Рест-эндпойнты приложения
window.__APP_CONFIG__ = {
  SERVER_URL: 'https://call.zababba.com/signal',
  WS_URL:     'wss://call.zababba.com/ws'
};

// Конфиг ICE/TURN. Вынесен сюда, чтобы WebRTC читал его из одного места.
// forceRelay:true — форсируем relay через TURN (важно для ограниченных сетей).
window.__TURN__ = {
  iceServers: [
    {
      urls: [ 'turns:turn.zababba.com:443?transport=tcp' ],
      username: 'demo',
      credential: 'FaInA2019!'
    }
  ],
  forceRelay: true
};
// public/config.js
// Публичный конфиг для фронтенда. Теперь эндпоинты берём с текущего origin.
// Это работает и в DEV (через Vite proxy), и в PROD (через nginx/node).

window.__APP_CONFIG__ = {
  SERVER_URL: `${location.origin}/signal`,
  WS_URL:     `${location.origin.replace(/^http/, 'ws')}/ws`
};

// Конфиг ICE/TURN. Вынесен сюда, чтобы WebRTC читал его из одного места.
// forceRelay:true — форсируем relay через TURN (важно для ограниченных сетей).
window.__TURN__ = {
  iceServers: [
    {
      urls: [ 'turns:turn.zababba.com:443?transport=tcp' ],
      username: 'demo',
      credential: 'FaInA2019!'
    }
  ],
  forceRelay: true
};