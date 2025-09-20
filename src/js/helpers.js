// public/js/helpers.js
// A set of helper functions. Loaded before the main script.
// Each function is safely published to the window object without overriding existing ones.

(function(){
  /**
   * Attempts to translate a given key or text using the i18next library if available.
   * Falls back to returning the original keyOrText if translation is not possible.
   * @param {string} keyOrText - The translation key or text to be translated.
   * @returns {string} - The translated string or the original input if translation fails.
   */
  function __tMaybe(keyOrText) {
    try {
      if (window.i18next && window.i18next.t) {
        return window.i18next.t(keyOrText);
      }
    } catch {}
    return keyOrText;
  }

  /**
   * Adds a log message to the DOM element with id 'logList'.
   * Prepends the log entry with a timestamp and log level.
   * Does nothing if the log container element does not exist.
   * @param {string} level - The log level (e.g., 'info', 'error').
   * @param {string} msg - The message to log.
   */
  function __addLog(level, msg){
    const list = document.getElementById('logList');
    if (!list) return;
    const el = document.createElement('div');
    el.className = 'it';
    el.textContent = `[${new Date().toLocaleTimeString()}] ${String(level).toUpperCase()}: ${msg}`;
    list.prepend(el);
  }

  /**
   * Sets the status text and optional CSS class on the DOM element with id 'status'.
   * The status text is passed through the translation function to support localization.
   * Does nothing if the status element does not exist.
   * @param {string} text - The status text to display.
   * @param {string} [cls] - Optional CSS class to apply to the status element.
   */
  function __setStatus(text, cls){
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = __tMaybe(text);
    el.className = cls || '';
  }

  /**
   * Parses the current page URL and extracts the value of the 'roomId' query parameter.
   * @returns {string|null} - The value of the 'roomId' parameter or null if not present.
   */
  function __parseRoom(){
    return new URL(location.href).searchParams.get('roomId');
  }

  /**
   * Detects whether the current environment is running inside certain popular in-app browsers.
   * Checks for WhatsApp, Facebook, Instagram, and Telegram in-app browser user agents.
   * @returns {Object} - An object with a boolean 'inApp' property indicating in-app browser presence.
   */
  function __detectInApp(){
    const ua = navigator.userAgent || '';
    const isWA = /WhatsApp/i.test(ua) || (/wv\)/i.test(ua) && /WhatsApp/i.test(navigator.appVersion||''));
    const isFB = /FBAN|FBAV|FB_IAB|FBAN\//i.test(ua);
    const isIG = /Instagram/i.test(ua);
    const isTG = /Telegram/i.test(ua);
    return { inApp: (isWA || isFB || isIG || isTG) };
  }

  /**
   * Renders environment diagnostics by updating specific DOM elements with relevant information:
   * - Protocol used by the page
   * - Whether the context is secure (HTTPS)
   * - Availability of getUserMedia API
   * - Availability of RTCPeerConnection API
   * - User agent string
   * - Whether running inside an in-app browser
   * Does nothing if the target DOM elements are not found.
   */
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
    if (dbgInApp)  dbgInApp.textContent  = d.inApp ? 'in-app' : 'no';
  }

  // Publish helper functions on the global window object without overwriting existing ones
  // This ensures compatibility with other scripts that may have defined these functions.
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
