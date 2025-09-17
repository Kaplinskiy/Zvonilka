// Заглушки WebRTC: будущие API для микрофона и RTCPeerConnection.

export async function getMic() {
  throw new Error('webrtc not wired yet');
}

export function createPC() {
  throw new Error('webrtc not wired yet');
}