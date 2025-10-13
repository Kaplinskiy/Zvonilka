// src/main.js
import i18next from 'https://unpkg.com/i18next@23.11.5/dist/esm/i18next.js';
import HttpBackend from 'https://unpkg.com/i18next-http-backend@2.6.2/esm/index.js';
// Import global modules (these attach APIs to the window object)
import './js/helpers.js';
import './js/signaling.js';
import './js/webrtc.js';
import './js/ui.js';

// ---- APPLICATION BOOTSTRAP AND INITIALIZATION ----
const STORAGE_KEY = 'lang';
const SUPPORTED = ['ru', 'en', 'he'];
const FALLBACK = 'en';


/**
 * Detect the preferred language for the user.
 * Checks localStorage, then browser language, then falls back to default.
 * @returns {string} The detected language code.
 */
function detectLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED.includes(saved)) return saved;
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED.includes(nav) ? nav : FALLBACK;
}

/**
 * Set the application's language.
 * Updates localStorage, document direction, i18next, and updates the UI.
 * @param {string} lng - Language code to set.
 */
export async function setLanguage(lng) {
  if (!SUPPORTED.includes(lng)) lng = FALLBACK;
  localStorage.setItem(STORAGE_KEY, lng);
  document.documentElement.dir = (lng === 'he') ? 'rtl' : 'ltr';
  await i18next.changeLanguage(lng);
  applyI18nToDOM();
  renderLangSwitch(lng);
}

/**
 * Apply i18n translations to the DOM.
 * Updates text content, placeholder, and title attributes based on translation keys.
 */
export function applyI18nToDOM() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (k) el.textContent = i18next.t(k);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const k = el.getAttribute('data-i18n-placeholder');
    if (k) el.setAttribute('placeholder', i18next.t(k));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    if (k) el.setAttribute('title', i18next.t(k));
  });
}

/**
 * Initialize the i18n system and set up language switching.
 * Loads translations via HttpBackend.
 */
async function initI18n() {
  const initialLng = detectLang();
  document.documentElement.dir = (initialLng === 'he') ? 'rtl' : 'ltr';

  i18next.on('failedLoading', (lng, ns, msg) => {
    try { console.error('[i18n] failed', lng, ns, msg); } catch {}
  });

  await i18next
    .use(HttpBackend)
    .init({
      lng: initialLng,
      fallbackLng: FALLBACK,
      supportedLngs: SUPPORTED,
      backend: {
        // In production, public is the root. Translation files are located at /i18n/*.json
        loadPath: '/i18n/{{lng}}.json'
      },
      interpolation: { escapeValue: false },
      debug: false
    });

  renderLangSwitch(initialLng);
  applyI18nToDOM();
}

/**
 * Render the language switch buttons.
 * Highlights the active language and attaches click handlers.
 * @param {string} active - The currently active language code.
 */
function renderLangSwitch(active) {
  const root = document.getElementById('lang-switch');
  if (!root) return;
  root.innerHTML = '';
  SUPPORTED.forEach(lng => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-btn' + (lng === active ? ' active' : '');
    btn.textContent = lng.toUpperCase();
    btn.addEventListener('click', () => setLanguage(lng));
    root.appendChild(btn);
  });
}

