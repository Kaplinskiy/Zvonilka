// src/webrtc/peer.js
// WebRTC peer primitives (stubs)
// -----------------------------------------------------------------------------
// This module defines future-facing APIs for microphone access and
// RTCPeerConnection management. For now, it intentionally exposes
// stub implementations that throw, so any accidental usage fails loudly
// during integration tests and development builds.
//
// Why stubs?
// - Keeps import graph stable while higher-level modules (UI/signaling)
//   are being refactored.
// - Makes missing wiring explicit in CI and in local runs.
// - Prevents silent no-op behavior that hides integration issues.
//
// Contract:
// - getMic(): Promise<MediaStream>
// - createPC(onTrack?: (ms: MediaStream) => void): RTCPeerConnection
//
// Replace these stubs with real implementations once wiring is ready.
// -----------------------------------------------------------------------------

/**
 * Acquire user's microphone stream.
 * @returns {Promise<MediaStream>}
 * @throws Always throws until the WebRTC layer is wired.
 */
export async function getMic() {
  throw new Error('webrtc not wired yet: getMic()');
}

/**
 * Create and initialize an RTCPeerConnection.
 * @param {(ms: MediaStream) => void} [onTrack] - Callback invoked when a remote MediaStream arrives.
 * @returns {RTCPeerConnection}
 * @throws Always throws until the WebRTC layer is wired.
 */
export function createPC(onTrack) {
  void onTrack; // placeholder to document the expected signature
  throw new Error('webrtc not wired yet: createPC()');
}