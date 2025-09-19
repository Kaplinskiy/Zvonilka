// public/js/ui.js
// UI-хелперы: диалоги, отладка, шаринг, копирование. Публикует shareRoomLink().
(function(){
  // Кэшируем DOM
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

  // Диалоги / отладка
  if (btnHowTo && dlgHowTo) btnHowTo.onclick = () => dlgHowTo.showModal();
  if (btnAbout && dlgAbout) btnAbout.onclick = () => dlgAbout.showModal();
  if (btnDebug && debugBlock) btnDebug.onclick = () => debugBlock.classList.toggle('hidden');

  // Шаринг / копирование ссылки
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

  // Диагностический отчёт
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

  // Генерация ссылки приглашения
  function shareRoomLink(rid){
    const base = location.origin + location.pathname;
    const link = `${base}?room=${encodeURIComponent(rid)}`;
    if (shareLinkEl) shareLinkEl.value = link;
    if (shareWrap) shareWrap.classList.remove('hidden');
  }

  // Экспорт
  if (!window.shareRoomLink) window.shareRoomLink = shareRoomLink;
  window.__UI__ = { shareRoomLink };
})();