(function boot() {
  // Prevent multiple initializations of the app.
  if (window.__CALL_APP_LOADED__) return;
  window.__CALL_APP_LOADED__ = true;
  initI18n();

  // --- DOM ELEMENTS ---
  // Cache references to key DOM elements for later use.
  const statusEl = document.getElementById('status');
  const noteEl = document.getElementById('note');
  const roleBadge = document.getElementById('roleBadge');
  const audioEl = document.getElementById('remoteAudio');
  const ledWrap  = document.getElementById('ledBars');
  const callTimerEl = document.getElementById('callTimer');
  const videoWrap = document.getElementById('videoWrap');
  const videoDock = document.getElementById('videoDock');
  const remoteVideo = document.getElementById('remoteVideo');
  const btnVideoToggle = document.getElementById('btnVideoToggle');
  const btnCamFlip = document.getElementById('btnCamFlip');
  const btnMicToggle = document.getElementById('btnMicToggle');

  let __videoMode = false;
  let __camFacing = 'user';
  let __remoteStream = null;

  function bindRemoteStream(s) {
    __remoteStream = s;
    if (__videoMode && remoteVideo) remoteVideo.srcObject = s;
  }

  function setVideoMode(on){
    __videoMode = !!on;
    if (videoWrap) videoWrap.style.display = on ? 'block' : 'none';
    if (videoDock) videoDock.style.display = on ? 'flex' : 'none';
    if (on && remoteVideo && __remoteStream) remoteVideo.srcObject = __remoteStream;
  }

  // Wait until TURN creds are loaded to avoid creating PC with empty ICE config
  async function waitTurnReady(timeoutMs = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const t = window.__TURN__;
        if (t && Array.isArray(t.iceServers) && t.iceServers.length > 0) return true;
      } catch {}
      await new Promise(r => setTimeout(r, 120));
    }
    return false;
  }

  // --- AUDIO VISUALIZER (LED bars only) + CALL TIMER ---
  let __audioViz = { ctx: null, analyser: null, srcNode: null, raf: null };
  let __callTimer = { start: null, int: null };

  function formatDuration(ms){
    const total = Math.max(0, Math.floor(ms/1000));
    const h = Math.floor(total/3600);
    const m = Math.floor((total%3600)/60);
    const s = total%60;
    const pad = (n)=>String(n).padStart(2,'0');
    return h>0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function startCallTimer(){
    if (!callTimerEl) return;
    __callTimer.start = Date.now();
    callTimerEl.textContent = '0:00';
    clearInterval(__callTimer.int);
    __callTimer.int = setInterval(()=>{
      callTimerEl.textContent = formatDuration(Date.now()-__callTimer.start);
    }, 1000);
  }
  function stopCallTimer(){
    clearInterval(__callTimer.int);
    __callTimer.int = null; __callTimer.start = null;
    if (callTimerEl) callTimerEl.textContent = '';
  }

  async function startAudioViz(stream) {
    try {
      if (!stream) return;
      if (__audioViz.ctx) return; // already running
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      try { await ctx.resume?.(); } catch {}
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.minDecibels = -95;
      analyser.maxDecibels = -5;
      analyser.smoothingTimeConstant = 0.7;
      src.connect(analyser);
      __audioViz = { ctx, analyser, srcNode: src, raf: null };

      // Style LED container: one-third width centered
      if (ledWrap) { ledWrap.style.width = '33.33%'; ledWrap.style.margin = '8px auto 0'; }
      if (ledWrap) ledWrap.style.display = 'flex';
      if (callTimerEl) callTimerEl.style.display = 'block';

      const spData = new Uint8Array(analyser.frequencyBinCount);

      function draw(){
        if (ledWrap) {
          const bars = ledWrap.querySelectorAll('.bar');
          if (bars && bars.length) {
            analyser.getByteFrequencyData(spData);
            const seg = Math.floor(spData.length / bars.length);
            for (let i=0;i<bars.length;i++) {
              let sum = 0; for (let j=i*seg; j<(i+1)*seg; j++) sum += spData[j];
              const avg = sum / seg / 255;
              const v = Math.min(1, Math.pow(avg, 0.6) * 1.6);
              bars[i].style.height = Math.round(Math.max(0.08, v) * 100) + '%';
            }
          }
        }
        __audioViz.raf = requestAnimationFrame(draw);
      }
      draw();
      startCallTimer();
    } catch {}
  }

  function stopAudioViz(){
    try { if (__audioViz.raf) cancelAnimationFrame(__audioViz.raf); } catch {}
    try { if (__audioViz.ctx) __audioViz.ctx.close(); } catch {}
    if (ledWrap) ledWrap.style.display = 'none';
    if (callTimerEl) callTimerEl.style.display = 'none';
    __audioViz = { ctx:null, analyser:null, srcNode:null, raf:null };
    stopCallTimer();
  }

  const btnCall = document.getElementById('btnCall');
  const btnAnswer = document.getElementById('btnAnswer');
  const btnHang = document.getElementById('btnHang');

  const shareWrap = document.getElementById('shareWrap');
  const shareLinkEl = document.getElementById('shareLink');
  const btnNativeShare = document.getElementById('btnNativeShare');
  const btnCopy = document.getElementById('btnCopy');
  const btnCopyDiag = document.getElementById('btnCopyDiag');

  // --- GLOBAL HELPERS FROM WINDOW (provide fallbacks if missing) ---
  /**
   * Update the status display in the UI and call any global setStatus if present.
   * @param {string} text - Status message to display.
   * @param {string} cls - CSS class for status pill (e.g., 'ok', 'warn').
   */
  const setStatus = (text, cls) => {
    // 1) Update the local DOM.
    if (statusEl) {
      statusEl.textContent = text;
      const pill = statusEl.closest('.pill') || statusEl.parentElement;
      if (pill && pill.classList) {
        pill.classList.remove('ok', 'warn', 'warn-txt', 'err');
        if (cls) pill.classList.add(cls);
      }
    }
    // 2) Compatibility: also call global setStatus if it exists.
    try {
      if (typeof window.setStatus === 'function') {
        window.setStatus(text, cls);
      }
    } catch (_) {}
  };

  // Persisted status via i18n key + class + extras. Re-applies on language change.
  window.__STATUS = window.__STATUS || { key: null, cls: null, extras: null };
  const setStatusKey = (key, cls, extras) => {
    window.__STATUS = { key: key || null, cls: cls || null, extras: extras || null };
    const txt = key ? i18next.t(key, extras || undefined) : '';
    setStatus(txt, cls);
  };
  window.setStatusKey = setStatusKey;
  if (i18next && typeof i18next.on === 'function') {
    i18next.on('languageChanged', () => {
      try {
        const s = window.__STATUS || {};
        if (s.key) setStatus(i18next.t(s.key, s.extras || undefined), s.cls || undefined);
      } catch {}
    });
  }

  /**
   * Set the user role label (caller or callee) for the UI badge.
   * @param {boolean} isCaller - True if the user is the caller.
   */
  function setRoleLabel(isCaller) {
    if (!roleBadge) return;
    const key = isCaller ? 'role.caller' : 'role.callee';
    roleBadge.setAttribute('data-i18n', key);
    roleBadge.textContent = i18next.t(key);
  }

  // Assign global helpers, falling back to no-ops if not present.
  const renderEnv = window.renderEnv || (() => {});
  const addLog = window.addLog || (() => {});
  const parseRoom = window.parseRoom || (() => new URLSearchParams(location.search).get('roomId'));
  const connectWS = window.connectWS || (async () => {});
  const wsSend = window.wsSend || (() => {});
  const wsClose = window.wsClose || (() => {});
  const isWSOpen = window.isWSOpen || (() => false);
  const waitWSOpen = window.waitWSOpen || (async () => {});
  const apiCreateRoom = window.apiCreateRoom || (async () => { throw new Error('apiCreateRoom missing'); });

  const getMic = window.getMic || (async () => {});
  const createPC = window.createPC || (() => {});
  const acceptIncoming = window.acceptIncoming || (async () => {});
  const applyAnswer = window.applyAnswer || (async () => {});
  const addRemoteIce = window.addRemoteIce || (async () => {});
  const cleanupRTC = window.cleanup || (() => {});

  // --- STATE VARIABLES ---
  // URLs for signaling and WebSocket, configurable via global config.
  const SERVER_URL = (window.__APP_CONFIG__ && window.__APP_CONFIG__.SERVER_URL) || `${location.origin}/signal`;
  const WS_URL = (window.__APP_CONFIG__ && window.__APP_CONFIG__.WS_URL) || `${location.origin.replace(/^http/, 'ws')}/ws`;

  let roomId = null, memberId = null, role = null, pingTimer = null;
  let pendingOffer = null;
  let offerAttempted = false;

  // --- SIGNALING MESSAGE HANDLER ---
  /**
   * Handle incoming signaling messages and update the app state accordingly.
   * @param {object} msg - The signaling message object.
   */
  async function onSignal(msg) {
    try {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'hello': {
          memberId = msg.memberId || memberId;
          setStatusKey('ws.connected_room', 'ok', { room: (roomId || parseRoom() || '-') });
          logT('signal', 'debug.signal_recv_hello');
          // Do NOT send offer on hello; wait for member.joined/peer.joined to ensure the peer is present.
          break;
        }
        case 'member.joined': {
          logT('signal', 'debug.signal_recv_member_joined');
          // IMPORTANT: If we are the initiator (caller), send the offer immediately after the second participant joins.
          // This was previously done by an inline script; now handled here.
          try {
            if (role === 'caller' && !offerAttempted) {
              if (typeof window.sendOfferIfPossible === 'function') {
                await window.sendOfferIfPossible(true); // force
                offerAttempted = true;
                logT('webrtc', 'webrtc.offer_sent_caller');
              } else if (typeof window.createAndSendOffer === 'function') {
                await window.createAndSendOffer();
                offerAttempted = true;
                logT('webrtc', 'webrtc.offer_sent_via_helper');
              } else {
                logT('warn', 'warn.no_offer_sender_impl');
              }
            }
          } catch (e) {
            logT('error', 'error.offer_send_failed', { msg: (e?.message || String(e)) });
          }
          break;
        }
        case 'joined':
        case 'peer.joined': {
          // Already handled by member.joined; avoid double offer
          logT('signal', 'debug.signal_recv_member_joined');
          break;
        }
        case 'offer': {
          logT('signal', 'debug.signal_recv_offer');
          pendingOffer = msg.payload || msg.offer || null;
          // Always show the Answer button; do NOT auto-accept to avoid races
          if (btnAnswer) btnAnswer.classList.remove('hidden');
          if (pendingOffer) {
            setStatusKey('call.offer_received_click_answer', 'warn');
          } else {
            setStatusKey('signal.waiting_offer', 'warn');
          }
          break;
        }
        case 'answer': {
          logT('signal', 'debug.signal_recv_answer');
          const ans = msg.payload || msg.answer;
          if (ans) {
            try { await applyAnswer(ans); }
            catch (e) { logT('error', 'error.apply_answer', { msg: (e?.message || String(e)) }); }
          }
          break;
        }
        case 'ice': {
          // Accept various envelopes: {candidate}, {payload}, raw string, or end-of-candidates
          let cand = undefined;
          if (msg) {
            if (msg.candidate != null) cand = msg.candidate;
            else if (msg.payload != null) cand = msg.payload;
            else if (msg.data != null) cand = msg.data;
          }
          // Unwrap envelopes like {candidate:{...}} that some paths may forward
          if (cand && typeof cand === 'object' && cand.candidate && !cand.sdpMid && !cand.sdpMLineIndex) {
            cand = cand.candidate;
          }
          // Normalize raw string to RTCIceCandidateInit
          if (typeof cand === 'string') cand = { candidate: cand };
          // Signal end-of-candidates to RTCPeerConnection
          if (cand === null || cand === false) {
            // Notify PC that there are no more remote candidates
            try {
              const pc = (window.getPC && window.getPC()) || (window.__WEBRTC__ && window.__WEBRTC__.getPC && window.__WEBRTC__.getPC());
              if (pc && pc.addIceCandidate) await pc.addIceCandidate(null);
            } catch {}
            break;
          }
          if (cand && (typeof cand === 'object')) {
            try { await addRemoteIce(cand); }
            catch (e) { logT('error', 'error.add_remote_ice', { msg: (e?.message || String(e)) }); }
          }
          break;
        }
        case 'bye': {
          logT('signal', 'debug.signal_recv_bye');
          doCleanup('peer-bye');
          break;
        }
        default: break;
      }
    } catch (e) { logT('error', 'onSignal: ' + (e.message || e)); }
  }

  /**
   * Generate and display a shareable room link.
   * @param {string} rid - Room ID to include in the link.
   */
  function shareRoomLink(rid) {
    const safeId = String(rid || '').replace(/[^A-Za-z0-9_-]/g, '');
    const base = location.origin + location.pathname;
    const link = `${base}?roomId=${encodeURIComponent(safeId)}`;
    if (shareLinkEl) shareLinkEl.value = link;
    if (shareWrap) shareWrap.classList.remove('hidden');
  }

  /**
   * Start the caller flow: wait for WebSocket, get microphone, create peer connection.
   */
  async function startCaller() {
    if (waitWSOpen) await waitWSOpen(3000);
    setStatusKey('status.preparing', 'warn-txt');
    btnCall && (btnCall.disabled = true);
    await waitTurnReady();
    await getMic();
    createPC(async (s) => {
      if (audioEl) {
        audioEl.muted = false;
        audioEl.srcObject = s;
        try { await audioEl.play(); } catch {}
      }
      bindRemoteStream(s);
      try { await startAudioViz(s); } catch {}
      logT('webrtc', 'webrtc.remote_track');
    });
    setStatusKey('room.ready_share_link', 'ok');
    if (btnHang) btnHang.disabled = false;
  }

  /**
   * Clean up the call, close connections, reset UI.
   * @param {string} reason - Reason for cleanup, for logging.
   */
  function doCleanup(reason = 'user-hangup') {
    try { wsSend('bye', { reason }); } catch {}
    try { wsClose(); } catch {}
    try { cleanupRTC(reason); } catch {}
    clearInterval(pingTimer);
    stopAudioViz();
    setVideoMode(false);
    __remoteStream = null;
    if (remoteVideo) remoteVideo.srcObject = null;

    // Reset buttons and UI to allow starting a new call immediately.
    if (btnHang) btnHang.disabled = true;
    if (btnCall) {
      btnCall.classList.remove('hidden');
      btnCall.disabled = false;
    }
    if (btnAnswer) btnAnswer.classList.add('hidden');
    if (shareWrap) shareWrap.classList.add('hidden');
    setStatusKey('call.ended', 'warn-txt');
    if (noteEl) noteEl.textContent = '';
    offerAttempted = false;
    role = null; roomId = null;
    // Final guard: ensure Start is visible and enabled
    if (btnCall) { btnCall.classList.remove('hidden'); btnCall.disabled = false; }
    if (btnAnswer) btnAnswer.classList.add('hidden');
  }

  // --- INITIALIZATION BASED ON URL PARAMETERS ---
  /**
   * Initialize the app based on the roomId in the URL, if present.
   * If no roomId, prepare the caller UI; otherwise, connect as callee.
   */
  async function initByUrl() {
    const rid = parseRoom();
    if (!rid) {
      logT('info', 'debug.no_room_param_caller');
      setStatusKey('common.ready', 'ok');
      setRoleLabel(true);
      return;
    }
    role = 'callee';
    roomId = rid;
    roomId = roomId ? String(roomId).replace(/[^A-Za-z0-9_-]/g, '') : roomId;
    await connectWS('callee', roomId, onSignal);
    setRoleLabel(false);
    setStatusKey('ws.waiting_offer', 'ok');
    if (btnAnswer) btnAnswer.classList.remove('hidden');
    if (btnCall) btnCall.classList.add('hidden');
  }

  // --- BUTTON EVENT HANDLERS ---
  // Handler for "Call" button: create a room, connect, and prepare sharing.
  if (btnCall) btnCall.onclick = async () => {
    try {
      btnCall.disabled = true;
      setStatusKey('status.preparing', 'warn');
      const resp = await apiCreateRoom();
      const rawId = (resp && (resp.roomId || resp.room || resp.id)) || null;
      roomId = rawId ? String(rawId).replace(/[^A-Za-z0-9_-]/g, '') : null;
      if (!roomId) {
        setStatus(i18next.t('error.room_create_failed'), 'err');
        btnCall.disabled = false;
        return;
      }
      role = 'caller';
      await connectWS('caller', roomId, onSignal);
      shareRoomLink(roomId);
      await startCaller();
      setStatusKey('room.ready_share_link', 'ok');
      if (btnHang) btnHang.disabled = false;
    } catch (e) {
      setStatus(i18next.t('error.room_create_failed'), 'err');
      logT('error', 'error.room_create_failed');
      if (noteEl) noteEl.textContent = e && e.message ? e.message : String(e);
      btnCall.disabled = false;
    }
  };

  // Handler for "Answer" button: connect as callee and accept incoming offer.
  if (btnAnswer) btnAnswer.onclick = async () => {
    const rid = parseRoom();
    if (!rid) {
      alert(i18next.t('room.open_invite_with_param'));
      logT('warn', 'warn.ws_already_connected_callee');
      return;
    }
    role = 'callee'; roomId = rid;

    if (!isWSOpen()) await connectWS('callee', roomId, onSignal);
    else logT('warn', 'warn.ws_already_connected_callee');

    if (pendingOffer) {
      await waitTurnReady();
      await getMic();
      await acceptIncoming(pendingOffer, async (s) => {
        if (audioEl) {
          audioEl.muted = false;
          audioEl.srcObject = s;
          try { await audioEl.play(); } catch {}
        }
        bindRemoteStream(s);
        try { await startAudioViz(s); } catch {}
        logT('webrtc', 'webrtc.remote_track');
      });
      pendingOffer = null;
      if (btnHang) btnHang.disabled = false;
    } else {
      logT('warn', 'error.btnanswer_no_offer');
      setStatusKey('signal.waiting_offer', 'warn');
    }
  };

  // Handler for "Hang Up" button: clean up the call.
  if (btnHang) btnHang.onclick = () => doCleanup('user-hangup');

  // Handler for "Native Share" button: share the room link using the browser's native share dialog.
  if (btnNativeShare) btnNativeShare.onclick = () => {
    const txt = (shareLinkEl && shareLinkEl.value) || '';
    if (navigator.share) navigator.share({
      title: i18next.t('dialog.invite_title'),
      text: i18next.t('call.offer_received_click_answer') + ' ' + txt,
      url: txt
    }).catch(() => { });
    else if (noteEl) noteEl.textContent = i18next.t('share.native_unavailable');
  };

  // Handler for "Copy Link" button: copy the share link to the clipboard.
  if (btnCopy) btnCopy.onclick = async () => {
    try {
      await navigator.clipboard.writeText((shareLinkEl && shareLinkEl.value) || '');
      if (noteEl) noteEl.textContent = i18next.t('common.link_copied');
    } catch {
      if (noteEl) noteEl.textContent = i18next.t('common.will_be_generated');
    }
  };

  // Handler for "Copy Diagnostics" button: copy diagnostic info to the clipboard.
  if (btnCopyDiag) btnCopyDiag.onclick = async () => {
    const report = [
      '=== DIAG REPORT ===',
      'url: ' + location.href,
      'secure: ' + window.isSecureContext,
      'protocol: ' + location.protocol,
      'ua: ' + navigator.userAgent,
      'getUserMedia: ' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      'RTCPeerConnection: ' + (typeof RTCPeerConnection),
      'server: ' + SERVER_URL,
      'ws: ' + WS_URL,
      'room: ' + (roomId || parseRoom() || '-')
    ].join('\n');
    try { await navigator.clipboard.writeText(report); } catch { alert(report); }
  };

  // --- APPLICATION BOOTSTRAP SEQUENCE ---

  if (btnVideoToggle) btnVideoToggle.onclick = () => {
    setVideoMode(!__videoMode);
  };

  if (btnCamFlip) btnCamFlip.onclick = () => {
    __camFacing = (__camFacing === 'user') ? 'environment' : 'user';
    if (noteEl) noteEl.textContent = 'camera: ' + __camFacing;
  };

  if (btnMicToggle) btnMicToggle.onclick = () => {
    if (audioEl) audioEl.muted = !audioEl.muted;
    if (noteEl) noteEl.textContent = audioEl && audioEl.muted
      ? i18next.t('call.ended')
      : i18next.t('common.ready');
  };

  setStatusKey('status.initializing');
  try { renderEnv(); } catch {}
  logT('info', 'dev.client_loaded_vite');
  initByUrl();

  // Set initial visibility of buttons on page load based on room presence.
  if (!parseRoom()) {
    if (btnCall) btnCall.classList.remove('hidden');
    if (btnAnswer) btnAnswer.classList.add('hidden');
    if (shareWrap) shareWrap.classList.add('hidden');
  } else {
    if (btnCall) btnCall.classList.add('hidden');
    if (btnAnswer) btnAnswer.classList.remove('hidden');
    if (shareWrap) shareWrap.classList.add('hidden');
  }
})();