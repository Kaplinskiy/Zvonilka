// src/utils/url.js
// Utility for working with URL parameters. Compatible with the current index.html,
// where parseRoom() is called globally. Exposed on the window object to avoid breaking
// existing calls until a complete refactor is performed.

export function parseRoom() {
  return new URL(location.href).searchParams.get('room');
}

// Bridge to the global scope
// This block attempts to attach the parseRoom function to the global window object
// if it is not already defined. This ensures backward compatibility with existing
// code that relies on a global parseRoom function.
// The try-catch handles environments such as web workers where 'window' is undefined.
try {
  if (typeof window !== 'undefined' && !window.parseRoom) {
    window.parseRoom = parseRoom;
  }
} catch { /* window is not available in web workers — ignore silently */ }