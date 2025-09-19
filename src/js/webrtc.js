// public/js/webrtc.js
// WebRTC логика. Публикует функции в window для использования в index.html.
// Подключается до большого inline-скрипта.

(function () {
  let pc = null;
  let localStream = null;
  let pendingOffer = null;
  let offerSent = false;
  let remoteDescApplied = false;
  let pendingRemoteICE = [];

  function t(key, fallback) {
    try { return (window.i18next && window.i18next.t) ? window.i18next.t(key) : (fallback || key); }
    catch { return fallback || key; }
  }

  function getPC(){ return pc; }

    async function addRemoteIce(c){
    if (!c) return;
    try {
        if (pc && remoteDescApplied) {
        await pc.addIceCandidate(new RTCIceCandidate(c));
        } else {
        pendingRemoteICE.push(c);
        }
    } catch {}
    }

    async function applyAnswer(desc){
    if (!desc) return;
    try{
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
        remoteDescApplied = true;
        while (pendingRemoteICE.length){
        const x = pendingRemoteICE.shift();
        try{ await pc.addIceCandidate(new RTCIceCandidate(x)); }catch{}
        }
    }catch{}
    }



  async function getMic() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (window.addLog) window.addLog('info', 'mic ok');
      return localStream;
    } catch (e) {
      window.addLog && window.addLog('error', 'mic error: ' + (e.message || e));
      throw e;
    }
  }

  function getIceConfig(){
    // Берём TURN-конфиг из window.__TURN__ если он задан.
    // Формат ожидается как: { iceServers: [...], forceRelay: true|false }
    const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    const t = (typeof window !== 'undefined') ? window.__TURN__ : null;
    if (t && Array.isArray(t.iceServers) && t.iceServers.length) {
      const cfg = { iceServers: t.iceServers.slice() };
      if (t.forceRelay) cfg.iceTransportPolicy = 'relay';
      return cfg;
    }
    return fallback;
  }

  function createPC(onTrackCb) {
    const cfg = getIceConfig();
    try {
      window.addLog && window.addLog('webrtc', 'create RTCPeerConnection ' + (cfg.iceTransportPolicy ? `(policy=${cfg.iceTransportPolicy})` : ''));
    } catch {}
    pc = new RTCPeerConnection(cfg);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        window.wsSend && window.wsSend('ice', e.candidate);
      }
    };
    pc.onicegatheringstatechange = () => {
      const st = pc.iceGatheringState;
      window.addLog && window.addLog('webrtc', `gathering=${st}`);
      if (st === 'complete') {
        window.addLog && window.addLog('webrtc', 'ICE gathering complete');
      }
    };
    
    pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        window.addLog && window.addLog('webrtc', `ice=${st}`);
        if (typeof window.setStatus === 'function') {
            if (st === 'connected') {
            window.setStatus(t('status.connected','соединение установлено'),'ok');
            } else if (st === 'checking') {
            window.setStatus(t('status.connecting','соединяемся…'),'warn');
            } else if (st === 'disconnected') {
            window.setStatus(t('status.lost_recovering','соединение потеряно, пытаемся восстановить…'),'warn');
            } else if (st === 'failed') {
            window.setStatus(t('error.connection','ошибка соединения'),'err');
            }
        }
    };

    pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        window.addLog && window.addLog('webrtc', `state=${st}`);
        if (typeof window.setStatus === 'function') {
            if (st === 'connected') {
            window.setStatus(t('status.connected','соединение установлено'),'ok');
            } else if (st === 'connecting') {
            window.setStatus(t('status.connecting','соединяемся…'),'warn');
            } else if (st === 'disconnected') {
            window.setStatus(t('status.lost_recovering','соединение потеряно, пытаемся восстановить…'),'warn');
            } else if (st === 'failed') {
            window.setStatus(t('error.connection','ошибка соединения'),'err');
            } else if (st === 'closed') {
            window.setStatus(t('status.closed','соединение закрыто'),'warn');
            }
        }
    };

    pc.ontrack = (e) => {
      if (onTrackCb) onTrackCb(e.streams[0]);
    };
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }
    return pc;
  }

  async function sendOfferIfPossible(force = false) {
    try {
      if (!(window.isWSOpen && window.isWSOpen())) return;
      if (!pc || !localStream) return;
      if (offerSent && !force) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      window.wsSend && window.wsSend('offer', offer);
      offerSent = true;
      window.addLog && window.addLog('signal', 'send offer');
    } catch (e) {
      window.addLog && window.addLog('error', 'sendOfferIfPossible: ' + (e.message || e));
    }
  }

  async function acceptIncoming(pendingOffer, onTrackCb) {
    try {
      if (!pendingOffer) {
        window.addLog && window.addLog('warn', 'acceptIncoming: no offer');
        return;
      }
      if (!pc) createPC(onTrackCb);
      await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      window.wsSend && window.wsSend('answer', answer);
      remoteDescApplied = true;
      // применим отложенные ICE
      while (pendingRemoteICE.length) {
        const c = pendingRemoteICE.shift();
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
      }
    } catch (e) {
      window.addLog && window.addLog('error', 'acceptIncoming: ' + (e.message || e));
    }
  }

  function cleanup(reason = '') {
    try {
      if (pc) {
        pc.close();
        pc = null;
      }
      localStream = null;
      pendingOffer = null;
      offerSent = false;
      remoteDescApplied = false;
      pendingRemoteICE = [];
      window.addLog && window.addLog('info', 'cleanup ' + reason);
    } catch {}
  }

  // Публикуем в window
  try {
    if (typeof window !== 'undefined') {
      window.__WEBRTC__ = { getMic, createPC, sendOfferIfPossible, acceptIncoming, cleanup, getPC, addRemoteIce, applyAnswer };
        if (!window.getPC)        window.getPC        = getPC;
        if (!window.addRemoteIce) window.addRemoteIce = addRemoteIce;
        if (!window.applyAnswer)  window.applyAnswer  = applyAnswer;
      if (!window.getMic) window.getMic = getMic;
      if (!window.createPC) window.createPC = createPC;
      if (!window.sendOfferIfPossible) window.sendOfferIfPossible = sendOfferIfPossible;
      if (!window.acceptIncoming) window.acceptIncoming = acceptIncoming;
      if (!window.cleanup) window.cleanup = cleanup;
    }
  } catch {}
})();