// src/js/webrtc.js — robust, minimal WebRTC core for Zvonilka
// Exposes a stable API on window.__WEBRTC__ and helpers on window: { getPC, createPC, getMic, sendOfferIfPossible, acceptIncoming, addRemoteIce, cleanup }
// Goals: single RTCPeerConnection, offer only when WS+role are ready, TCP‑friendly ICE, rich console logs.

(function () {
  if (typeof window !== 'undefined') {
    if (window.__CURRENT_ZV_WEBRTC__) { console.warn('[WEBRTC] already initialized'); return; }
    window.__CURRENT_ZV_WEBRTC__ = true;
  }

  // ---------- State ----------
  /** @type {RTCPeerConnection|null} */ let pc = null;
  /** @type {MediaStream|null} */ let localStream = null;
  /** @type {boolean} */ let offerSent = false;
  /** @type {boolean} */ let offerInProgress = false;
  /** @type {boolean} */ let offerPrepared = false; // localDescription is set, wait to send after candidates
  /** @type {RTCIceCandidateInit[]} */ const remoteIceQueue = (Array.isArray(window.__REMOTE_ICE_Q) ? window.__REMOTE_ICE_Q : (window.__REMOTE_ICE_Q = []));
  /** @type {Set<string>} */ const sentLocalIce = new Set();
  /** @type {boolean} */ let endOfCandidatesSent = false;

  const NON_TRICKLE = false; // send full SDP after gathering (helps avoid one‑way audio on relay)

  // ---------- Logging helpers ----------
  const log = {
    d: (...a) => { try { console.log('[WEBRTC]', ...a); } catch (_) {} },
    i: (...a) => { try { console.log('[WEBRTC]', ...a); } catch (_) {} },
    w: (...a) => { try { console.warn('[WEBRTC]', ...a); } catch (_) {} },
    e: (...a) => { try { console.error('[WEBRTC]', ...a); } catch (_) {} },
    ui: (k, v = '') => { try { window.addLog && window.addLog('webrtc', v ? `${k}: ${v}` : k); } catch (_) {} },
  };

  const getRole = () => {
    try { return new URLSearchParams(location.search).get('role') || window.role || null; }
    catch { return window.role || null; }
  };
  const wsReady = () => !!(window.ws && window.ws.readyState === 1);
  const getPC = () => pc;
  const delay = (ms) => new Promise(res => setTimeout(res, ms));

  // ---- Diagnostics ----
  async function logSelectedPair(tag = '') {
    try {
      if (!pc) return;
      const s = await pc.getStats();
      let pair, loc, rem;
      s.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = s.get(r.selectedCandidatePairId); });
      if (pair) { loc = s.get(pair.localCandidateId); rem = s.get(pair.remoteCandidateId); }
      console.log('[ICE-PAIR]', tag, {
        state: pc.iceConnectionState,
        nominated: pair && pair.nominated,
        local: loc && { type: loc.candidateType, proto: loc.protocol, ip: loc.ip || loc.address },
        remote: rem && { type: rem.candidateType, proto: rem.protocol, ip: rem.ip || rem.address }
      });
    } catch (_) {}
  }
  async function dumpRtp(tag = '') {
    try {
      if (!pc) return;
      const s = await pc.getStats();
      const inb = [], out = [];
      s.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') inb.push({ bytes: r.bytesReceived, pkts: r.packetsReceived, jitter: r.jitter });
        if (r.type === 'outbound-rtp' && r.kind === 'audio') out.push({ bytes: r.bytesSent, pkts: r.packetsSent });
      });
      console.log('[RTP]', tag, { inbound: inb, outbound: out });
    } catch (_) {}
  }
  function logTransceivers(tag='') {
    try {
      const tx = pc && pc.getTransceivers ? pc.getTransceivers() : [];
      console.log('[TX]', tag, tx && tx.map(t => ({ mid: t.mid, dir: t.direction, cur: t.currentDirection })));
    } catch (_) {}
  }

  async function waitIceComplete(target, ms = 2500) {
    const t0 = Date.now();
    while (Date.now() < t0 + ms) {
      if (!target) return;
      if (target.iceGatheringState === 'complete') return;
      await delay(60);
    }
  }

  async function waitWsOpen(ms = 2000) {
    const t0 = Date.now();
    while (Date.now() < t0 + ms) {
      if (wsReady()) return true;
      await delay(50);
    }
    return false;
  }

  // Wait until TURN config (window.__TURN__.iceServers) is available (or timeout)
  async function waitTurnReady(ms = 4000) {
    const t0 = Date.now();
    while (Date.now() < t0 + ms) {
      try {
        const t = window && window.__TURN__;
        if (t && Array.isArray(t.iceServers) && t.iceServers.length) return true;
      } catch (_) {}
      await delay(100);
    }
    console.warn('[WEBRTC] waitTurnReady: TURN not ready, continuing with current cfg');
    return false;
  }
  try { if (typeof window !== 'undefined') window.waitTurnReady = waitTurnReady; } catch (_) {}

  // Always refetch TURN credentials before creating a PeerConnection
  async function getFreshTurn() {
    try {
      const res = await fetch('/turn-credentials', { cache: 'no-store' });
      const cfg = await res.json();
      const now = Math.floor(Date.now() / 1000);
      if (!cfg.expiresAt || (cfg.expiresAt - 60) < now) {
        console.warn('[WEBRTC] TURN creds expired or near expiry, refetching...');
        return await getFreshTurn();
      }
      console.log('[WEBRTC] fresh TURN creds loaded', cfg);
      if (typeof window !== 'undefined') {
        const prev = window.__TURN__ || {};
        window.__TURN__ = Object.assign({}, prev, cfg);
      }
      return cfg;
    } catch (e) {
      console.error('[WEBRTC] failed to fetch TURN creds', e);
      throw e;
    }
  }

  async function getMic() {
    if (localStream) return localStream;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
      localStream = stream;
      log.ui('mic ok');
      return stream;
    } catch (e) {
      log.e('mic error', e);
      throw e;
    }
  }

  async function getCam() {
    // Acquire camera and merge tracks into localStream
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (localStream) {
        // merge video tracks into the existing localStream to keep a single stream reference
        for (const t of (camStream.getVideoTracks ? camStream.getVideoTracks() : [])) {
          try { localStream.addTrack(t); } catch (_) {}
        }
      } else {
        localStream = camStream;
      }
      log.ui('cam ok');
      return localStream;
    } catch (e) {
      log.e('cam error', e);
      throw e;
    }
  }

  async function ensureVideoSender() {
    if (!pc || !localStream) return;
    const track = (localStream.getVideoTracks && localStream.getVideoTracks()[0]) || null;
    if (!track) return;
    try { track.enabled = true; } catch (_) {}

    const existing = pc.getSenders ? pc.getSenders().find(s => s.track && s.track.kind === 'video') : null;
    if (existing) {
      try { await existing.replaceTrack(track); log.d('sender: replaced video track'); } catch (e) { log.w('video replace error', e); }
      return;
    }
    try {
      const tx = pc.getTransceivers && pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
      if (!tx) pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTrack(track, localStream);
      log.d('sender: added video');
    } catch (e) {
      log.e('video add failed', e);
    }
  }

  function getLocalStream() {
    return localStream || null;
  }

  async function ensureAudioSender() {
    if (!pc || !localStream) return;
    const track = (localStream.getAudioTracks && localStream.getAudioTracks()[0]) || null;
    if (!track) return;
    // ensure it is enabled
    try { track.enabled = true; } catch (_) {}

    const existing = pc.getSenders ? pc.getSenders().find(s => s.track && s.track.kind === 'audio') : null;
    if (existing) {
      try { await existing.replaceTrack(track); log.d('sender: replaced track'); } catch (e) { log.w('sender replace error', e); }
      return;
    }
    try {
      const tx = pc.getTransceivers ? pc.getTransceivers()[0] : null;
      if (!tx) pc.addTransceiver('audio', { direction: 'sendrecv' });
      else if (tx.direction !== 'sendrecv') tx.direction = 'sendrecv';
      pc.addTrack(track, localStream);
      log.d('sender: added track');
    } catch (e) {
      log.e('sender add failed', e);
    }
  }

  function buildIceConfig() {
    const t = (typeof window !== 'undefined' && window.__TURN__) ? window.__TURN__ : {};
    const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    if (!t || !Array.isArray(t.iceServers) || !t.iceServers.length) {
      log.i('[ICE] using STUN fallback');
      return fallback;
    }
    const cfg = { iceServers: t.iceServers };
    if (t.forceRelay) cfg.iceTransportPolicy = 'relay';
    // Ensure policy visibility in logs
    try { console.log('[ICE CONFIG POLICY]', cfg.iceTransportPolicy || 'all'); } catch (_) {}
    try { console.log('[ICE CONFIG DEBUG]', JSON.stringify(cfg, null, 2)); } catch (_) {}
    return cfg;
  }

  function ensureRemoteAudioElement() {
    let a = document.getElementById('remoteAudio') || document.querySelector('audio');
    if (!a) {
      a = document.createElement('audio');
      a.id = 'remoteAudio';
      a.autoplay = true; a.playsInline = true; a.muted = false; a.style.display = 'none';
      document.body.appendChild(a);
    }
    // one‑tap resume to bypass autoplay policies
    if (!window.__AUDIO_RESUME_BOUND__) {
      window.__AUDIO_RESUME_BOUND__ = true;
      const resume = () => { try { a.play && a.play(); } catch (_) {} };
      window.addEventListener('click', () => { resume(); }, { once: true, capture: true });
    }
    return a;
  }

  function attachExistingTracks() {
    if (!pc || !localStream) return; // no-op if not ready
    const tracks = localStream.getTracks ? localStream.getTracks() : [];
    for (const t of tracks) {
      const exists = pc.getSenders && pc.getSenders().some(s => s.track && s.track.kind === t.kind);
      if (!exists) try { pc.addTrack(t, localStream); } catch (_) {}
    }
  }

  async function createPC(onTrackCb) {
    // ensure TURN config is present before building PC so we don't fall back to STUN prematurely
    try { await getFreshTurn(); } catch (_) { console.warn('[WEBRTC] getFreshTurn failed, continuing with existing config'); }
    try { await waitTurnReady(4000); } catch (_) {}
    const cfg = buildIceConfig();
    // prime ICE: small pool so local candidates appear quickly
    cfg.iceCandidatePoolSize = 2;
    console.log('[CREATE PC] config', JSON.stringify(cfg));
    pc = new RTCPeerConnection(cfg);
    logTransceivers('after-create');
    try { window.getPC = () => pc; } catch (_) {}

    // ICE events
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        try { console.log('[ICE-LOCAL]', e.candidate && e.candidate.candidate); } catch(_) {}
        const init = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
        const key = (init.candidate || JSON.stringify(init));
        if (sentLocalIce.has(key)) {
          // skip duplicates
          return;
        }
        sentLocalIce.add(key);
        log.ui('send ice');
        if (!NON_TRICKLE && wsReady() && typeof window.wsSend === 'function') {
          window.wsSend('ice', init);
        }
      } else {
        if (!endOfCandidatesSent) {
          endOfCandidatesSent = true;
          log.ui('ice end');
          if (!NON_TRICKLE && typeof window.wsSend === 'function') window.wsSend('ice', null);
        }
      }
    };
    pc.onicegatheringstatechange = async () => {
      log.ui('gathering=' + pc.iceGatheringState);
      if (pc.iceGatheringState === 'complete') {
        log.ui('ICE gathering complete');
      }
      logSelectedPair('gathering:' + pc.iceGatheringState);
    };
    pc.oniceconnectionstatechange = () => { const st = pc.iceConnectionState; dumpRtp('oniceconnectionstatechange:'+st); logSelectedPair('onice:'+st); log.ui('ice=' + st); };
    pc.onconnectionstatechange = () => { log.d('connection=' + pc.connectionState); };
    pc.ontrack = (e) => { console.log('[TRACK]', { kind: e.track && e.track.kind, ready: e.track && e.track.readyState, streams: (e.streams||[]).length }); dumpRtp('ontrack'); const s = (e.streams && e.streams[0]) || (e.track ? new MediaStream([e.track]) : null); if (onTrackCb && s) onTrackCb(s); const a = ensureRemoteAudioElement(); a.srcObject = s; a.muted = false; a.play && a.play().catch(()=>{}); log.ui('webrtc.remote_track'); };

    // Pre-provision only for CALLER; callee waits for remote offer to define m-lines
    try {
      const r = getRole();
      if (r === 'caller') {
        // audio
        const hasAudio = pc.getTransceivers && pc.getTransceivers().some(t => (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') || t.mid === '0');
        if (!hasAudio) pc.addTransceiver('audio', { direction: 'sendrecv' });
        // video
        const hasVideo = pc.getTransceivers && pc.getTransceivers().some(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
        if (!hasVideo) pc.addTransceiver('video', { direction: 'sendrecv' });
      }
    } catch (_) {}

    // Negotiation: only caller creates offers; callee asks via signaling
    pc.onnegotiationneeded = () => {
      const r = getRole();
      console.log('[NEGOTIATION] event role=', r, 'wsReady=', wsReady());
      if (r !== 'caller') return;
      if (!wsReady()) { console.log('[NEGOTIATION] ws not ready (no retry)'); return; }
      if (offerInProgress || offerSent) { console.log('[NEGOTIATION] skip, already handled'); return; }
      sendOfferIfPossible();
    };

    // Attach any pre-existing local tracks
    if (localStream) {
      try { for (const t of localStream.getTracks()) { const exists = pc.getSenders && pc.getSenders().some(s => s.track && s.track.kind === t.kind); if (!exists) pc.addTrack(t, localStream); } }
      catch (_) {}
    }

    return pc;
  }

  async function sendOfferIfPossible() {
    // Single attempt only
    if (!pc) {
      console.log('[OFFER] no pc yet, creating');
      try { if (typeof createPC === 'function') await createPC(); } catch (_) {}
    }
    const r = getRole();
    console.log('[OFFER] enter (post-PC)', 'wsReady=', wsReady(), 'role=', r, 'pc?', !!pc, 'state=', pc && pc.signalingState);
    if (r !== 'caller') { console.log('[OFFER] not caller'); return; }
    if (!pc) { console.warn('[OFFER] no pc'); return; }
    if (!wsReady()) { console.warn('[OFFER] ws not ready (no retry)'); return; }
    if (!(pc.signalingState === 'stable' || pc.signalingState === 'have-local-offer')) { console.log('[OFFER] not stable:', pc.signalingState); return; }

    offerInProgress = true;
    try {
      await getMic();
      await ensureAudioSender();
      try { await pc.getStats(); } catch (_) {}
      const offer = await pc.createOffer({ offerToReceiveAudio: 1 });
      await pc.setLocalDescription(offer);
      console.log('[OFFER] setLocal ok; gather=', pc.iceGatheringState);

      // Send offer immediately once
      if (wsReady() && typeof window.wsSend === 'function' && !offerSent) {
        window.wsSend('offer', pc.localDescription);
        offerSent = true; offerPrepared = false; window.__SEND_OFFER_ONCE__ = true; log.ui('send offer');
      }

      await logSelectedPair('after-setLocal-offer');

      // Log SDP candidates count for visibility only
      try {
        const candLines = (offer.sdp || '').split('\r\n').filter(l => l.startsWith('a=candidate'));
        console.log('[OFFER] local candidates in SDP:', candLines.length);
      } catch(_) {}
    } catch (e) {
      offerSent = false; console.error('[OFFER] error', e);
    } finally {
      offerInProgress = false;
      console.log('[OFFER] done; ice=', pc && pc.iceConnectionState);
    }
  }

  async function acceptIncoming(offer, onTrackCb) {
    try {
      if (!offer) { console.warn('[ACCEPT] no offer'); return; }
      if (!pc) await createPC(onTrackCb);
      const sdp = typeof offer === 'string' ? offer : (offer.sdp || (offer.payload && offer.payload.sdp) || (offer.offer && offer.offer.sdp) || '');
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      await logSelectedPair('after-setRemote-offer');
      // Align transceiver direction after applying remote offer (callee)
      try {
        const tx0 = pc.getTransceivers && pc.getTransceivers()[0];
        if (tx0 && tx0.direction !== 'sendrecv') tx0.direction = 'sendrecv';
      } catch (_) {}
      log.ui('remote offer applied');
      await getMic();
      await ensureAudioSender();
      // Prime stats loop to kick ICE stack in some browsers
      try { await pc.getStats(); } catch (_) {}
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await logSelectedPair('after-setLocal-answer');
      // (local candidates wait and ICE restart removed)
      if (NON_TRICKLE) await waitIceComplete(pc, 2500);
      await logSelectedPair('after-gather-answer');
      await dumpRtp('after-gather-answer');
      // Log how many candidates we packed into SDP
      try {
        const candLines = (answer.sdp || '').split('\r\n').filter(l => l.startsWith('a=candidate'));
        console.log('[ANSWER] local candidates in SDP:', candLines.length, candLines.slice(0,5));
      } catch(_) {}
      const final = pc.localDescription || answer;
      if (typeof window.wsSend === 'function') { window.wsSend('answer', final); log.ui('send answer'); }
      // Also log counts of candidates we see locally
      try {
        const s = await pc.getStats();
        const locals = [], rems = [];
        s.forEach(r=>{ if(r.type==='local-candidate') locals.push(r); if(r.type==='remote-candidate') rems.push(r); });
        console.log('[ICE-CANDS] after-gather-offer', {localCount: locals.length, remoteCount: rems.length, locals: locals.map(x=>({type:x.candidateType, proto:x.protocol, ip:x.ip||x.address})), remotes: rems.map(x=>({type:x.candidateType, proto:x.protocol, ip:x.ip||x.address}))});
      } catch(_){}
    } catch (e) {
      console.error('[ACCEPT] error', e);
    }
  }

  async function addRemoteIce(candidate) {
    if (!pc) { remoteIceQueue.push(candidate); return; }
    if (!pc.remoteDescription) { remoteIceQueue.push(candidate); return; }
    if (candidate == null) { try { await pc.addIceCandidate(null); } catch (_) {} return; }
    const init = (typeof candidate === 'string') ? { candidate } : Object.assign({}, candidate);
    if (!('sdpMid' in init) && !('sdpMLineIndex' in init)) { init.sdpMid = '0'; init.sdpMLineIndex = 0; }
    try { await pc.addIceCandidate(init); console.log('[ICE<-REMOTE] added'); logSelectedPair('addRemoteIce'); }
    catch (e) {
      try { console.error('[ICE<-REMOTE] add failed', { err: e && (e.message || String(e)), cand: init && init.candidate }); } catch(_) {}
    }
  }

  function cleanup(reason = '') {
    try {
      if (pc) { pc.close(); pc = null; }
      localStream = null;
      sentLocalIce.clear();
      endOfCandidatesSent = false;
      offerSent = false; offerInProgress = false; remoteIceQueue.length = 0;
      window.addLog && window.addLog('info', 'cleanup ' + (reason || ''));
    } catch (_) {}
  }
  window.addRemoteIce = addRemoteIce;
  // Public API
  window.__WEBRTC__ = { getPC, createPC, getMic, getCam, ensureVideoSender, getLocalStream, sendOfferIfPossible, acceptIncoming, addRemoteIce, cleanup };
  window.getPC = window.getPC || getPC;
  window.sendOfferIfPossible = window.sendOfferIfPossible || sendOfferIfPossible;
  window.acceptIncoming = window.acceptIncoming || acceptIncoming;
})();
