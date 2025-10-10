// public/js/webrtc.js
// WebRTC logic. Exposes functions on the window object for use in index.html.
// This script is loaded before a large inline script.

(function () {
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
   * @param {RTCIceCandidateInit} c - ICE candidate object.
   */
  async function addRemoteIce(c){
    if (!pc) return;
    // если remoteDescription ещё нет — очередь
    if (!pc.remoteDescription) { window.__REMOTE_ICE_Q.push(c); return; }
    try { await pc.addIceCandidate(c); } catch {}
  }
  
  async function applyAnswer(ans){
    if (!pc) throw new Error('pc is not initialized');
    // поддерживаем оба формата: объект {type,sdp} и сырой SDP/объект с sdp
    const desc = (ans && ans.type) ? ans : { type: 'answer', sdp: (ans && ans.sdp) ? ans.sdp : ans };
    await pc.setRemoteDescription(new RTCSessionDescription(desc));
    // вылить отложенные ICE
    try {
      if (Array.isArray(window.__REMOTE_ICE_Q) && window.__REMOTE_ICE_Q.length) {
        for (const c of window.__REMOTE_ICE_Q.splice(0)) {
          try { await pc.addIceCandidate(c); } catch {}
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
        s.urls = list.map(u => {
          if (!t.forceRelay) return u;
          // ensure tcp transport for relayed paths
          if (/^turns?:/i.test(u) && !/transport=tcp/i.test(u)) {
            return u + (u.includes('?') ? '&' : '?') + 'transport=tcp';
          }
          return u;
        });
        return s;
      });
      const cfg = { iceServers: norm };
      if (t.forceRelay || isMobile) cfg.iceTransportPolicy = 'relay';
      return cfg;
    }
    return fallback;
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
    try {
      window.addLog && window.addLog('webrtc', 'create RTCPeerConnection ' + (cfg.iceTransportPolicy ? `(policy=${cfg.iceTransportPolicy})` : ''));
    } catch {}
    pc = new RTCPeerConnection(cfg);

    // Extra diagnostics
    pc.onicecandidateerror = (e) => {
      try { window.addLog && window.addLog('webrtc', `icecandidateerror code=${e.errorCode} text=${e.errorText||''} url=${e.url||''}`); } catch {}
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
        window.wsSend && window.wsSend('ice', e.candidate);
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

    // Add all local media tracks to the peer connection for sending to remote peer
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }
    return pc;
  }

  /**
   * Creates and sends an SDP offer to the remote peer if the signaling WebSocket is open,
   * and if an offer has not already been sent (unless forced).
   * Updates internal state to reflect that an offer has been sent.
   * Logs signaling activity and errors.
   * @param {boolean} force - If true, forces sending an offer even if one was sent before.
   */
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