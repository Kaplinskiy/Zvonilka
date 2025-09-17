// public/js/helpers.js
// Набор вспомогательных функций. Подключается до основного скрипта.
// Каждая функция безопасно публикуется в window, не переопределяя уже существующие.

(function(){
  function __addLog(level, msg){
    const list = document.getElementById('logList');
    if (!list) return;
    const el = document.createElement('div');
    el.className = 'it';
    el.textContent = `[${new Date().toLocaleTimeString()}] ${String(level).toUpperCase()}: ${msg}`;
    list.prepend(el);
  }

  function __setStatus(text, cls){
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = text;
    el.className = cls || '';
  }

  function __parseRoom(){
    return new URL(location.href).searchParams.get('room');
  }

  function __detectInApp(){
    const ua = navigator.userAgent || '';
    const isWA = /WhatsApp/i.test(ua) || (/wv\)/i.test(ua) && /WhatsApp/i.test(navigator.appVersion||''));
    const isFB = /FBAN|FBAV|FB_IAB|FBAN\//i.test(ua);
    const isIG = /Instagram/i.test(ua);
    const isTG = /Telegram/i.test(ua);
    return { inApp: (isWA || isFB || isIG || isTG) };
  }

  function __renderEnv(){
    const secure = window.isSecureContext;
    const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const hasPC  = (typeof RTCPeerConnection === 'function');
    const d = __detectInApp();

    const dbgProto  = document.getElementById('dbgProto');
    const dbgSecure = document.getElementById('dbgSecure');
    const dbgGUM    = document.getElementById('dbgGUM');
    const dbgPC     = document.getElementById('dbgPC');
    const dbgUA     = document.getElementById('dbgUA');
    const dbgInApp  = document.getElementById('dbgInApp');

    if (dbgProto)  dbgProto.textContent  = location.protocol;
    if (dbgSecure) dbgSecure.textContent = String(secure);
    if (dbgGUM)    dbgGUM.textContent    = String(hasGUM);
    if (dbgPC)     dbgPC.textContent     = String(hasPC);
    if (dbgUA)     dbgUA.textContent     = navigator.userAgent;
    if (dbgInApp)  dbgInApp.textContent  = d.inApp ? 'in-app' : 'нет';
  }

  // Публикуем в window, не переписывая, если уже есть (для совместимости)
  try {
    if (typeof window !== 'undefined') {
      if (!window.addLog)     window.addLog     = __addLog;
      if (!window.setStatus)  window.setStatus  = __setStatus;
      if (!window.parseRoom)  window.parseRoom  = __parseRoom;
      if (!window.detectInApp)window.detectInApp= __detectInApp;
      if (!window.renderEnv)  window.renderEnv  = __renderEnv;
    }
  } catch {}
})();
