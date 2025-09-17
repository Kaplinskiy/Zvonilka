// src/utils/url.js
// Утилита работы с URL-параметрами. Совместима с текущим index.html,
// где глобально вызывается parseRoom(). Публикуем в window, чтобы
// не ломать существующие вызовы до полного рефакторинга.

export function parseRoom() {
  return new URL(location.href).searchParams.get('room');
}

// мост в глобальную область видимости
try {
  if (typeof window !== 'undefined' && !window.parseRoom) {
    window.parseRoom = parseRoom;
  }
} catch { /* нет window в воркерах — игнорируем */ }