
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

  async function autoAnswerIfReady() {
    try {
      if (role !== 'callee') return;
      if (answerInProgress) return;
      const offer = pendingOffer || window.__PENDING_OFFER || window.__LAST_OFFER || null;
      if (!offer) return;
      if (!(window.ws && window.ws.readyState === 1)) return; // ждём OPEN

      // ensure TURN + mic + PC
      try { await (window.__TURN_PROMISE__ || Promise.resolve()); } catch {}
      await waitTurnReady();
      await getMic();
      if (!window.getPC || !window.getPC()) {
        await createPC(async (s) => {
          if (audioEl) { audioEl.muted = false; audioEl.srcObject = s; try { await audioEl.play(); } catch {} }
          bindRemoteStream(s);
          try { await startAudioViz(s); } catch {}
          logT('webrtc', 'webrtc.remote_track');
        });
      }

      answerInProgress = true;
      await acceptIncoming(offer, async (s) => {
        if (audioEl) { audioEl.muted = false; audioEl.srcObject = s; try { await audioEl.play(); } catch {} }
        bindRemoteStream(s);
        try { await startAudioViz(s); } catch {}
        logT('webrtc', 'webrtc.remote_track');
      });
      pendingOffer = null; window.__PENDING_OFFER = null;
      if (btnHang) btnHang.disabled = false;
    } catch (e) {
      try { console.warn('[AUTO-ANSWER] failed', e && (e.message || String(e))); } catch {}
    } finally {
      answerInProgress = false;
    }
  }

  function setVideoMode(on){
    __videoMode = !!on;
    if (videoWrap) videoWrap.style.display = on ? 'block' : 'none';
    if (videoDock) videoDock.style.display = on ? 'flex' : 'none';
    if (on && remoteVideo && __remoteStream) remoteVideo.srcObject = __remoteStream;
  }

  // --- LOCAL MIC CONTROL (toggle sender.track.enabled) ---
  function getLocalAudioSender() {
    try {
      const pc = (window.getPC && window.getPC());
      if (!pc || !pc.getSenders) return null;
      return pc.getSenders().find(s => s && s.track && s.track.kind === 'audio') || null;
    } catch { return null; }
  }
  function setLocalMicMuted(muted) {
    try {
      const s = getLocalAudioSender();
      if (s && s.track) s.track.enabled = !muted;
      if (noteEl) noteEl.textContent = muted ? i18next.t('call.mic_muted') : i18next.t('common.ready');
      if (btnMicToggle) btnMicToggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
    } catch {}
  }
  function getLocalMicMuted() {
    const s = getLocalAudioSender();
    return !s || !s.track ? false : (s.track.enabled === false);
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

  // --- HANG BUTTON SIZING ---
  function setHangBig(on = true) {
    if (!btnHang) return;
    try {
      if (on) {
        btnHang.style.width = '100%';
        btnHang.style.height = '56px';
        btnHang.style.fontSize = '18px';
      } else {
        btnHang.style.width = '';
        btnHang.style.height = '';
        btnHang.style.fontSize = '';
      }
    } catch {}
  }

  // --- IN-CALL UI FLIP HELPER ---
  function flipInCallUI() {
    try {
      setStatusKey('status.in_call', 'ok');
      if (btnCall) btnCall.classList.add('hidden');
      if (btnAnswer) btnAnswer.classList.add('hidden');
      if (btnHang) btnHang.disabled = false;
      if (btnMicToggle) btnMicToggle.disabled = false;
      setHangBig(true);
      if (shareWrap) shareWrap.classList.add('hidden');
      const s = (audioEl && audioEl.srcObject) || (__remoteStream || null);
      if (s) startAudioViz(s);
      if (audioEl) { audioEl.muted = false; try { audioEl.play(); } catch {} }
      window.__PC_UI_FLIPPED__ = true;
    } catch {}
  }

  // --- WATCH PEER CONNECTION STATE → DRIVE UI ---
  function installPcStateWatch() {
    try {
      const pc = (window.getPC && window.getPC());
      if (!pc) return;
      // Rebind handlers if PC changed
      if (window.__PC_WATCH_PC__ === pc) return;
      window.__PC_WATCH_PC__ = pc;

      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        try { addLog('webrtc', 'oniceconnectionstatechange:' + st); } catch {}
        if (st === 'connected') {
          flipInCallUI();
        } else if (st === 'disconnected' || st === 'failed') {
          setStatusKey('call.ended', 'warn-txt');
        }
      };

      pc.onconnectionstatechange = () => {
        const cs = pc.connectionState;
        try { addLog('webrtc', 'connection=' + cs); } catch {}
        if (cs === 'connected') {
          flipInCallUI();
        }
      };

      // Immediate one-shot check in case PC is already connected when watcher attaches
      try {
        if ((pc.iceConnectionState === 'connected' || pc.connectionState === 'connected') && !window.__PC_UI_FLIPPED__) {
          flipInCallUI();
        }
      } catch {}

    } catch {}
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
  // expose role to webrtc (it reads window.role)
  window.role = null;
  window.__ALLOW_OFFER__ = false;
  window.__CLIENT_ID = (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
let pendingOffer = null;
let answerInProgress = false;
let offerAttempted = false;
let calleeArmed = false;
let hangInProgress = false;

  // Direct one-shot initial offer sender (avoids timeouts in trigger)
  async function sendInitialOfferOnce(maxWaitMs = 3000) {
    // 1) ensure WS is OPEN
    try { await (typeof waitWSOpen === 'function' ? waitWSOpen(1500) : Promise.resolve()); } catch {}
    // 2) wait briefly until PC is stable or has local offer
    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
      const pc = (window.getPC && window.getPC());
      const st = pc && pc.signalingState;
      if (pc && (st === 'stable' || st === 'have-local-offer' || !st)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    // 3) send offer once
    if (typeof window.sendOfferIfPossible === 'function') {
      console.debug('[CALLER] direct sendOfferIfPossible()');
      await window.sendOfferIfPossible();
      return true;
    }
    console.warn('[CALLER] sendOfferIfPossible missing');
    return false;
  }

  // Trigger offer only when WS is open and PC exists; retry with backoff for a short window
  async function triggerOfferWhenReady(maxMs = 10000) {
    const t0 = Date.now();
    let pcCreatedOnce = false;
    while (Date.now() - t0 < maxMs) {
      try {
        // ensure WS open
        if (!(window.ws && window.ws.readyState === 1)) {
          if (typeof waitWSOpen === 'function') {
            try { await waitWSOpen(800); } catch {}
          } else {
            await new Promise(r => setTimeout(r, 120));
          }
        }
        const wsReadyNow = !!(window.ws && window.ws.readyState === 1);
        // ensure PC exists
        let pc = (window.getPC && window.getPC());
        if (!pc && !pcCreatedOnce && typeof createPC === 'function') {
          try { console.debug('[OFFER-TRIGGER] creating PC on demand'); createPC(() => {}); pcCreatedOnce = true; } catch {}
          pc = (window.getPC && window.getPC());
        }
        const stable = pc && (!pc.signalingState || pc.signalingState === 'stable' || pc.signalingState === 'have-local-offer');
        if (wsReadyNow && pc && stable) {
          if (typeof window.sendOfferIfPossible === 'function') {
            console.debug('[OFFER-TRIGGER] wsReady, pc ready (state=', pc.signalingState, ') → sendOfferIfPossible');
            await window.sendOfferIfPossible();
          }
          return true;
        }
        // progress log every ~500ms
        if ((Date.now() - t0) % 600 < 150) {
          console.debug('[OFFER-TRIGGER] wait ws=', wsReadyNow, 'pc=', !!pc, 'state=', pc && pc.signalingState);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    console.warn('[OFFER-TRIGGER] timeout waiting ws/pc');
    return false;
  }

  // install a verbose WS send wrapper once
  if (!window.__WS_SEND_WRAPPED && typeof window.wsSend === 'function') {
    window.__WS_SEND_WRAPPED = true;
    const __origSend = window.wsSend;
    window.wsSend = function(type, payload){
      try { console.debug('[WS-OUT]', type, 'ready=', window.ws && window.ws.readyState, payload && (payload.type||'obj')); } catch{}
      return __origSend.apply(this, arguments);
    };
  }

  // optional: log all inbound signaling messages
  if (!window.__SIG_HOOK) {
    window.__SIG_HOOK = (m)=>{ try{ if(m&&m.type) console.debug('[SIG<-SERVER]', m.type, m); }catch{} };
  }

  // Guard duplicate or wrong-role offer attempts: wrap only if real impl exists
  (function guardOfferOnce(){
    const origSendInit = window.sendOfferIfPossible;
    if (typeof origSendInit !== 'function') {
      // No real implementation yet; do not override to avoid no-op.
      return;
    }
    window.sendOfferIfPossible = async function(){
      // Only caller is allowed to send an offer
      if (role !== 'caller') { try{ console.debug('[OFFER-GUARD] block:not-caller role=', role); }catch{}; return; }
      const pc = (window.getPC && window.getPC()) || (window.__WEBRTC__ && window.__WEBRTC__.getPC && window.__WEBRTC__.getPC());
      const st = pc && pc.signalingState;
      if (offerAttempted) { try{ console.debug('[OFFER-GUARD] block:already-attempted'); }catch{}; return; }
      if (st && st !== 'stable') { try{ console.debug('[OFFER-GUARD] block:state=', st); }catch{}; return; }
      const r = await origSendInit();
      offerAttempted = true;
      return r;
    };
  })();

  // --- SIGNALING MESSAGE HANDLER ---
  /**
   * Handle incoming signaling messages and update the app state accordingly.
   * @param {object} msg - The signaling message object.
   */
  async function onSignal(msg) {
    try {
      try { window.__SIG_HOOK && window.__SIG_HOOK(msg); } catch {}
      if (!msg || typeof msg !== 'object') return;
      // Normalize alias types from server so ICE always goes through one path
      try {
        if (msg && typeof msg.type === 'string') {
          const t = msg.type.toLowerCase();
          if (t === 'candidate' || t === 'icecandidate') msg.type = 'ice';
        }
      } catch {}
      switch (msg.type) {
        case 'hello': {
          memberId = msg.memberId || memberId;
          setStatusKey('ws.connected_room', 'ok', { room: (roomId || parseRoom() || '-') });
          logT('signal', 'debug.signal_recv_hello');
          // Wait explicitly for WS to be OPEN and log state
          try {
            await (typeof waitWSOpen === 'function' ? waitWSOpen(1500) : Promise.resolve());
            console.debug('[HELLO] wsReady=', !!(window.ws && window.ws.readyState === 1));
          } catch {}
          // ensure role is visible to webrtc layer
          if (!role && typeof msg.role === 'string') {
            role = msg.role; window.role = role; setRoleLabel(role === 'caller');
            try { console.debug('[HELLO] role set from server =', role); } catch {}
          }
          // Auto-answer call removed as requested
          break;
        }
        case 'member.joined': {
          try {
            console.log('[DEBUG] member.joined, role=', role);
            logT('signal', 'debug.signal_recv_member_joined');
            if (typeof role === 'string' && role !== 'caller') { break; }
            // caller: ждём явного сигнала 'ready' от callee; не готовим PC/медиа здесь
            try { window.__OFFER_SENT__ = false; } catch {}
            offerAttempted = false;
            // ждём явного сигнала 'ready' от callee; оффер уйдёт в case 'ready'
          } catch (e) {
            logT('error', 'error.offer_send_failed', { msg: (e?.message || String(e)) });
          }
          break;
        }
        case 'ready': {
          if (role !== 'caller') { break; }
          try {
            if (typeof window.loadTurnConfig === 'function') {
              try { await window.loadTurnConfig(true); } catch {}
            }
            window.__ALLOW_OFFER__ = true;
            await waitTurnReady();
            await getMic();
            if (!window.getPC || !window.getPC()) {
              await createPC(async (s) => {
                if (audioEl) { audioEl.muted = false; audioEl.srcObject = s; try { await audioEl.play(); } catch {} }
                bindRemoteStream(s);
                try { await startAudioViz(s); } catch {}
                logT('webrtc','webrtc.remote_track');
              });
            }
            installPcStateWatch();
            offerAttempted = false;
            await window.sendOfferIfPossible();
            logT('webrtc','webrtc.offer_sent_caller');
          } catch (e) {
            logT('error','error.offer_send_failed',{ msg: (e?.message||String(e)) });
          }
          break;
        }
        case 'offer': {
          logT('signal', 'debug.signal_recv_offer');
          // If we are also a caller, ignore incoming offer to avoid glare
          if (role === 'caller') { logT('warn', 'warn.ignore_offer_on_caller'); break; }
          // Normalize {type:'offer', sdp} or legacy {payload|offer}
          const _sdp = msg?.sdp || msg?.payload?.sdp || null;
          pendingOffer = _sdp ? { type: 'offer', sdp: _sdp } : (msg.payload || msg.offer || null);
          window.__PENDING_OFFER = pendingOffer;
          window.__LAST_OFFER = pendingOffer; // debug: allow manual accept from console

          // показать кнопку; если callee нажал "Начать разговор" — принять сразу
          if (btnAnswer) btnAnswer.classList.remove('hidden');
          if (calleeArmed) {
            try {
              if (typeof window.loadTurnConfig === 'function') {
                try { await window.loadTurnConfig(true); } catch {}
              }
              await waitTurnReady();
              await getMic();
              if (!window.getPC || !window.getPC()) {
                await createPC(async (s) => {
                  if (audioEl) { audioEl.muted = false; audioEl.srcObject = s; try { await audioEl.play(); } catch {} }
                  bindRemoteStream(s);
                  try { await startAudioViz(s); } catch {}
                  logT('webrtc','webrtc.remote_track');
                });
                installPcStateWatch();
              }
              await acceptIncoming(pendingOffer, async (s) => {
                if (audioEl) { audioEl.muted = false; audioEl.srcObject = s; try { await audioEl.play(); } catch {} }
                bindRemoteStream(s);
                try { await startAudioViz(s); } catch {}
                logT('webrtc','webrtc.remote_track');
              });
              setHangBig(true);
              // Flush any ICE buffered before remoteDescription was applied (callee)
              try {
                const buf = Array.isArray(window.__REMOTE_ICE_Q) ? window.__REMOTE_ICE_Q.splice(0) : [];
                for (const c of buf) {
                  try { await addRemoteIce(c); } catch {}
                }
              } catch {}
              // Apply buffered end-of-candidates marker once (callee)
              try {
                if (Array.isArray(window.__REMOTE_ICE_Q)) {
                  const hadEoc = window.__REMOTE_ICE_Q.includes(null);
                  window.__REMOTE_ICE_Q = window.__REMOTE_ICE_Q.filter(x => x !== null);
                  if (hadEoc) {
                    const pc2 = (window.getPC && window.getPC());
                    if (pc2 && pc2.addIceCandidate) await pc2.addIceCandidate(null);
                  }
                }
              } catch {}
              pendingOffer = null;
              if (btnHang) btnHang.disabled = false;
              setStatusKey('common.ready', 'ok');
            } catch (e) {
              console.warn('[CALLEE] accept failed', e && (e.message || String(e)));
              setStatusKey('signal.waiting_offer', 'warn');
            }
          } else {
            setStatusKey('call.offer_received_click_answer', 'warn');
          }
          break;
        }
        case 'answer': {
          logT('signal', 'debug.signal_recv_answer');
          // Normalize incoming payload: support {type:'answer', sdp} or legacy {payload|answer}
          const sdp =
            (msg && (msg.sdp ||
                     (msg.payload && msg.payload.sdp) ||
                     (msg.answer && msg.answer.sdp))) || '';
          if (!sdp) { console.warn('[SIGNAL] answer without sdp'); break; }
          if (role !== 'caller') { break; } // callee never applies answer
          try {
            let pc = (window.getPC && window.getPC()) || (window.__WEBRTC__ && window.__WEBRTC__.getPC && window.__WEBRTC__.getPC());
            if (!pc && typeof createPC === 'function') {
              await createPC(() => {});
              pc = (window.getPC && window.getPC());
            }
            if (!pc) { console.warn('[SIGNAL] no PC to apply answer'); break; }
            const st = pc.signalingState;
            if (!(st === 'have-local-offer' || st === 'stable')) {
              console.warn('[SIGNAL] answer ignored: signalingState=', st);
              break;
            }
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
            // Flush any ICE buffered before remoteDescription was applied
            try {
              const buf = Array.isArray(window.__REMOTE_ICE_Q) ? window.__REMOTE_ICE_Q.splice(0) : [];
              for (const c of buf) {
                try { await addRemoteIce(c); } catch {}
              }
            } catch {}
            // Apply buffered end-of-candidates marker once
            try {
              if (Array.isArray(window.__REMOTE_ICE_Q)) {
                const hadEoc = window.__REMOTE_ICE_Q.includes(null);
                // clear all occurrences
                window.__REMOTE_ICE_Q = window.__REMOTE_ICE_Q.filter(x => x !== null);
                if (hadEoc) {
                  const pc2 = (window.getPC && window.getPC());
                  if (pc2 && pc2.addIceCandidate) await pc2.addIceCandidate(null);
                }
              }
            } catch {}
            // Ensure caller UI is flipped to in-call after SDP answer is applied
            try { if (!window.__PC_UI_FLIPPED__) flipInCallUI(); } catch {}
            try { console.log('[SIGNAL] setRemoteDescription(answer) ok; signalingState=', pc.signalingState); } catch {}
          } catch (e) {
            console.error('[SIGNAL] apply answer failed', e && (e.message || String(e)));
          }
          break;
        }
        case 'renegotiate': {
          try {
            logT('signal', 'debug.signal_recv_renegotiate');
            if (role !== 'caller') { break; }
            await waitTurnReady();
            await getMic();
            // ensure we can send a new offer
            try { window.__OFFER_SENT__ = false; } catch {}
            offerAttempted = false;
            // ensure PC is stable before offering
            try {
              const t0 = Date.now();
              while (Date.now() - t0 < 2000) {
                const pcw = (window.getPC && window.getPC());
                if (pcw && (!pcw.signalingState || pcw.signalingState === 'stable')) break;
                await new Promise(r => setTimeout(r, 80));
              }
            } catch {}
            if (typeof window.sendOfferIfNeededAfterStable === 'function') {
              await window.sendOfferIfNeededAfterStable();
              logT('webrtc', 'webrtc.offer_sent_caller');
            } else if (typeof window.sendOfferIfPossible === 'function') {
              await window.sendOfferIfPossible();
              logT('webrtc', 'webrtc.offer_sent_caller');
            } else {
              const pc = (window.getPC && window.getPC());
              if (!pc) break;
              const offer = await pc.createOffer({ offerToReceiveAudio: 1 });
              await pc.setLocalDescription(offer);
              const payload = { type: 'offer', sdp: offer.sdp, offer: { type: 'offer', sdp: offer.sdp } };
              if (typeof window.wsSend === 'function') window.wsSend('offer', payload);
              logT('webrtc', 'webrtc.offer_sent_caller');
              try { window.__OFFER_SENT__ = true; } catch {}
            }
          } catch (e) {
            logT('error', 'error.offer_send_failed', { msg: (e?.message || String(e)) });
          }
          break;
        }
        case 'ice': {
          try { console.debug('[ICE-IN]', msg); } catch {}
          // Normalize various envelopes: {candidate}, {payload:{candidate}}, raw string, or end-of-candidates
          let cand = undefined;
          if (msg) {
            cand = (
              (msg.candidate !== undefined ? msg.candidate : undefined) ??
              (msg.payload && (msg.payload.candidate !== undefined ? msg.payload.candidate : msg.payload)) ??
              (msg.data !== undefined ? msg.data : undefined) ??
              null
            );
          }

          // End-of-candidates marker: buffer EOC; apply after remoteDescription + real ICE flushed
          if (cand === null || cand === false) {
            window.__REMOTE_ICE_Q = Array.isArray(window.__REMOTE_ICE_Q) ? window.__REMOTE_ICE_Q : [];
            window.__REMOTE_ICE_Q.push(null);
            break;
          }

          // String -> RTCIceCandidateInit
          if (typeof cand === 'string') cand = { candidate: cand };

          // If remoteDescription is not yet applied, buffer into the shared queue
          try {
            const pcw = (window.getPC && window.getPC());
            if (!pcw || !pcw.remoteDescription) {
              window.__REMOTE_ICE_Q = Array.isArray(window.__REMOTE_ICE_Q) ? window.__REMOTE_ICE_Q : [];
              window.__REMOTE_ICE_Q.push(cand);
              break;
            }
          } catch {}

          if (cand && typeof cand === 'object') {
            try { await addRemoteIce(cand); }
            catch (e) { logT('error', 'error.add_remote_ice', { msg: (e?.message || String(e)) }); }
          }
          break;
        }
        case 'bye': {
          logT('signal', 'debug.signal_recv_bye');
          try { console.debug('[BYE-IN]'); } catch {}
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
    // Ensure TURN creds loaded before any PC creation
    try { await (window.__TURN_PROMISE__ || Promise.resolve()); } catch {}
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
    installPcStateWatch();
    // Removed: setStatusKey('room.ready_share_link', 'ok');
    if (btnHang) btnHang.disabled = false;
    if (btnMicToggle) btnMicToggle.disabled = false;
  }

  /**
   * Clean up the call, close connections, reset UI.
   * @param {string} reason - Reason for cleanup, for logging.
   */
  function doCleanup(reason = 'user-hangup') {
    try { window.__OFFER_SENT__ = false; } catch {}
    // reset session gates and TURN cache
    try { window.__ALLOW_OFFER__ = false; } catch {}
    try { delete window.__TURN__; delete window.__TURN_PROMISE__; } catch {}
    calleeArmed = false;
    pendingOffer = null;
    // Guard: ignore premature peer-bye while PC not established
    // в main.js, в начале doCleanup
    console.debug('[CLEANUP]', reason,
      'sig=', window.getPC()?.signalingState,
      'ice=', window.getPC()?.iceConnectionState,
      'conn=', window.getPC()?.connectionState);
    try {
      const pc = (window.getPC && window.getPC()) || (window.__WEBRTC__ && window.__WEBRTC__.getPC && window.__WEBRTC__.getPC());
      const ice = pc && pc.iceConnectionState;
      const conn = pc && pc.connectionState;
      const sig = pc && pc.signalingState;
      if (reason === 'peer-bye' && pc && (ice === 'new' || conn === 'new' || sig === 'new' || sig === 'have-local-offer')) {
        // ignore spurious bye during setup; do not teardown UI
        return;
      }
    } catch {}
    // Do not echo bye if we are handling a peer-bye
    if (reason !== 'peer-bye') { try { wsSend('bye', { reason }); } catch {} }
    try { wsClose(); } catch {}
    try { cleanupRTC(reason); } catch {}
    clearInterval(pingTimer);
    stopAudioViz();
    try { setLocalMicMuted(false); } catch {}
    if (btnMicToggle) btnMicToggle.disabled = true;
    setVideoMode(false);
    __remoteStream = null;
    // stop PC watchdog to avoid late UI flips after hangup
    try { if (window.__PC_WATCHDOG__) { clearInterval(window.__PC_WATCHDOG__); delete window.__PC_WATCHDOG__; } } catch {}
    if (remoteVideo) remoteVideo.srcObject = null;

    // Reset buttons and UI to allow starting a new call immediately.
    if (btnHang) btnHang.disabled = true;
    if (btnCall) {
      btnCall.classList.remove('hidden');
      btnCall.disabled = false;
    }
    if (btnAnswer) btnAnswer.classList.add('hidden');
    if (shareWrap) shareWrap.classList.add('hidden');
    setHangBig(false);
    const peerEnded = (reason === 'peer-bye');
    setStatusKey(peerEnded ? 'call.ended_by_peer' : 'call.ended', peerEnded ? 'ok' : 'warn-txt');
    if (noteEl) noteEl.textContent = '';
    offerAttempted = false;
    role = null; roomId = null;
    // Final guard: ensure Start is visible and enabled
    if (btnCall) { btnCall.classList.remove('hidden'); btnCall.disabled = false; }
    if (btnAnswer) btnAnswer.classList.add('hidden');
    // allow re-binding state watchers for next call
    try { delete window.__PC_WATCH_PC__; } catch {}
    try { window.__PC_UI_FLIPPED__ = false; } catch {}
    try { window.__PC_UI_FLIPPED__ = false; } catch {}
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
    // Callee auto-init
    role = 'callee'; window.role = 'callee';
    roomId = String(rid).replace(/[^A-Za-z0-9_-]/g, '');
    setRoleLabel(false);
    if (btnAnswer) btnAnswer.classList.remove('hidden');
    if (btnCall)   btnCall.classList.add('hidden');
    setStatusKey('ws.waiting_offer', 'ok');

    // Ensure WS is connected for callee and try immediate auto-answer if offer already arrived
    try {
      if (!isWSOpen()) await connectWS('callee', roomId, onSignal);
      // If TURN loader exists, kick it so we don't create PC with empty ICE later
      try { await (window.__TURN_PROMISE__ || Promise.resolve()); } catch {}
      // ждать оффер от caller; ответ пойдёт после нажатия кнопки или сигнала 'ready'
      setStatusKey('signal.waiting_offer', 'warn');
    } catch (e) {
      try { console.warn('[INIT callee] failed to connect/auto-answer:', e && (e.message || String(e))); } catch {}
    }
  }

  // --- BUTTON EVENT HANDLERS ---
  // Handler for "Call" button: create a room, connect, and prepare sharing.
  // === CALLER: создать комнату и стартовать звонок ===
  if (btnCall) btnCall.onclick = async () => {
    try {
      role = 'caller'; window.role = 'caller';
      setStatusKey('status.preparing', 'warn');
      btnCall.disabled = true;

      // 1) создать комнату
      const { roomId } = await apiCreateRoom();
      if (!roomId) throw new Error('room create failed');
      // показать ссылку
      shareRoomLink(roomId);

      // 2) подключить WS
      await connectWS('caller', roomId, onSignal);

      if (btnHang) btnHang.disabled = false;
      // Removed: setStatusKey('room.ready_share_link', 'ok');
    } catch (e) {
      console.warn('[CALLER] start failed:', e && (e.message || String(e)));
      setStatusKey(i18next.t('error.room_create_failed'), 'err');
      btnCall.disabled = false;
    }
  };

  if (btnAnswer) btnAnswer.onclick = async () => {
    const rid = parseRoom();
    if (!rid) {
      alert(i18next.t('room.open_invite_with_param'));
      logT('warn', 'warn.ws_already_connected_callee');
      return;
    }
    role = 'callee'; window.role = 'callee'; roomId = rid;
    if (!isWSOpen()) await connectWS('callee', roomId, onSignal);
    if (typeof window.loadTurnConfig === 'function') {
      try { await window.loadTurnConfig(true); } catch {}
    }
    await waitTurnReady();
    calleeArmed = true;
    setStatusKey('signal.waiting_offer', 'warn');
    try { wsSend('ready', { roomId, clientId: window.__CLIENT_ID }); } catch {}
  };

  // Handler for "Hang Up" button: clean up the call, single-shot and disables button immediately.
  if (btnHang) btnHang.onclick = () => {
    if (hangInProgress) return;
    hangInProgress = true;
    try { btnHang.disabled = true; } catch {}
    doCleanup('user-hangup');
    // allow subsequent calls after UI resets
    setTimeout(() => { hangInProgress = false; }, 1200);
  };

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
    const next = !getLocalMicMuted();
    setLocalMicMuted(next);
  };

  window.addEventListener('beforeunload', () => {
    try { wsSend('bye', { reason: 'page-unload', roomId, clientId: window.__CLIENT_ID }); } catch {}
    try { wsClose(); } catch {}
    try { cleanupRTC('unload'); } catch {}
    try { delete window.__TURN__; delete window.__TURN_PROMISE__; } catch {}
    window.__ALLOW_OFFER__ = false;
  });
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
