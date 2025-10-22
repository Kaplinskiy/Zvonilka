// public/js/webrtc.js
// Cleaned and instrumented WebRTC core for Zvonilka.
// Exposes a small, stable API on window: { getMic, createPC, sendOfferIfPossible, acceptIncoming, addRemoteIce, cleanup, getPC }
// Detailed console logs (prefixed) help diagnose negotiation/ICE issues.
// public/js/webrtc.js — minimal, robust WebRTC core for Zvonilka
// Exposes a small, stable API on window.__WEBRTC__ and verbose logs for diagnostics.
// Design goals: single RTCPeerConnection, reliable offer timing, TCP‑friendly ICE, clear logs.

(function () {
  if (typeof window !== 'undefined') {
    if (window.__WEBRTC_INITED__) { console.warn('[WEBRTC] already initialized'); return; }
    window.__WEBRTC_INITED__ = true;
  }
  /** @type {RTCPeerConnection|null} */ let pc = null;
  /** @type {MediaStream|null} */ let localStream = null;
  /** @type {boolean} */ let offerSent = false;
  /** @type {boolean} */ let offerInProgress = false;
  /** @type {boolean} */ let negotiationScheduled = false;
  /** @type {number|null} */ let offerRetryT = null;
  /** @type {any[]} */ const remoteIceQ = (window.__REMOTE_ICE_Q = Array.isArray(window.__REMOTE_ICE_Q) ? window.__REMOTE_ICE_Q : []);

  const NON_TRICKLE = true; // send full SDP after gathering to avoid one‑way audio

  // ---------- Helpers ----------
  const log = {
    d: (...a) => { try { console.debug('[WEBRTC]', ...a); } catch {} },
    i: (...a) => { try { console.info('[WEBRTC]', ...a); } catch {} },
    w: (...a) => { try { console.warn('[WEBRTC]', ...a); } catch {} },
    e: (...a) => { try { console.error('[WEBRTC]', ...a); } catch {} },
    ui: (k, v='') => { try { window.addLog && window.addLog('webrtc', v ? `${k}: ${v}` : k); } catch {} },
  };
  const role = () => { try { return new URLSearchParams(location.search).get('role') || window.role || null; } catch { return window.role || null; } };
  const wsReady = () => !!(window.ws && window.ws.readyState === 1);
  const getPC = () => pc;
  const delay = (ms)=> new Promise(r=>setTimeout(r,ms));

  async function waitIceComplete(target, ms=2500){
    const t0 = Date.now();
    while (Date.now()-t0 < ms) {
      if (!target) return;
      if (target.iceGatheringStatus === 'complete' || target.iceGatheringState === 'complete') return;
      await delay(60);
    }
  }

  async function getMic(){
    if (localStream) return localStream;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1 } });
      localStream = s; log.ui('mic ok');
      return s;
    } catch(e){ log.e('mic error', e); throw e; }
  }

  async function ensureAudioSender(){
    if (!pc) return; if (!localStream) return;
    const track = localStream.getAudioTracks && localStream.getAudioTracks()[0]; if (!track) return;
    track.enabled = true;
    const ex = pc.getSenders && pc.getSenders().find(x=>x.track && x.track.kind==='audio');
    if (ex) { try { await ex.replaceTrack(track); log.d('sender: replaced track'); } catch{}
    } else {
      try {
        const tx = pc.getTransceivers && pc.getTransceivers()[0];
        if (!tx) pc.addTransceiver('audio',{direction:'sendrecv'}); else if (tx.direction!=='sendrecv') tx.direction='writable';
        pc.addTrack(track, localStream);
        log.d('sender: added track');
      } catch(e){ log.e('sender add failed', e); }
    }
  }

  function buildIceConfig(){
    const t = window.__TURN__ || {};
    const fallback={ iceServers:[{urls:'stun:stun.l.google.com:19302'}] };
    if (!t.ice​Servers || !Array.isArray(t.ice​Servers) || !t.ice​Servers.length){
      log.i('ICE: using STUN fallback'); return fallback;
    }
    const norm = t.ice​Servers.map(s=>({ ...s, urls: Array.isArray(s.urls)?s.urls:[s.urls] }))
      .map(s=>{
        const out = [];
        for (const u of s.urls){ if(!u) continue; if(/^turns?:\/\//i.test(u)){ out.push(u); continue; }
          const host = String(u).replace(/^https?:\/\//,'');
          out.push(`turns:${host.replace(/:.*/, '')}:443?transport=tcp`);
        }
        // if forceRelay => keep only TCP
        let urls = Array.from(new Set(out)).filter(u=>/^turns:/i.test(u));
        return { urls, username:s.username, credential:s.credential, credentialType:s.credentialType||'password' };
      });
    const cfg = { iceServers: norm };
    if (t.forceRelay) cfg.iceTransportPolicy='relay';
    try{ console.log('[ICE CONFIG DEBUG]', JSON.stringify(cfg,null,2)); }catch{}
    return cfg;
  }

  function ensureRemoteAudio(){
    let a = document.getElementById('remoteAudio')||document.querySelector('audio');
    if(!a){ a=document.createElement('audio'); a.id='remoteAudio'; a.autoplay=true; a.playsInline=true; a.style.display='none'; document.body.appendChild(a);}
    return a;
  }

  async function createPC(onTrackCb){
    const cfg = buildIceConfig();
    console.log('[CREATE PC] config', JSON.stringify(cfg));
    pc = new RTCPeerConnection(cfg);

    pc.onicecandidate = (e)=>{
      if(e.candidate){ log.ui('send ice'); if(!NON_TRICKLE && window.ws?.readyState===1){ const init=e.candidate.toJSON?e.candidate.toJSON():e.candidate; window.wsSend && window.wsSend('ice', init);} }
      else { log.ui('ice end'); if(!NON_TRICKLE) window.wsSend && window.wsSend('ice', null); }
    };
    pc.onicegatheringstatechange = ()=>{ log.ui('gathering='+pc.iceGatheringState); if(pc.ice​gatheringState==='complete'){ log.ui('ICE gathering complete'); } };
    pc.oniceconnectionstatechange = ()=>{ const st=pc.iceConnectionState; log.ui('ice='+st); if(st==='connected'){ console.debug('[ICE] connected'); } if(st==='failed'){ try{ pc.restartIce(); log.ui('restartIce (failed)'); }catch{}} };
    pc.onconnectionstatechange = ()=>{ const st=pc.connectionState; log.ui('state='+st); };
    pc.ontrack = (e)=>{ const s=e.streams?.[0]|| (e.track? new MediaStream([e.track]):null); if(onTrackCb&&s) onTrackCb(s); try{ log.ui('webrtc.remote_track'); const a=ensureRemoteAudio(); a.srcObject=s; a.muted=false; a.play().catch(()=>{});}catch{}};

    // ensure one audio m-line
    try{ const tx=pc.getTransceivers?.()[0]; if(!tx) pc.addTransceiver('audio',{direction:'sendrecv'});}catch{}

    // caller-only offer on negotiation when WS ready
    pc.onnegotiationneeded=()=>{
      const r=role(); console.debug('[NEGOTIATION] event role=',r,'wsReady=',wsReady());
      if(r!=='mot(){ console.warn('[NEGOTIATION] not caller, request renegotiate'); if(r==='callee'&&window.wsSend){ try{window.wsSend('renegotiate',{reason:'onnegotiationneeded'});}catch{}} return; }
      if(!wsReady()){ console.debug('[NEGOTIATION] ws not ready'); return; }
      if(offerInProgress||offerSent||negotiationScheduled){ console.debug('[NEGOTIATION] skip, busy'); return; }
      negotiationScheduled=true; setTimeout(()=>{ sendOfferIfPossible().finally(()=>{negotiationScheduled=false;});},300);
    };

    // attach existing local tracks if present
    if(localStream){ for(const t of localStream.getTracks()){ const has = pc.getSenders?.().some(s=>s.track&&s.track.kind===t.kind); if(!has) pc.addTrack(t, localStream); }}

    return pc;
  }

  async function sendOfferIfPossible(){
    console.log('[OFFER] enter','wsReady=',wsReady(),'role=',role(),'pc?',!!pc,'state=',pc&&pc.signalingState);
    if(offerInProgress||offerSent){ console.debug('[OFFER] already in flight or sent'); return; }
    if(!wsReady()){ console.warn('[OFFER] ws not ready, retry'); if(!offerRetryT){ offerRetryT=setTimeout(()=>{offerRetryT=null; sendOfferIfPossible().catch(()=>{});},250);} return; }
    if(role()!=='caller'){ console.debug('[OFFER] not caller'); return; }
    if(!pc){ console.warn('[OFFER] no pc'); return; }
    if(pc.signalingState!=='stable'){ console.debug('[OFFER] not stable:',pc.signalingState); return; }

    offerInProgress=true;
    try{
      if(!localStream){ await getMic(); }
      await ensureAudioSender();
      const off= await pc.createOffer({offerToReceiveAudio:1});
      await pc.setLocalDescription(off); console.debug('[OFFER] setLocal ok, gather=',pc.iceGatheringState);
      if(NON_TRICKLE) await waitIceComplete(pc,2500);
      const final = pc.localDescription || off;
      console.debug('[OFFER] wsSend offer');
      window.wsSend && window.wsSend('offer',{type:'offer',sdp:final.sdp});
      offerSent=true; window.__OFFER_SENT__=true; log.ui('send offer');
    }catch(e){ console.error('[OFFER] error',e); offerSent=false; }
    finally{ offerInProgress=false; console.debug('[OFFER] done, ice=',pc&&pc.iceConnectionState); }
  }

  async function acceptIncoming(off,onTrackCb){
    try{
      if(!off){ console.warn('[ACCEPT] no offer'); return; }
      if(!pc){ createPC(onTrackCb); }
      const sdp = typeof off==='string'?off:(off.sdp||off?.payload?.sdp||off?.offer?.sdp||'');
      await pc.setRemoteDescription(new RTCSessionDescription({type:'offer',sdp}));
      if(!localStream){ await getMic(); }
      await ensureAudioSender();
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      if(NON_TRICKLE) await waitIceComplete(pc,2500);
      window.wsSend && window.wsSend('answer', pc.localDescription || ans); log.ui('send answer');
      // flush queued ICE
      while(remoteIceQ.length){ const c=remoteIceQ.shift(); try{ await pc.addIceCandidate(typeof c==='string'?{candidate:c}:c);}catch{}}
    }catch(e){ console.error('[ACCEPT] error',e); }
  }

  function cleanup(reason=''){
    try{ if(pc){ pc.close(); pc=null; } localStream=null; offerSent=false; offerInProgress=false; remoteIceQ.length=0; window.addLog&&window.addLog('info','cleanup '+reason);}catch{}
  }

  // Expose public API
  window.__WEBRTC__={ getPC, getMic, createPC, sendOfferIfPossible, acceptIncoming, addRemoteIce:(c)=>{ if(!pc){remoteIceQ.push(c); return;} acceptIncoming && addRemoteIce(c); }, cleanup };
  window.getPC = window.getPC || getPC;
  window.sendOfferIfPossible = window.sendOfferIfPossible || sendOfferIfPossible;
  window.acceptIncoming = window.acceptIncoming || acceptIncoming;
})();
