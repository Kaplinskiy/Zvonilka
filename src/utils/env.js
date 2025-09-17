// src/utils/env.js
// Детекция окружения и отрисовка статуса в отладочной панели.
// Публикуем функции в window, чтобы текущий index.html мог их вызывать без изменений.

export function detectInApp() {
  const ua = navigator.userAgent || '';
  const isWA = /WhatsApp/i.test(ua) || (/wv\)/i.test(ua) && /WhatsApp/i.test(navigator.appVersion||''));
  const isFB = /FBAN|FBAV|FB_IAB|FBAN\//i.test(ua);
  const isIG = /Instagram/i.test(ua);
  const isTG = /Telegram/i.test(ua);
  return { inApp: (isWA || isFB || isIG || isTG) };
}

export function renderEnv() {
  const dbgProto  = document.getElementById('dbgProto');
  const dbgSecure = document.getElementById('dbgSecure');
  const dbgGUM    = document.getElementById('dbgGUM');
  const dbgPC     = document.getElementById('dbgPC');
  const dbgUA     = document.getElementById('dbgUA');
  const dbgInApp  = document.getElementById('dbgInApp');

  const secure = window.isSecureContext;
  const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasPC  = (typeof RTCPeerConnection === 'function');
  const d = detectInApp();

  if (dbgProto)  dbgProto.textContent  = location.protocol;
  if (dbgSecure) dbgSecure.textContent = String(secure);
  if (dbgGUM)    dbgGUM.textContent    = String(hasGUM);
  if (dbgPC)     dbgPC.textContent     = String(hasPC);
  if (dbgUA)     dbgUA.textContent     = navigator.userAgent;
  if (dbgInApp)  dbgInApp.textContent  = d.inApp ? 'in-app' : 'нет';
}

// мосты в глобальную область видимости для совместимости со старым кодом
try {
  if (typeof window !== 'undefined') {
    if (!window.detectInApp) window.detectInApp = detectInApp;
    if (!window.renderEnv)   window.renderEnv   = renderEnv;
  }
} catch { /* воркеры/нет window — игнорируем */ }