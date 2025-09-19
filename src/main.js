// src/main.js
import i18next from 'https://unpkg.com/i18next@23.11.5/dist/esm/i18next.js';
import HttpBackend from 'https://unpkg.com/i18next-http-backend@2.6.2/esm/index.js';
// Глобальные модули (они вешают API на window.*)
import './js/helpers.js';
import './js/signaling.js';
import './js/webrtc.js';
import './js/ui.js';

// ---- BOOTSTRAP ----
const STORAGE_KEY = 'lang';
const SUPPORTED = ['ru','en','he'];
const FALLBACK = 'en';

function detectLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED.includes(saved)) return saved;
  const nav = (navigator.language || 'en').slice(0,2).toLowerCase();
  return SUPPORTED.includes(nav) ? nav : FALLBACK;
}

export async function setLanguage(lng) {
  if (!SUPPORTED.includes(lng)) lng = FALLBACK;
  localStorage.setItem(STORAGE_KEY, lng);
  document.documentElement.dir = (lng === 'he') ? 'rtl' : 'ltr';
  await i18next.changeLanguage(lng);
  applyI18nToDOM();
  renderLangSwitch(lng);
}

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
        // В проде public = корень. Файлы лежат по /i18n/*.json
        loadPath: '/i18n/{{lng}}.json'
      },
      interpolation: { escapeValue: false },
      debug: false
    });

  renderLangSwitch(initialLng);
  applyI18nToDOM();
}

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
  if (window.__CALL_APP_LOADED__) return;
  window.__CALL_APP_LOADED__ = true;
  initI18n();

  // --- DOM ---
  const statusEl = document.getElementById('status');
  const noteEl   = document.getElementById('note');
  const roleBadge = document.getElementById('roleBadge');
  const audioEl  = document.getElementById('remoteAudio');

  const btnCall   = document.getElementById('btnCall');
  const btnAnswer = document.getElementById('btnAnswer');
  const btnHang   = document.getElementById('btnHang');

  const shareWrap   = document.getElementById('shareWrap');
  const shareLinkEl = document.getElementById('shareLink');
  const btnNativeShare = document.getElementById('btnNativeShare');
  const btnCopy        = document.getElementById('btnCopy');
  const btnCopyDiag    = document.getElementById('btnCopyDiag');

  // --- Helpers from window (защита от отсутствия) ---
  const setStatus = (text, cls) => {
    // 1) Локально обновляем DOM
    if (statusEl) {
      statusEl.textContent = text;
      const pill = statusEl.closest('.pill') || statusEl.parentElement;
      if (pill && pill.classList) {
        pill.classList.remove('ok','warn','warn-txt','err');
        if (cls) pill.classList.add(cls);
      }
    }
    // 2) Совместимость: если есть глобальный setStatus — дергаем его тоже
    try {
      if (typeof window.setStatus === 'function') {
        window.setStatus(text, cls);
      }
    } catch (_) {}
  };
  function setRoleLabel(isCaller) {
    if (!roleBadge) return;
    const key = isCaller ? 'role.caller' : 'role.callee';
    roleBadge.setAttribute('data-i18n', key);
    roleBadge.textContent = i18next.t(key);
  }
  const renderEnv   = window.renderEnv   || (()=>{});
  const addLog      = window.addLog      || (()=>{});
  const parseRoom   = window.parseRoom   || (() => new URLSearchParams(location.search).get('room'));
  const connectWS   = window.connectWS   || (async()=>{});
  const wsSend      = window.wsSend      || (()=>{});
  const wsClose     = window.wsClose     || (()=>{});
  const isWSOpen    = window.isWSOpen    || (()=>false);
  const waitWSOpen  = window.waitWSOpen  || (async()=>{});
  const apiCreateRoom = window.apiCreateRoom || (async()=>{ throw new Error('apiCreateRoom missing'); });

  const getMic      = window.getMic      || (async()=>{});
  const createPC    = window.createPC    || (()=>{});
  const acceptIncoming = window.acceptIncoming || (async()=>{});
  const applyAnswer = window.applyAnswer || (async()=>{});
  const addRemoteIce = window.addRemoteIce || (async()=>{});
  const cleanupRTC  = window.cleanup     || (()=>{});

  // --- State ---
  const SERVER_URL = (window.__APP_CONFIG__ && window.__APP_CONFIG__.SERVER_URL) || `${location.origin}/signal`;
  const WS_URL     = (window.__APP_CONFIG__ && window.__APP_CONFIG__.WS_URL)     || `${location.origin.replace(/^http/,'ws')}/ws`;

  let roomId=null, memberId=null, role=null, pingTimer=null;
  let pendingOffer=null;

  // --- Signaling message handler ---
  async function onSignal(msg){
    try{
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type){
        case 'hello': {
          memberId = msg.memberId || memberId;
          setStatus(i18next.t('ws.connected_room', { room: (roomId||parseRoom()||'-') }), 'ok');
          logT('signal','debug.signal_recv_hello');
          break;
        }
        case 'member.joined': {
          logT('signal','debug.signal_recv_member_joined');
          // ВАЖНО: если мы инициатор (caller), отправляем оффер сразу после входа второго участника.
          // Раньше это делал инлайн-скрипт; после рефакторинга вызов потерялся.
          try {
            if (role === 'caller') {
              if (typeof window.sendOfferIfPossible === 'function') {
                await window.sendOfferIfPossible(true); // force
                logT('webrtc','webrtc.offer_sent_caller');
              } else if (typeof window.createAndSendOffer === 'function') {
                await window.createAndSendOffer();
                logT('webrtc','webrtc.offer_sent_via_helper');
              } else {
                logT('warn','warn.no_offer_sender_impl');
              }
            }
          } catch (e) {
            logT('error','error.offer_send_failed', { msg: (e?.message || String(e)) });
          }
          break;
        }
        case 'offer': {
          logT('signal','debug.signal_recv_offer');
          pendingOffer = msg.payload || msg.offer || null;
          if (pendingOffer) {
            btnAnswer && btnAnswer.classList.remove('hidden');
            setStatus(i18next.t('call.offer_received_click_answer'),'warn');
          }
          break;
        }
        case 'answer': {
          logT('signal','debug.signal_recv_answer');
          if (msg.payload) { try { await applyAnswer(msg.payload); } catch(e) { logT('error','error.apply_answer', { msg: (e?.message || String(e)) }); } }
          break;
        }
        case 'ice': {
          const c = msg.payload || msg.candidate;
          if (c) { try { await addRemoteIce(c); } catch(e) { logT('error','error.add_remote_ice', { msg: (e?.message || String(e)) }); } }
          break;
        }
        case 'bye': {
          logT('signal','debug.signal_recv_bye');
          doCleanup('peer-bye');
          break;
        }
        default: break;
      }
    } catch(e){ logT('error','onSignal: '+(e.message||e)); }
  }

  function shareRoomLink(rid){
    const safeId = String(rid||'').replace(/[^A-Za-z0-9_-]/g,'');
    const base = location.origin + location.pathname;
    const link = `${base}?room=${encodeURIComponent(safeId)}`;
    if (shareLinkEl) shareLinkEl.value = link;
    if (shareWrap) shareWrap.classList.remove('hidden');
  }

  async function startCaller(){
    if (waitWSOpen) await waitWSOpen(3000);
    setStatus(i18next.t('status.preparing'),'warn-txt');
    btnCall && (btnCall.disabled = true);
    await getMic();
    createPC((s)=>{ if (audioEl) audioEl.srcObject = s; logT('webrtc','webrtc.remote_track'); });
    setStatus(i18next.t('room.ready_share_link'),'ok');
    if (btnHang) btnHang.disabled = false;
  }

  function doCleanup(reason='user-hangup'){
    try { wsSend('bye', {reason}); } catch {}
    try { wsClose(); } catch {}
    try { cleanupRTC(reason); } catch {}
    clearInterval(pingTimer);

    // вернуть кнопки в исходное состояние
    const hasRoom = !!parseRoom();
    if (btnHang) btnHang.disabled = true;
    if (btnCall) btnCall.classList.toggle('hidden', hasRoom);
    if (btnAnswer) btnAnswer.classList.toggle('hidden', !hasRoom);
    if (shareWrap) shareWrap.classList.add('hidden');
    setStatus(i18next.t('call.ended'),'warn-txt');
    if (noteEl) noteEl.textContent = '';
  }

  // --- URL init ---
  async function initByUrl(){
    const rid = parseRoom();
    if (!rid) {
      logT('info','debug.no_room_param_caller');
      setStatus(i18next.t('common.ready'),'ok');
      setRoleLabel(true);
      return;
    }
    role = 'callee';
    roomId = rid;
    await connectWS('callee', rid, onSignal);
    setRoleLabel(false);
    setStatus(i18next.t('ws.waiting_offer'),'ok');
    if (btnAnswer) btnAnswer.classList.remove('hidden');
    if (btnCall) btnCall.classList.add('hidden');
  }

  // --- Buttons ---
  if (btnCall) btnCall.onclick = async () => {
    try {
      btnCall.disabled = true;
      setStatus(i18next.t('status.preparing'),'warn');
      const resp = await apiCreateRoom(SERVER_URL);
      const rawId = (resp && (resp.roomId || resp.room || resp.id)) || null;
      roomId = rawId ? String(rawId).replace(/[^A-Za-z0-9_-]/g,'') : null;
      role = 'caller';
      await connectWS('caller', roomId, onSignal);
      shareRoomLink(roomId);
      await startCaller();
      setStatus(i18next.t('room.ready_share_link'),'ok');
      if (btnHang) btnHang.disabled = false;
    } catch(e){
      setStatus(i18next.t('error.room_create_failed'),'err');
      logT('error','error.room_create_failed');
      if (noteEl) noteEl.textContent = e && e.message ? e.message : String(e);
      btnCall.disabled = false;
    }
  };

  if (btnAnswer) btnAnswer.onclick = async () => {
    const rid = parseRoom();
    if (!rid) { alert(i18next.t('room.open_invite_with_param')); logT('warn','warn.ws_already_connected_callee'); return; }
    role = 'callee'; roomId = rid;

    if (!isWSOpen()) await connectWS('callee', rid, onSignal);
    else logT('warn','warn.ws_already_connected_callee');

    if (pendingOffer) {
      await acceptIncoming(pendingOffer, (s)=>{ if (audioEl) audioEl.srcObject = s; logT('webrtc','webrtc.remote_track'); });
      pendingOffer = null;
      if (btnHang) btnHang.disabled = false;
    } else {
      logT('warn','btnAnswer без оффера');
      setStatus(i18next.t('signal.waiting_offer'),'warn');
    }
  };

  if (btnHang) btnHang.onclick = () => doCleanup('user-hangup');

  if (btnNativeShare) btnNativeShare.onclick = () => {
    const txt = (shareLinkEl && shareLinkEl.value) || '';
    if (navigator.share) navigator.share({
      title: i18next.t('dialog.invite_title'),
      text: i18next.t('call.offer_received_click_answer') + ' ' + txt,
      url: txt
    }).catch(()=>{});
    else if (noteEl) noteEl.textContent = i18next.t('share.native_unavailable');
  };

  if (btnCopy) btnCopy.onclick = async () => {
    try {
      await navigator.clipboard.writeText((shareLinkEl && shareLinkEl.value) || '');
      if (noteEl) noteEl.textContent = i18next.t('common.link_copied');
    } catch {
      if (noteEl) noteEl.textContent = i18next.t('common.will_be_generated');
    }
  };

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

  // --- Boot ---
  setStatus(i18next.t('status.initializing'));
  try { renderEnv(); } catch {}
  logT('info','dev.client_loaded_vite');
  initByUrl();

  // Выставим видимость кнопок при загрузке
  if (!parseRoom()){
    if (btnCall) btnCall.classList.remove('hidden');
    if (btnAnswer) btnAnswer.classList.add('hidden');
    if (shareWrap) shareWrap.classList.add('hidden');
  } else {
    if (btnCall) btnCall.classList.add('hidden');
    if (btnAnswer) btnAnswer.classList.remove('hidden');
    if (shareWrap) shareWrap.classList.add('hidden');
  }
})();