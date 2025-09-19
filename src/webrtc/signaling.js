// public/js/signaling.js
// Сигналинг, совместимый с текущим index.html.
// Файл публикует функции в window, не ломая существующий код.
// Подключайте его ДО большого инлайн-скрипта:
// <script src="/public/js/signaling.js"></script>

(function () {
  const CFG = (window.__APP_CONFIG__) || {
    SERVER_URL: 'https://call.zababba.com/signal',
    WS_URL:     'wss://call.zababba.com/ws'
  };

  // Локальные ссылки на активный WS и таймер пингов
  let _ws = null;
  let _pingTimer = null;

  async function apiCreateRoom(customId) {
    const url = `${CFG.SERVER_URL}/rooms`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customId ? { roomId: customId } : {})
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`create room failed: ${res.status} ${res.statusText}${txt ? ' - ' + txt : ''}`);
      }
      return res.json();
    } catch (e) {
      if (window.addLog) window.addLog('error', e.message || String(e));
      throw e;
    }
  }

  /**
   * Подключение к WS сигналинга.
   * @param {'caller'|'callee'} role
   * @param {string} roomId
   * @param {(msg:any)=>void} onMessage - колбэк на каждое входящее сообщение
   * @returns {Promise<{memberId:string}>} резолвится после 'hello'
   */
  function connectWS(role, roomId, onMessage) {
    return new Promise((resolve, reject) => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        if (window.addLog) window.addLog('warn', `WS уже подключён (${role})`);
        // Не ломаем текущие сценарии — считаем, что уже был hello
        resolve({ memberId: 'already-open' });
        return;
      }
      const q = new URLSearchParams({ room: roomId, role }).toString();
      const url = `${CFG.WS_URL}?${q}`;
      if (window.addLog) window.addLog('signal', `connect WS ${url}`);

      let hadHello = false;
      _ws = new WebSocket(url);

      _ws.onopen = () => {
        if (window.addLog) window.addLog('signal', 'ws open');
        // пинги каждые 20с
        _pingTimer = setInterval(() => {
          try { _ws?.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
        }, 20_000);
      };

      _ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { msg = ev.data; }
        if (typeof msg === 'object' && msg && msg.type === 'ping') {
          if (window.addLog) window.addLog('signal', 'recv ping');
          return;
        }
        if (onMessage) onMessage(msg);
        if (msg && msg.type === 'hello' && !hadHello) {
          hadHello = true;
          resolve({ memberId: msg.memberId || 'unknown' });
        }
      };

      _ws.onerror = (e) => {
        if (window.addLog) window.addLog('error', 'ws error');
      };

      _ws.onclose = (e) => {
        if (window.addLog) window.addLog('signal', `ws close code=${e.code} reason=${e.reason || '-'}`);
        if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
        if (!hadHello) reject(new Error('WebSocket closed before hello'));
      };
    });
  }

  function wsSend(type, payload) {
    try {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type, ...payload && { payload } }));
        if (window.addLog) window.addLog('signal', `send ${type}`);
      }
    } catch (e) {
      if (window.addLog) window.addLog('error', e.message || String(e));
    }
  }

  function wsClose() {
    try {
      if (_ws) _ws.close();
    } catch {}
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
    _ws = null;
  }

  // Публикуем в window, если ещё не объявлено в глобальной области,
  // чтобы не ломать существующий index.html
  try {
    if (typeof window !== 'undefined') {
      if (!window.apiCreateRoom) window.apiCreateRoom = apiCreateRoom;
      if (!window.connectWS)    window.connectWS    = connectWS;
      if (!window.wsSend)       window.wsSend       = wsSend;
      if (!window.wsClose)      window.wsClose      = wsClose;
      // служебно
      window.__SIGNALING__ = { apiCreateRoom, connectWS, wsSend, wsClose };
    }
  } catch {}
})();
// src/webrtc/signaling.js
// ВНИМАНИЕ: рантайм-версия сигналинга подключается из /public/js/signaling.js
// Этот файл сейчас не используется браузером напрямую, оставлен как заглушка,
// чтобы избежать путаницы. Когда перейдём на сборку (Vite/TS), перенесём код сюда.
// Источник правды на данный момент: /public/js/signaling.js

export const __placeholder = true;