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
  /** @type {boolean} */ let negotiationScheduled = false;
  /** @type {number|null} */ let offerRetryTimer = null;
  /** @type {RTCIceCandidateInit[]} */ const remoteIceQueue = (Array.isArray(window.__REMOTE_ICE_Q) ? window.__REMOTE_ICE_Q : (window.__REMOTE_ICE_Q = []));

  const NON_TRICKLE = true; // send full SDP after gathering (helps avoid one‑way audio on relay)

  // ---------- Logging helpers ----------
  const log = {
    d: (...a) => { try { console.debug('[WEBRTC]', ...a); } catch (_) {} },
    i: (...a) => { try { console.info('[WEBRTC]', ...a); } catch (_) {} },
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
    const t = window.__TURN__ || {};
    const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    if (!Array.isArray(t.iceServers) || !t.hasOwnProperty('iceServers') || t.iceServers.length === 0) {
      log.i('[ICE] using STUN fallback');
      return fallback;
    }

    const servers = t.iceServers;
    const norm = servers.map(s => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
        .filter(Boolean)
        .map((u) => {
          if (/^turns?:\/\/./i.test(String(u))) return String(u);
          // allow bare host, normalize to turns://host:443?transport=tcp
          const host = String(u).replace(/^https?:\/\//i, '').replace(/\/$/, '');
          return `turns:${host.replace(/:.*/, '')}:443?transport=tcp`;
        });
      return { urls, username: s.username, credential: s.credential, credentialType: s.credentialType || 'password' };
    });

    const cfg = { iceServers: norm };
    if (t.forceRelay) cfg.hed = true, cfg.iceTransportPolicy = 'relay';
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
    const cfg = buildIceConfig();
    console.log('[CREATE PC] config', JSON.stringify(cfg));
    pc = new RTCPeerConnection(cfg);

    // ICE events
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        log.ui('send ice');
        if (!NON_TRICKLE && wsReady() && typeof window.wsSend === 'function') {
          const init = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
          window.wsSend('ice', init);
        }
      } else {
        log.ui('ice end');
        if (!NON_TRICKLE && typeof window.wsSend === 'function') window.wsSend('ice', null);
      }
    };
    pc.onicegatheringstatechange = () => { log.ui('gathering=' + pc.iceGatheringState); if (pc.iceGatheringState === 'complete') log.ui('ICE gathering complete'); };
    pc.oniceconnectionstatechange = () => { const st = pc.get ? pc.iceConnectionState : pc.iceConnectionState; log.ui('ice=' + st); if (st === 'failed') { try { pc.restartIce(); log.ui('restartIce (failed)'); } catch (_) {} } };
    pc.onconnectionstatechange = () => { log.d('connection=' + pc.connectionState); };
    pc.ontrack = (e) => { const s = (e.streams && e.streams[0]) || (e.track ? new MediaStream([e.track]) : null); if (onTrackCb && s) onTrackCb(s); const a = ensureRemoteAudioElement(); a.srcObject = s; a.muted = false; a.play && a.play().catch(()=>{}); log.ui('webrtc.remote_track'); };

    // Pre-provision one audio transceiver to stabilize m-lines
    try { const tx = pc.getTransceivers ? pc.getTransceivers()[0] : null; if (!tx) pc.addTransceiver('audio', { direction: 'sendrecv' }); } catch (_) {}

    // Negotiation: only caller creates offers; callee asks via signaling
    pc.onnegotiationneeded = () => {
      const r = getRole();
      console.debug('[NEGOTIATION] event role=', r, 'wsReady=', wsReady());
      if (r !== 'caller') {
        if (r === 'callee' && typeof window.wsSend === 'function') {
          try { window.wsSend('renegotiate', { reason: 'onnegotiationneeded' }); log.ui('renegotiate request'); } catch (_) {}
        }
        return;
      }
      if (!wsReady()) { console.debug('[NEGOTIATION] ws not ready'); return; }
      if (offerInProgress || offerSent || negotiationScheduled) { console.debug('[NEGOTIATION] skip, busy'); return; }
      negotiationScheduled = true;
      setTimeout(() => { sendOfferIfPossible().finally(() => { negotiationScheduled = false; }); }, 200);
    };

    // Attach any pre-existing local tracks
    if (localStream) {
      try { for (const t of localStream.getTracks()) { const exists = pc.getSenders && pc.getSenders().some(s => s.track && s.track.kind === t.kind); if (!exists) pc.addTrack(t, localStream); } }
      catch (_) {}
    }

    return pc;
  }

  async function sendOfferIfPossible() {
    console.log('[OFFER] enter', 'wsReady=', wsReady(), 'role=', getRole(), 'pc?', !!pc, 'state=', pc && pc.signalingState);
    if (offerRetryTimer) { console.debug('[OFFER] retry already scheduled'); return; }

    // ensure we have a PeerConnection ready
    if (!pc) {
      console.debug('[OFFER] no pc yet, creating');
      try { createPC && createPC(); } catch (_) {}
    }

    const ok = await waitWsOpen(2000);
    if (!ok) {
      console.warn('[OFFER] ws not ready; schedule single retry in 250ms');
      if (!offerRetryTimer) offerRetryTimer = setTimeout(() => { offerRetryTimer = null; try { sendOfferIfPossible(); } catch (_) {} }, 250);
      return;
    }
    const r = getRole();
    if (r !== 'caller') { console.debug('[OFFER] not caller (', r, ')'); return; }
    if (!pc) { console.warn('[OFFER] no pc'); return; }
    if (!(pc.signalingState === 'stable' || pc.signalingState === 'have-local-offer')) { console.debug('[OFFER] not stable:', pc.signalingState); return; }

    offerInProgress = true;
    try {
      await getMic();
      await ensureAudioSender();
      const offer = await pc.createOffer({ offerToReceiveAudio: 1 });
      await pc.setLocalDescription(offer); console.debug('[OFFER] setLocal ok; gather=', pc.iceGatheringState);
      if (NON_TRICKLE) await waitIceComplete(pc, 2500);
      const final = pc.localDescription || offer;
      console.debug('[OFFER] wsSend offer');
      if (typeof window.wsSend === 'function') {
        window.wsSend('offer', { type: 'offer', sdp: final.sdp });
        offerSent = true; window.__SEND_OFFER_ONCE__ = true; log.ui('send offer');
        if (offerRetryTimer) { clearTimeout(offerRetryTimer); offerRetryTimer = null; }
      } else {
        console.warn('[OFFER] wsSend missing; cannot transmit');
      }
    } catch (e) {
      offerSent = false; console.error('[OFFER] error', e);
    } finally {
      offerInProgress = false;
      console.debug('[OFFER] done; ice=', pc && pc.iceConnectionState);
    }
  }

  async function acceptIncoming(offer, onTrackCb) {
    try {
      if (!offer) { console.warn('[ACCEPT] no offer'); return; }
      if (!pc) createPC(onTrackCb);
      const sdp = typeof offer === 'string' ? offer : (offer.sdp || (offer.payload && offer.payload.sdp) || (offer.offer && offer.offer.sdp) || '');
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      log.ui('remote offer applied');
      await getMic();
      await ensureAudioSender();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (NON_TRICKLE) await waitIceComplete(pc, 2500);
      const final = pc.localDescription || answer;
      if (typeof window.wsSend === 'function') { window.wsSend('answer', final); log.ui('send answer'); }
      // flush queued ICE
      while (remoteIceQueue.length) {
        const c = remoteIceQueue.shift();
        try { await pc.addIceCandidate(typeof c === 'string' ? { candidate: c } : c); }
        catch (_) { /* ignore */ }
      }
    } catch (e) {
      console.error('[ACCEPT] error', e);
    }
  }

  async function addRemoteIce(candidate) {
    if (!pc) { remoteIceQueue.push(candidate); return; }
    if (!pc.remoteDescription) { remoteIceQueue.push(candidate); return; }
    if (candidate == null) { try { await pc.addIceCandidate(null); } catch (_) {} return; }
    const init = typeof candidate === 'string' ? { candidate: candidate } : candidate;
    try { await pc.addIceCandidate(init); console.debug('[ICE<-REMOTE] added'); }
    catch (e) { console.error('[ICE<-REMOTE] add failed', e); }
  }

  function cleanup(reason = '') {
    try {
      if (pc) { pc.close(); pc = null; }
      localStream = null; offerSent = false; offerInProgress = false; negotiationScheduled = false; remoteIceQueue.length = 0;
      window.addLog && window.addLog('info', 'cleanup ' + (reason || ''));
    } catch (_) {}
  }

  // Public API
  window.__WEBRTC__ = { getPC, createPC, getMic, sendOfferIfPossible, acceptIncoming, addRemoteIce, cleanup };
  window.getPC = window.getPC || getPC;
  window.sendOfferIfPossible = window.sendOfferIfPossible || sendOfferIfPossible;
  window.acceptIncoming = window.acceptIncoming || acceptIncoming;
})();
