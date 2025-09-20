// src/utils/env.js
// Environment detection and rendering status in the debug panel.
// Export functions to the window object to allow the current index.html to call them without modification.

/**
 * Detects if the current environment is running inside a known in-app browser context.
 * Checks user agent strings for WhatsApp, Facebook, Instagram, and Telegram in-app browsers.
 * @returns {Object} An object with a boolean property 'inApp' indicating in-app browser status.
 */
export function detectInApp() {
  const ua = navigator.userAgent || '';
  // Detect WhatsApp in-app browser by user agent or webview pattern with WhatsApp in appVersion
  const isWA = /WhatsApp/i.test(ua) || (/wv\)/i.test(ua) && /WhatsApp/i.test(navigator.appVersion||''));
  // Detect Facebook in-app browser by specific Facebook app identifiers in user agent
  const isFB = /FBAN|FBAV|FB_IAB|FBAN\//i.test(ua);
  // Detect Instagram in-app browser by presence of 'Instagram' in user agent
  const isIG = /Instagram/i.test(ua);
  // Detect Telegram in-app browser by presence of 'Telegram' in user agent
  const isTG = /Telegram/i.test(ua);
  return { inApp: (isWA || isFB || isIG || isTG) };
}

/**
 * Updates the debug panel elements with current environment information.
 * Displays protocol, secure context status, availability of getUserMedia, RTCPeerConnection support,
 * user agent string, and whether the app is running inside an in-app browser.
 */
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

// Expose the detection and rendering functions to the global window object
// for compatibility with legacy code that calls these functions directly.
try {
  if (typeof window !== 'undefined') {
    if (!window.detectInApp) window.detectInApp = detectInApp;
    if (!window.renderEnv)   window.renderEnv   = renderEnv;
  }
} catch { /* Ignore errors in environments without window (e.g., web workers) */ }