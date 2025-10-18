// public/js/webrtc.js
// WebRTC logic. Exposes functions on the window object for use in index.html.
// This script is loaded before a large inline script.
// test
(function () {
  if (typeof window !== 'undefined') {
    if (window.__WEBRTC_INITED__) { try { console.warn('[WEBRTC] duplicate init, skipping'); } catch {} return; }
    window.__WEBRTC_INITED__ = true;
  }
  // RTCPeerConnection instance
  let pc = null;
  // Queue for remote ICE candidates that arrive before remote description is set
  window.__REMOTE_ICE_Q ||= [];
  // MediaStream obtained from the local microphone
  let localStream = null;
  // Incoming offer that has not yet been processed
  let pendingOffer = null;
  // Flag indicating whether an offer has been sent to the remote peer
  let offerSent = false;
  let offerInProgress = false;
  let negotiationScheduled = false;

  function __getRole(){
    try {
      const fromUrl = new URLSearchParams(location.search).get('role');
      if (fromUrl) return fromUrl;
      if (typeof window !== 'undefined' && window.role) return window.role; // fallback to app state
      return null;
    } catch { return (typeof window !== 'undefined' ? window.role || null : null); }
  }
  // Flag indicating whether the remote description has been applied to the peer connection
  let remoteDescApplied = false;

  /**
   * Translation helper function.
   * Attempts to translate a key using i18next if available,
   * otherwise returns the fallback or the key itself.
   * This is used to provide localized status and error messages.
   * @param {string} key - The translation key.
   * @param {string} fallback - The fallback string if translation is unavailable.
   * @returns {string} Translated or fallback string.
   */
  function t(key, fallback) {
    try { return (window.i18next && window.i18next.t) ? window.i18next.t(key) : (fallback || key); }
    catch { return fallback || key; }
  }

  /**
   * Getter for the current RTCPeerConnection instance.
   * @returns {RTCPeerConnection|null} The current peer connection or null.
   */
  function getPC(){ return pc; }

  /**
   * Adds a remote ICE candidate to the peer connection.
   * If the remote description has not yet been applied, the candidate is queued.
   * Accepts raw string or object, and infers sdpMid for single-m-line SDP.
   * @param {RTCIceCandidateInit|string} c - ICE candidate object or string.
   */
  async function addRemoteIce(c){
    if (!pc) return;
    // Queue until remote description is set
    if (!pc.remoteDescription) { window.__REMOTE_ICE_Q.push(c); return; }
    // Normalize candidate shape: allow raw string and missing mid/index
    let init = c;
    // Explicitly handle end-of-candidates
    if (init === null || init === false) { try { await pc.addIceCandidate(null); } catch {}; return; }
    if (typeof init === 'string') init = { candidate: init };
    // Extended m-line normalization
    if (init && typeof init === 'object' && init.candidate) {
      const noMid = !('sdpMid' in init) || init.sdpMid == null;
      const noIdx = !('sdpMLineIndex' in init) || init.sdpMLineIndex == null;
      if (noMid && noIdx) {
        try {
          const tx = pc.getTransceivers && pc.getTransceivers()[0];
          const mid = (tx && tx.mid) || '0';
          init = { ...init, sdpMid: mid, sdpMLineIndex: 0 };
        } catch { init = { ...init, sdpMid: '0', sdpMLineIndex: 0 }; }
      } else if (noMid) {
        try {
          const tx = pc.getTransceivers && pc.getTransceivers()[0];
          init = { ...init, sdpMid: (tx && tx.mid) || '0' };
        } catch { init = { ...init, sdpMid: '0' }; }
      } else if (noIdx) {
        init = { ...init, sdpMLineIndex: 0 };
      }
    }
    try { await pc.addIceCandidate(init); } catch {}
  }

  async function applyAnswer(ans){
    if (!pc) throw new Error('pc is not initialized');
    // Extract SDP string from various shapes: string | {sdp} | {payload:{sdp}} | {answer:{sdp}} | {sdp:{sdp}}
    function extractSdp(x){
      if (!x) return null;
      if (typeof x === 'string') return x;
      if (typeof x.sdp === 'string') return x.sdp;
      if (x.sdp && typeof x.sdp === 'object' && typeof x.sdp.sdp === 'string') return x.sdp.sdp;
      if (x.payload) return extractSdp(x.payload);
      if (x.answer) return extractSdp(x.answer);
      return null;
    }
    const sdpStr = extractSdp(ans);
    const desc = sdpStr ? { type: 'answer', sdp: sdpStr }
                        : ((ans && ans.type) ? ans : { type: 'answer', sdp: String(ans || '') });
    await pc.setRemoteDescription(new RTCSessionDescription(desc));
    // Flush queued ICE
    try {
      if (Array.isArray(window.__REMOTE_ICE_Q) && window.__REMOTE_ICE_Q.length) {
        for (const c of window.__REMOTE_ICE_Q.splice(0)) {
          try { await addRemoteIce(c); } catch {}
        }
      }
    } catch {}
  }
  window.applyAnswer = applyAnswer;

  /**
   * Requests access to the user's microphone and returns the audio MediaStream.
   * Logs success or error messages to the global logger if available.
   * @returns {Promise<MediaStream>} The audio stream from the microphone.
   * @throws Will throw if getUserMedia fails.
   */
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

  /**
   * Retrieves the ICE server configuration for the RTCPeerConnection.
   * Uses a TURN server configuration from window.__TURN__ if available,
   * otherwise falls back to a default Google STUN server.
   * On mobile, enforces relay policy and TURN over TCP/443.
   * @returns {RTCConfiguration} The configuration object for RTCPeerConnection.
   */
  function getIceConfig(){
    const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    const t = (typeof window !== 'undefined') ? window.__TURN__ : null;
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
    if (t && Array.isArray(t.iceServers) && t.iceServers.length) {
      // clone and normalize TURN urls
      const norm = t.iceServers.map(s => ({...s})).map(s => {
        let urls = s.urls;
        if (!urls) return s;
        const list = Array.isArray(urls) ? urls : [urls];
        const out = new Set();
        const valid = /^turns?:\/\/[^\s/?#:]+(?::\d+)?(?:\?.*)?$/i;
        list.forEach((u) => {
          if (!u) return;
          if (valid.test(u)) { out.add(u); return; }
          // Fallback rebuild from hostname only when malformed
          if (!/^turns?:/i.test(u)) { out.add(u); return; }
          const raw = String(u).trim();
          const hostOnly = raw.replace(/^turns?:\/{0,2}/i, '').replace(/^turns?:\/{0,2}/i, '').split('?')[0].split(':')[0];
          const wanted = /transport=tcp/i.test(raw) ? 'tcp' : (/transport=udp/i.test(raw) ? 'udp' : null);
          const rebuilt = (wanted === 'tcp')
            ? `turns:${hostOnly}:443?transport=tcp`
            : `turn:${hostOnly}:3478?transport=udp`;
          out.add(rebuilt);
        });
        s.urls = Array.from(out).filter(u => !!u && /^turns?:/i.test(u));
        return s;
      });
      const cfg = { iceServers: norm };
      try {
        const flat = norm.flatMap(x => (Array.isArray(x.urls) ? x.urls : [x.urls]));
        window.addLog && window.addLog('webrtc', 'ICE servers: ' + flat.join(', '));
      } catch {}
      // Allow all transports during diagnosis; TURN is still preferred via urls
      if (t.forceRelay || isMobile) cfg.iceTransportPolicy = 'relay';
      // Log ICE config before returning
      console.log('[ICE CONFIG DEBUG]', JSON.stringify(cfg, null, 2));
      return cfg;
    }
    // Log fallback ICE config before returning
    console.log('[ICE CONFIG DEBUG]', JSON.stringify(fallback, null, 2));
    return fallback;
  }

  // Refresh TURN credentials and restart ICE on the fly
  async function __refreshTurnAndRestart(pc){
    try {
      const res = await fetch('/turn-credentials?ts=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('turn fetch failed');
      const data = await res.json();
      const credType = data.credentialType || 'password';
      const iceServers = (Array.isArray(data.iceServers) ? data.iceServers : [])
        .map(s => ({ ...s }))
        .map(s => {
          const list = Array.isArray(s.urls) ? s.urls : (s.urls ? [s.urls] : []);
          const norm = new Set();
          const valid = /^turns?:\/\/[^\s/?#:]+(?::\d+)?(?:\?.*)?$/i;
          for (let u of list) {
            if (!u) continue;
            if (valid.test(u)) { norm.add(u); continue; }
            if (!/^turns?:/i.test(u)) { norm.add(u); continue; }
            const raw = String(u).trim();
            const hostOnly = raw.replace(/^turns?:\/{0,2}/i, '').replace(/^turns?:\/{0,2}/i, '').split('?')[0].split(':')[0];
            const wanted = /transport=tcp/i.test(raw) ? 'tcp' : (/transport=udp/i.test(raw) ? 'udp' : null);
            const rebuilt = (wanted === 'tcp')
              ? `turns:${hostOnly}:443?transport=tcp`
              : `turn:${hostOnly}:3478?transport=udp`;
            norm.add(rebuilt);
          }
          const urlsArr = Array.from(norm).filter(u => !!u && /^turns?:/i.test(u));
          return {
            urls: urlsArr,
            username: s.username || data.username,
            credential: s.credential || data.credential,
            credentialType: s.credentialType || credType
          };
        });
      window.__TURN__ = { iceServers, forceRelay: true };
      const cfg = getIceConfig();
      try { pc.setConfiguration(cfg); } catch {}
      try { pc.restartIce(); window.addLog && window.addLog('webrtc','restartIce after TURN refresh'); } catch {}
    } catch (e) {
      window.addLog && window.addLog('error', 'TURN refresh failed: ' + (e.message||e));
    }
  }

  /**
   * Creates and initializes a new RTCPeerConnection with appropriate event handlers.
   * Attaches local media tracks if available.
   * Event handlers log connection state changes and update UI status accordingly.
   * @param {function(MediaStream):void} onTrackCb - Callback invoked when remote media track is received.
   * @returns {RTCPeerConnection} The newly created peer connection.
   */
  function createPC(onTrackCb) {
    const cfg = getIceConfig();
    console.log('[CREATE PC DEBUG] Using config:', JSON.stringify(cfg, null, 2));
    try {
      window.addLog && window.addLog('webrtc', 'create RTCPeerConnection ' + (cfg.iceTransportPolicy ? `(policy=${cfg.iceTransportPolicy})` : ''));
    } catch {}
    pc = new RTCPeerConnection(cfg);
    // Ensure offer is created when negotiation is needed (debounced to avoid double fires)
    pc.onnegotiationneeded = () => {
      const r = __getRole();
      if (r !== 'caller') return; // only caller initiates offer
      if (typeof window !== 'undefined' && window.__OFFER_SENT__) return;
      if (negotiationScheduled) return;
      negotiationScheduled = true;
      setTimeout(async () => {
        try { await sendOfferIfPossible(); } catch {} finally { negotiationScheduled = false; }
      }, 300);
    };

    // Extra diagnostics
    pc.onicecandidateerror = (e) => {
      try { window.addLog && window.addLog('webrtc', `icecandidateerror code=${e.errorCode} text=${e.errorText||''} url=${e.url||''}`); } catch {}
      if ((e.errorCode === 401 || e.errorCode === 403) && !pc.__turnRefreshed) {
        pc.__turnRefreshed = true;
        __refreshTurnAndRestart(pc);
      }
    };
    async function logSelectedPair(label){
      try {
        const stats = await pc.getStats();
        stats.forEach(r => {
          if (r.type === 'transport' && r.selectedCandidatePairId) {
            const pair = stats.get(r.selectedCandidatePairId);
            const local = pair && stats.get(pair.localCandidateId);
            const remote = pair && stats.get(pair.remoteCandidateId);
            if (pair && local && remote) {
              window.addLog && window.addLog('webrtc', `${label}: selected=${pair.nominated} local(${local.candidateType}/${local.protocol}) -> remote(${remote.candidateType}/${remote.protocol})`);
            }
          }
        });
      } catch {}
    }

    // Send ICE candidates to the signaling server as they are gathered
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        try { window.addLog && window.addLog('signal', 'send ice'); } catch {}
        const init = e.candidate && e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
        window.wsSend && window.wsSend('ice', init);
      } else {
        try { window.addLog && window.addLog('webrtc', 'ice end'); } catch {}
        window.wsSend && window.wsSend('ice', null); // end-of-candidates
      }
    };

    // Log ICE gathering state changes for debugging and info
    pc.onicegatheringstatechange = () => {
      const st = pc.iceGatheringState;
      window.addLog && window.addLog('webrtc', `gathering=${st}`);
      if (st === 'complete') {
        window.addLog && window.addLog('webrtc', 'ICE gathering complete');
      }
    };

    // Monitor ICE connection state changes and update UI status accordingly
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      window.addLog && window.addLog('webrtc', `ice=${st}`);
      if (st === 'connected') {
        logSelectedPair('connected');
        window.setStatusKey && window.setStatusKey('status.in_call','ok');
      } else if (st === 'checking') {
        window.setStatusKey && window.setStatusKey('status.connecting', 'warn');
      } else if (st === 'disconnected') {
        window.setStatusKey && window.setStatusKey('status.lost_recovering', 'warn');
        // give it a short window; restart ICE if it persists
        clearTimeout(pc.__iceRetryT);
        pc.__iceRetryT = setTimeout(() => { try { pc.restartIce(); window.addLog && window.addLog('webrtc','restartIce'); } catch {} }, 2500);
      } else if (st === 'failed') {
        logSelectedPair('failed');
        // hard restart once
        try { pc.restartIce(); window.addLog && window.addLog('webrtc','restartIce (failed)'); } catch {}
        window.setStatusKey && window.setStatusKey('error.connection', 'err');
      }
    };

    // Monitor overall connection state changes and update UI status accordingly
    pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        window.addLog && window.addLog('webrtc', `state=${st}`);
        if (typeof window.setStatus === 'function') {
            if (st === 'connected') {
            window.setStatusKey && window.setStatusKey('status.in_call','ok');
            } else if (st === 'connecting') {
            window.setStatusKey('status.connecting', 'warn');
            } else if (st === 'disconnected') {
            window.setStatusKey('status.lost_recovering', 'warn');
            } else if (st === 'failed') {
            window.setStatusKey && window.setStatusKey('error.connection','err');
            } else if (st === 'closed') {
            window.setStatusKey && window.setStatusKey('status.ended','warn');
            }
        }
    };

    // When a remote media track is received, invoke the provided callback with the stream
    pc.ontrack = (e) => {
      if (onTrackCb) onTrackCb(e.streams[0]);
    };

    // Ensure a stable transceiver order to keep m-lines consistent: exactly one audio transceiver
    try {
      const tx = pc.getTransceivers ? pc.getTransceivers() : [];
      if (!tx || tx.length === 0) {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
      } else if (tx.length > 1) {
        // do not add more, rely on single audio m-line
      }
    } catch {}

    // Add all local media tracks, avoiding duplicates for the same kind
    if (localStream) {
      const senders = pc.getSenders ? pc.getSenders() : [];
      for (const track of localStream.getTracks()) {
        const hasSameKind = senders.some(s => s.track && s.track.kind === track.kind);
        if (!hasSameKind) pc.addTrack(track, localStream);
      }
    }

    return pc;
  }

  /**
   * Creates and sends an SDP offer to the remote peer if the signaling WebSocket is open,
   * and if an offer has not already been sent and the signaling state is stable.
   * Updates internal state to reflect that an offer has been sent.
   * Logs signaling activity and errors.
   */
  async function sendOfferIfPossible() {
    if (typeof window !== 'undefined' && window.__OFFER_SENT__) return;
    const r = __getRole();
    if (r !== 'caller') return; // callee never sends offer
    try {
      if (!(window.isWSOpen && window.isWSOpen())) return;
      if (!pc || !localStream) return;
      if (offerSent || offerInProgress) return;
      const st = pc.signalingState;
      if (st && st !== 'stable') return;
      // mutex to avoid concurrent createOffer
      offerInProgress = true;
      const offer = await pc.createOffer({ offerToReceiveAudio: 1 });
      await pc.setLocalDescription(offer);
      const payload = { type: 'offer', sdp: offer.sdp, offer: { type: 'offer', sdp: offer.sdp } };
      window.wsSend && window.wsSend('offer', payload);
      offerSent = true;
      try { if (typeof window !== 'undefined') window.__OFFER_SENT__ = true; } catch {}
      window.addLog && window.addLog('signal', 'send offer');
    } catch (e) {
      // allow retry on next negotiation
      offerSent = false;
      window.addLog && window.addLog('error', 'sendOfferIfPossible: ' + (e.message || e));
    } finally {
      offerInProgress = false;
    }
  }

  /**
   * Accepts an incoming SDP offer, creates an answer, and sends it back.
   * Applies the remote description and adds any queued ICE candidates.
   * Creates a new RTCPeerConnection if one does not exist.
   * Logs errors if the process fails.
   * @param {RTCSessionDescriptionInit} pendingOffer - The incoming SDP offer.
   * @param {function(MediaStream):void} onTrackCb - Callback invoked when remote media is received.
   */
  async function acceptIncoming(pendingOffer, onTrackCb) {
    try {
      if (!pendingOffer) {
        window.addLog && window.addLog('warn', 'acceptIncoming: no offer');
        return;
      }
      // Normalize offer: accept raw string or nested objects
      function extractSdp(x){
        if (!x) return null;
        if (typeof x === 'string') return x;
        if (typeof x.sdp === 'string') return x.sdp;
        if (x.sdp && typeof x.sdp === 'object' && typeof x.sdp.sdp === 'string') return x.sdp.sdp;
        if (x.payload) return extractSdp(x.payload);
        if (x.offer) return extractSdp(x.offer);
        return null;
      }
      const sdpStr = extractSdp(pendingOffer);
      if (sdpStr) pendingOffer = { type: 'offer', sdp: sdpStr };
      if (!pc) createPC(onTrackCb);
      await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      window.wsSend && window.wsSend('answer', answer);
      remoteDescApplied = true;
      // Flush queued ICE that arrived before remote description was set
      if (Array.isArray(window.__REMOTE_ICE_Q) && window.__REMOTE_ICE_Q.length) {
        for (const c of window.__REMOTE_ICE_Q.splice(0)) {
          try { await pc.addIceCandidate(c); } catch {}
        }
      }
    } catch (e) {
      window.addLog && window.addLog('error', 'acceptIncoming: ' + (e.message || e));
    }
  }

  /**
   * Cleans up the current peer connection and resets all related state.
   * Closes the RTCPeerConnection and clears local media stream and internal flags.
   * Logs the cleanup action with an optional reason.
   * @param {string} reason - Optional reason for cleanup, used for logging.
   */
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
      window.addLog && window.addLog('info', 'cleanup ' + reason);
    } catch {}
  }

  // Expose functions on the global window object for external usage
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
