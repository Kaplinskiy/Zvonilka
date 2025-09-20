/**
 * Logger utility for UI and console.
 * - Adds log lines to #logList if present.
 * - Optionally mirrors to console.
 * - Attaches `window.logger` if not already defined.
 *
 * Usage:
 *   window.logger.log('Hello');
 *   window.logger.setConsoleMirroring(false);
 */
(function () {
  // Do not override an existing implementation.
  if (typeof window !== 'undefined' && window.logger) return;

  /** @type {boolean} mirrors to console.log when true */
  let mirrorToConsole = true;

  /**
   * Append a line to the on-page log container.
   * No-op if #logList is absent.
   * @param {string} message
   */
  function addLogToUI(message) {
    try {
      const el = document.getElementById('logList');
      if (!el) return;
      const row = document.createElement('div');
      const ts = new Date().toLocaleTimeString();
      row.className = 'it';
      row.textContent = `[${ts}] ${message}`;
      el.appendChild(row);
      el.scrollTop = el.scrollHeight;
    } catch {}
  }

  /**
   * Log one or more values.
   * Serializes objects to JSON where possible.
   * @param {...any} args
   */
  function log(...args) {
    const msg = args.map(a => {
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return '[object]'; }
      }
      return String(a);
    }).join(' ');
    addLogToUI(msg);
    if (mirrorToConsole) try { console.log('[logger]', ...args); } catch {}
  }

  /**
   * Enable or disable console mirroring.
   * @param {boolean} enable
   */
  function setConsoleMirroring(enable) {
    mirrorToConsole = !!enable;
  }

  // Expose API
  if (typeof window !== 'undefined') {
    window.logger = { log, setConsoleMirroring };
    // Backwards compat: wire into legacy addLog if not present.
    if (!window.addLog) window.addLog = (level, message) => log(level + ':', message);
  }
})();