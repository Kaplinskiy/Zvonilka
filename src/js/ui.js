// public/js/ui.js
// UI helpers: dialogs, debugging, sharing, copying. Exposes shareRoomLink().
(function(){
  // Cache DOM elements for later use
  const btnHowTo = document.getElementById('btnHowTo');
  const btnAbout = document.getElementById('btnAbout');
  const btnDebug = document.getElementById('btnDebug');
  const dlgHowTo = document.getElementById('dlgHowTo');
  const dlgAbout = document.getElementById('dlgAbout');
  const debugBlock = document.getElementById('debugBlock');
  const noteEl = document.getElementById('note');
  const shareWrap = document.getElementById('shareWrap');
  const shareLinkEl = document.getElementById('shareLink');
  const btnNativeShare = document.getElementById('btnNativeShare');
  const btnCopy = document.getElementById('btnCopy');
  const btnCopyDiag = document.getElementById('btnCopyDiag');

  // Dialogs and debugging toggles
  // Attach click handlers to open modal dialogs or toggle debug panel visibility
  if (btnHowTo && dlgHowTo) btnHowTo.onclick = () => dlgHowTo.showModal();
  if (btnAbout && dlgAbout) btnAbout.onclick = () => dlgAbout.showModal();
  if (btnDebug && debugBlock) btnDebug.onclick = () => debugBlock.classList.toggle('hidden');

  // Sharing and copying the invitation link
  // Utilize native share API if available, otherwise provide feedback about unavailability
  if (btnNativeShare && shareLinkEl) {
    btnNativeShare.onclick = () => {
      const txt = shareLinkEl.value || '';
      if (navigator.share) {
        navigator.share({
          title: i18next.t('dialog.invite_title'),
          text: i18next.t('call.offer_received_click_answer') + ' ' + txt,
          url: txt
        }).catch(()=>{});
      } else if (noteEl) {
        noteEl.textContent = i18next.t('share.native_unavailable');
      }
    };
  }
  // Copy the invitation link to clipboard with user feedback
  if (btnCopy && shareLinkEl) {
    btnCopy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(shareLinkEl.value||'');
        if (noteEl) noteEl.textContent = i18next.t('common.link_copied');
      }
      catch {
        if (noteEl) noteEl.textContent = i18next.t('common.will_be_generated');
      }
    };
  }

  // Diagnostic report copying functionality
  // Gathers environment and application info and copies it to clipboard or alerts if clipboard fails
  if (btnCopyDiag) {
    btnCopyDiag.onclick = async () => {
      const cfg = (window.__APP_CONFIG__) || { SERVER_URL:'', WS_URL:'' };
      const report = [
        '=== DIAG REPORT ===',
        'url: ' + location.href,
        'secure: ' + window.isSecureContext,
        'protocol: ' + location.protocol,
        'ua: ' + navigator.userAgent,
        'getUserMedia: ' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        'RTCPeerConnection: ' + (typeof RTCPeerConnection),
        'server: ' + cfg.SERVER_URL,
        'ws: ' + cfg.WS_URL,
        'room: ' + ((window.parseRoom && window.parseRoom()) || '-')
      ].join('\n');
      try { await navigator.clipboard.writeText(report); } catch { alert(report); }
    };
  }

  // Generates and displays the invitation link for a given room ID
  // Updates input field and makes the sharing UI visible
  function shareRoomLink(rid){
    const base = location.origin + location.pathname;
    const link = `${base}?room=${encodeURIComponent(rid)}`;
    if (shareLinkEl) shareLinkEl.value = link;
    if (shareWrap) shareWrap.classList.remove('hidden');
  }

  // Export the shareRoomLink function globally if not already defined
  if (!window.shareRoomLink) window.shareRoomLink = shareRoomLink;
  window.__UI__ = { shareRoomLink };
})();