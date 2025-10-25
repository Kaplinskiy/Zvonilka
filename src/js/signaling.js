// public/js/signaling.js
// Signaling module compatible with the current index.html.
// Exposes functions on the window object without breaking existing code.
// Include this BEFORE the large inline script:
//   <script src="/public/js/signaling.js"></script>

(function () {
  // Configuration object, either from global app config or defaults
  const CFG = (window.__APP_CONFIG__) || {
    SERVER_URL: 'https://call.zababba.com/signal',
    WS_URL:     'wss://call.zababba.com/ws'
  };

  // Local references to the active WebSocket and the ping timer
  let _ws = null;
  let _pingTimer = null;

  function getIds() {
    try { return { roomId: window.__WS_ROOM__ || null, clientId: window.__CLIENT_ID || null }; }
    catch { return { roomId: null, clientId: null }; }
  }

  // Expose live socket on window for other modules (main/webrtc)
  try {
    if (typeof window !== 'undefined') {
      window.__WS__ = window.__WS__ || null;
      window.__WS_ROOM__ = window.__WS_ROOM__ || null;
      window.__WS_ROLE__ = window.__WS_ROLE__ || null;
      window.__WS_BEFOREUNLOAD_BOUND__ = window.__WS_BEFOREUNLOAD_BOUND__ || false;
      // ensure public handles exist
      if (!('ws' in window)) window.ws = null;
    }
  } catch {}

  /**
   * Lightweight internationalization helper function.
   * Attempts to use i18next if available on the window object,
   * otherwise falls back to provided fallback or the key itself.
   * @param {string} key - Translation key
   * @param {string} fallback - Fallback string if translation not found
   * @returns {string} Translated string or fallback
   */
  function t(key, fallback) {
    try { return (window.i18next && window.i18next.t) ? window.i18next.t(key) : (fallback || key); }
    catch { return fallback || key; }
  }

  /**
   * Checks if the WebSocket connection is currently open.
   * @returns {boolean} True if WebSocket is open, false otherwise
   */
  function isWSOpen() {
    return !!(_ws && _ws.readyState === WebSocket.OPEN);
    }

  /**
   * Waits until the WebSocket connection is open or times out.
   * Polls every 80ms up to the specified timeout.
   * @param {number} timeoutMs - Timeout in milliseconds (default 3000ms)
   * @returns {Promise<void>} Resolves when WebSocket is open, rejects on timeout
   */
  function waitWSOpen(timeoutMs = 3000) {
    if (isWSOpen() || (typeof window !== 'undefined' && window.ws && window.ws.readyState === WebSocket.OPEN)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const iv = setInterval(() => {
        const ready = (_ws && _ws.readyState === WebSocket.OPEN) || (typeof window !== 'undefined' && window.ws && window.ws.readyState === WebSocket.OPEN);
        if (ready) {
          clearInterval(iv);
          resolve();
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(iv);
          reject(new Error(t('ws.disconnected', 'WS not connected')));
        }
      }, 80);
    });
  }

  /**
   * Creates a new room via the signaling server's REST API.
   * Optionally accepts a custom room ID.
   * @param {string} [customId] - Optional custom room ID
   * @returns {Promise<object>} Resolves with created room details
   * @throws Throws error if creation fails
   */
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
   * Establishes a WebSocket connection to the signaling server.
   * Supports automatic reconnection with exponential backoff on unexpected closures.
   * Resolves once a 'hello' message is received from the server with memberId.
   * @param {'caller'|'callee'} role - Role of the client in the call
   * @param {string} roomId - The room ID to join
   * @param {(msg:any)=>void} onMessage - Callback invoked on each incoming message
   * @returns {Promise<{memberId:string}>} Resolves after receiving 'hello' message
   */
function connectWS(role, roomId, onMessage) {
  return new Promise((resolve, reject) => {
    // Internal state for connection attempts and backoff
    let attempt = 0;                 // Number of connection attempts
    const maxDelay = 3_000;         // Maximum backoff delay in ms
    let resolvedHello = false;       // Flag to track if 'hello' message received
    let closedCleanly = false;       // Flag to indicate clean socket closure

    /**
     * Opens the WebSocket connection and sets up event handlers.
     * Handles automatic reconnection logic on unexpected closures.
     */
    const openSocket = () => {
      const q = new URLSearchParams({ roomId: roomId, role, clientId: (window.__CLIENT_ID || '') }).toString();
      const url = `${CFG.WS_URL}?${q}`;
      window.addLog && window.addLog('signal', `connect WS ${url}`);

      _ws = new WebSocket(url);
      try { console.debug('[WS] opening', url); } catch {}
      // ensure wsSend always targets current socket
      try { if (typeof window !== 'undefined') { window.wsSend = wsSend; } } catch {}
      try {
        if (typeof window !== 'undefined') {
          window.__WS__ = _ws;
          window.__WS_ROOM__ = roomId;
          window.__WS_ROLE__ = role;
          window.ws = _ws;
          if (!window.__WS_BEFOREUNLOAD_BOUND__) {
            window.addEventListener('beforeunload', () => { try { _ws && _ws.close(1000, 'leave'); } catch {} });
            window.__WS_BEFOREUNLOAD_BOUND__ = true;
          }
        }
      } catch {}

      _ws.onopen = () => {
        window.ws = _ws;
        window.addLog && window.addLog('signal', 'ws open');
        _pingTimer = setInterval(() => {
          try { _ws?.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
        }, 20_000);
        attempt = 0;
      };

      _ws.onmessage = (ev) => {
        try { console.debug('[WS-IN]', ev.data); } catch {}
        let msg;
        try { msg = JSON.parse(ev.data); } catch { msg = ev.data; }
        // Normalize: turn raw strings or alias types into canonical objects
        try {
          if (typeof msg === 'string') {
            // Some backends forward plain candidate lines
            if (/^candidate:/.test(msg)) msg = { type: 'ice', candidate: msg };
          } else if (msg && typeof msg === 'object') {
            const t = String(msg.type || '').toLowerCase();
            if (t === 'icecandidate' || t === 'candidate') {
              msg = { type: 'ice', candidate: (msg.candidate ?? msg.payload ?? msg.data ?? null) };
            }
          }
        } catch {}
        try { window.__SIG_HOOK && window.__SIG_HOOK(msg); } catch {}

        // Drop messages for other clients or from stale sockets
        try {
          if (msg && typeof msg === 'object' && msg.toClientId && window.__CLIENT_ID && msg.toClientId !== window.__CLIENT_ID) {
            return; // not for this client
          }
          if (window.__WS__ && _ws !== window.__WS__) {
            return; // message from stale socket instance
          }
        } catch {}

        // Ignore ping messages from server
        if (typeof msg === 'object' && msg && msg.type === 'ping') {
          window.addLog && window.addLog('signal', 'recv ping');
          return;
        }
        // On receiving 'hello' message for the first time, resolve the connectWS promise
        if (msg && msg.type === 'hello' && !resolvedHello) {
          resolvedHello = true;
          resolve({ memberId: msg.memberId || 'unknown' });
        }
        // Pass all other messages to the provided callback
        onMessage && onMessage(msg);
      };

      _ws.onerror = () => {
        window.addLog && window.addLog('error', 'ws error');
      };

      _ws.onclose = (e) => {
        if (window.__WS__ && _ws !== window.__WS__) { return; }
        window.addLog && window.addLog('signal', `ws close code=${e.code} reason=${e.reason || '-'}`);
        if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
        try {
          if (typeof window !== 'undefined') {
            if (window.__WS__ === _ws) {
              window.__WS__ = null;
              window.__WS_ROOM__ = null;
              window.__WS_ROLE__ = null;
              window.ws = null;
            }
          }
        } catch {}

        // If the socket closed cleanly (normal closure codes), do not attempt reconnect
        const normal = (e.code === 1000 || e.code === 1005);
        if (normal) {
          closedCleanly = true;
          return;
        }

        // If we haven't received the 'hello' message yet, reject the initial connect promise
        if (!resolvedHello) {
          reject(new Error('WebSocket closed before hello'));
          return;
        }

        // Automatic reconnect with exponential backoff up to maxDelay
        if (!closedCleanly) {
          attempt += 1;
          const base = 200;
          const jitter = Math.floor(Math.random() * 100);
          const delay = Math.min(base * 2 ** (attempt - 1) + jitter, maxDelay);
          if (typeof window.setStatusKey === 'function') {
            window.setStatusKey('signal.recovering', 'warn');
          } else if (typeof window.setStatus === 'function') {
            window.setStatus(t('signal.recovering', 'Restoring signaling connection…'), 'warn');
          }
          window.addLog && window.addLog('signal', `ws reconnect in ${delay}ms (attempt ${attempt})`);
          setTimeout(() => {
            // Prevent race conditions: if a new socket is already open, do not open another
            if (_ws && _ws.readyState === WebSocket.OPEN) return;
            openSocket();
          }, delay);
        }
      };
    };

    // Avoid opening multiple connections; if open to other room/role, close and reopen
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      const same = (window.__WS_ROOM__ === roomId && window.__WS_ROLE__ === role);
      if (same) {
        window.addLog && window.addLog('warn', `WS already connected (${role})`);
        resolve({ memberId: 'already-open' });
        return;
      }
      try { _ws.close(1000, 'switch-room-or-role'); } catch {}
    }

    openSocket();
  });
}

  /**
   * Sends a JSON message of the specified type over the WebSocket.
   * Optionally includes a payload object.
   * @param {string} type - Message type
   * @param {object} [payload] - Optional message payload
   */
  function wsSend(type, payload) {
    try {
      if (!(_ws && _ws.readyState === WebSocket.OPEN)) return;

      let out;
      if (type === 'ice') {
        // Canonical ICE: {type:'ice', candidate:<RTCIceCandidateInit|null>}
        const cand = (payload && typeof payload === 'object' && 'candidate' in payload)
          ? payload.candidate
          : (payload ?? null);
        out = { type: 'ice', candidate: cand };
      } else if (type === 'offer') {
        // Canonical offer: {type:'offer', sdp:<string>}
        const sdp = (payload && (payload.sdp || payload?.payload?.sdp)) || payload;
        out = { type: 'offer', sdp: typeof sdp === 'string' ? sdp : (sdp?.sdp || '') };
      } else if (type === 'answer') {
        // Canonical answer: {type:'answer', sdp:<string>}
        const sdp = (payload && (payload.sdp || payload?.payload?.sdp)) || payload;
        out = { type: 'answer', sdp: typeof sdp === 'string' ? sdp : (sdp?.sdp || '') };
      } else {
        // Generic: keep legacy payload wrapper for other message types
        out = payload ? { type, payload } : { type };
      }

      try {
        const ids = getIds();
        if (ids.roomId) out.roomId = ids.roomId;
        if (ids.clientId) out.clientId = ids.clientId;
      } catch {}

      _ws.send(JSON.stringify(out));
      try { window.addLog && window.addLog('signal', `send ${type}`); } catch {}
    } catch (e) {
      window.addLog && window.addLog('error', e.message || String(e));
    }
  }

  /**
   * Closes the active WebSocket connection and clears the ping timer.
   */
  function wsClose() {
    try {
      if (_ws) _ws.close();
    } catch {}
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
    _ws = null;
  }

  // Expose the API functions on the window object if not already defined,
  // preserving compatibility with existing index.html scripts.
  try {
    if (typeof window !== 'undefined') {
      if (!window.apiCreateRoom) window.apiCreateRoom = apiCreateRoom;
      if (!window.connectWS)    window.connectWS    = connectWS;
      if (!window.wsSend)       window.wsSend       = wsSend;
      if (!window.wsClose)      window.wsClose      = wsClose;
      if (!window.isWSOpen)     window.isWSOpen     = isWSOpen;
      if (!window.waitWSOpen)  window.waitWSOpen  = waitWSOpen;
      // Internal reference for debugging or advanced usage
      window.__SIGNALING__ = { apiCreateRoom, connectWS, wsSend, wsClose, isWSOpen, waitWSOpen };
    }
  } catch {}
})();
