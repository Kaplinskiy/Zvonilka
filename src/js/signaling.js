// public/js/signaling.js
// Сигналинг, совместимый с текущим index.html.
// Публикует функции в window и не ломает существующий код.
// Подключайте ДО большого инлайн-скрипта:
//   <script src="/public/js/signaling.js"></script>

(function () {
  const CFG = (window.__APP_CONFIG__) || {
    SERVER_URL: 'https://call.zababba.com/signal',
    WS_URL:     'wss://call.zababba.com/ws'
  };

  // Локальные ссылки на активный WS и таймер пингов
  let _ws = null;
  let _pingTimer = null;

  // Lightweight i18n accessor that works if i18next is on window
  function t(key, fallback) {
    try { return (window.i18next && window.i18next.t) ? window.i18next.t(key) : (fallback || key); }
    catch { return fallback || key; }
  }

  function isWSOpen() {
    return !!(_ws && _ws.readyState === WebSocket.OPEN);
    }

  function waitWSOpen(timeoutMs = 3000) {
    if (isWSOpen()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (isWSOpen()) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(t('ws.disconnected', 'WS not connected')));
        }
      }, 50);
    });
  }

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
  // public/js/signaling.js
// ... остальной код без изменений ...

 // public/js/signaling.js
// ... остальной код без изменений ...

function connectWS(role, roomId, onMessage) {
  return new Promise((resolve, reject) => {
    // Глобальное состояние сокета и бэкофа хранится в замыкании файла
    let attempt = 0;                 // счётчик попыток
    const maxDelay = 10_000;         // максимум задержки
    let resolvedHello = false;
    let closedCleanly = false;

    const openSocket = () => {
      const q = new URLSearchParams({ roomId, role }).toString();
      const url = `${CFG.WS_URL}?${q}`;
      window.addLog && window.addLog('signal', `connect WS ${url}`);

      _ws = new WebSocket(url);

      _ws.onopen = () => {
        window.addLog && window.addLog('signal', 'ws open');
        // пинги каждые 20с
        _pingTimer = setInterval(() => {
          try { _ws?.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
        }, 20_000);
        // успешное подключение — сбрасываем backoff
        attempt = 0;
      };

      _ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { msg = ev.data; }

        if (typeof msg === 'object' && msg && msg.type === 'ping') {
          window.addLog && window.addLog('signal', 'recv ping');
          return;
        }
        // hello впервые — резолвим connectWS
        if (msg && msg.type === 'hello' && !resolvedHello) {
          resolvedHello = true;
          resolve({ memberId: msg.memberId || 'unknown' });
        }
        onMessage && onMessage(msg);
      };

      _ws.onerror = () => {
        window.addLog && window.addLog('error', 'ws error');
      };

      _ws.onclose = (e) => {
        window.addLog && window.addLog('signal', `ws close code=${e.code} reason=${e.reason || '-'}`);
        if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }

        // Чистое закрытие — не переподключаемся
        const normal = (e.code === 1000 || e.code === 1005);
        if (normal) {
          closedCleanly = true;
          return;
        }

        // Если мы ещё не получили hello — проваливаем стартовую connectWS
        if (!resolvedHello) {
          reject(new Error('WebSocket closed before hello'));
          return;
        }

        // Мягкий авто-reconnect: экспоненциальный backoff до 10s
        if (!closedCleanly) {
          attempt += 1;
          const delay = Math.min(500 * 2 ** (attempt - 1), maxDelay);
          if (typeof window.setStatus === 'function') {
            window.setStatus(t('signal.recovering', 'восстанавливаем сигналинг…'), 'warn');
          }
          window.addLog && window.addLog('signal', `ws reconnect in ${delay}ms (attempt ${attempt})`);
          setTimeout(() => {
            // Защита от гонок: если кто-то уже открыл новый сокет — выходим
            if (_ws && _ws.readyState === WebSocket.OPEN) return;
            openSocket();
          }, delay);
        }
      };
    };

    // Если уже открыт — не плодим соединения
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      window.addLog && window.addLog('warn', `WS уже подключён (${role})`);
      resolve({ memberId: 'already-open' });
      return;
    }

    openSocket();
  });
}

  function wsSend(type, payload) {
    try {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type, ...(payload ? { payload } : {}) }));
        window.addLog && window.addLog('signal', `send ${type}`);
      }
    } catch (e) {
      window.addLog && window.addLog('error', e.message || String(e));
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
      if (!window.isWSOpen)     window.isWSOpen     = isWSOpen;
      if (!window.waitWSOpen)  window.waitWSOpen  = waitWSOpen;
      // служебно
      window.__SIGNALING__ = { apiCreateRoom, connectWS, wsSend, wsClose, isWSOpen, waitWSOpen };
    }
  } catch {}
})();