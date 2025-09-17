// src/main.js
// Глобальные модули (они вешают API на window.*)
import './js/helpers.js';
import './js/signaling.js';
import './js/webrtc.js';
import './js/ui.js';

// ---- BOOTSTRAP ----
// Минимальная инициализация UI и логики, раньше это было инлайном в index.html.
(function boot() {
  if (window.__CALL_APP_LOADED__) return;
  window.__CALL_APP_LOADED__ = true;

  // --- DOM ---
  const statusEl = document.getElementById('status');
  const noteEl   = document.getElementById('note');
  const roomNote = document.getElementById('roomNote');
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
          setStatus(`WS подключён. Комната ${roomId||parseRoom()||'-'}`, 'ok');
          roomNote && (roomNote.textContent = `Комната: ${roomId||parseRoom()||'-'}`);
          addLog('signal','recv hello');
          break;
        }
        case 'member.joined': {
          addLog('signal','recv member.joined');
          // ВАЖНО: если мы инициатор (caller), отправляем оффер сразу после входа второго участника.
          // Раньше это делал инлайн-скрипт; после рефакторинга вызов потерялся.
          try {
            if (role === 'caller') {
              if (typeof window.sendOfferIfPossible === 'function') {
                await window.sendOfferIfPossible(true); // force
                addLog('webrtc','offer sent (caller)');
              } else if (typeof window.createAndSendOffer === 'function') {
                await window.createAndSendOffer();
                addLog('webrtc','offer sent via createAndSendOffer');
              } else {
                addLog('warn','no offer sender impl (sendOfferIfPossible/createAndSendOffer)');
              }
            }
          } catch (e) {
            addLog('error','sendOfferIfPossible: ' + (e?.message || e));
          }
          break;
        }
        case 'offer': {
          addLog('signal','recv offer');
          pendingOffer = msg.payload || msg.offer || null;
          if (pendingOffer) {
            btnAnswer && btnAnswer.classList.remove('hidden');
            setStatus('получен оффер — нажмите «Ответить на звонок»','warn');
          }
          break;
        }
        case 'answer': {
          addLog('signal','recv answer');
          if (msg.payload) { try { await applyAnswer(msg.payload); } catch(e) { addLog('error','applyAnswer: '+(e.message||e)); } }
          break;
        }
        case 'ice': {
          const c = msg.payload || msg.candidate;
          if (c) { try { await addRemoteIce(c); } catch(e) { addLog('error','addRemoteIce: '+(e.message||e)); } }
          break;
        }
        case 'bye': {
          addLog('signal','recv bye');
          doCleanup('peer-bye');
          break;
        }
        default: break;
      }
    } catch(e){ addLog('error','onSignal: '+(e.message||e)); }
  }

  function shareRoomLink(rid){
    const base = location.origin + location.pathname;
    const link = `${base}?room=${encodeURIComponent(rid)}`;
    if (shareLinkEl) shareLinkEl.value = link;
    if (shareWrap) shareWrap.classList.remove('hidden');
  }

  async function startCaller(){
    if (waitWSOpen) await waitWSOpen(3000);
    setStatus('подготовка…','warn-txt');
    btnCall && (btnCall.disabled = true);
    await getMic();
    createPC((s)=>{ if (audioEl) audioEl.srcObject = s; addLog('webrtc','remote track'); });
    setStatus('Комната готова. Поделитесь ссылкой или ждите входа собеседника','ok');
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
    setStatus('звонок завершён','warn-txt');
    if (noteEl) noteEl.textContent = '';
  }

  // --- URL init ---
  async function initByUrl(){
    const rid = parseRoom();
    if (!rid) {
      addLog('info','нет room в URL — это Caller');
      setStatus('Готов','ok');
      roomNote && (roomNote.textContent='Режим: инициатор');
      return;
    }
    roomNote && (roomNote.textContent = `Комната: ${rid}`);
    role = 'callee';
    roomId = rid;
    await connectWS('callee', rid, onSignal);
    setStatus('WS подключён, ждём оффер','ok');
    if (btnAnswer) btnAnswer.classList.remove('hidden');
    if (btnCall) btnCall.classList.add('hidden');
  }

  // --- Buttons ---
  if (btnCall) btnCall.onclick = async () => {
    try {
      btnCall.disabled = true;
      setStatus('Создаём комнату…','warn');
      const resp = await apiCreateRoom(SERVER_URL);
      roomId = (resp && resp.roomId) || null;
      role = 'caller';
      await connectWS('caller', roomId, onSignal);
      shareRoomLink(roomId);
      await startCaller();
      setStatus('Комната готова. Поделитесь ссылкой или ждите входа собеседника','ok');
      if (btnHang) btnHang.disabled = false;
    } catch(e){
      setStatus('ошибка создания комнаты','err');
      addLog('error', e && e.message ? e.message : String(e));
      if (noteEl) noteEl.textContent = e && e.message ? e.message : String(e);
      btnCall.disabled = false;
    }
  };

  if (btnAnswer) btnAnswer.onclick = async () => {
    const rid = parseRoom();
    if (!rid) { alert('Откройте приглашение с ?room=…'); addLog('warn','btnAnswer без room'); return; }
    role = 'callee'; roomId = rid;

    if (!isWSOpen()) await connectWS('callee', rid, onSignal);
    else addLog('warn','WS уже подключён (callee)');

    if (pendingOffer) {
      await acceptIncoming(pendingOffer, (s)=>{ if (audioEl) audioEl.srcObject = s; addLog('webrtc','remote track'); });
      pendingOffer = null;
      if (btnHang) btnHang.disabled = false;
    } else {
      addLog('warn','btnAnswer без оффера');
      setStatus('ждём оффер…','warn');
    }
  };

  if (btnHang) btnHang.onclick = () => doCleanup('user-hangup');

  if (btnNativeShare) btnNativeShare.onclick = () => {
    const txt = (shareLinkEl && shareLinkEl.value) || '';
    if (navigator.share) navigator.share({ title:'Приглашение на звонок', text:`Вам звонят: ${txt}`, url: txt }).catch(()=>{});
    else if (noteEl) noteEl.textContent = 'Native Share недоступен';
  };

  if (btnCopy) btnCopy.onclick = async () => {
    try { await navigator.clipboard.writeText((shareLinkEl && shareLinkEl.value) || ''); if (noteEl) noteEl.textContent='Ссылка скопирована'; }
    catch { if (noteEl) noteEl.textContent='Скопируйте вручную'; }
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
  setStatus('инициализация…');
  try { renderEnv(); } catch {}
  addLog('info','Клиент загружен (Vite dev, TURN relay policy из config.js)');
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