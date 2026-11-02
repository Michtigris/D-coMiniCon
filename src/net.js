export function createSocket(url, { onOpen, onClose, onEvent }) {
  let socket = null;
  let closed = false;
  let attempt = 0;
  let timer = 0;

  function endpoint() {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = '/ws';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  }

  function connect() {
    socket = new WebSocket(endpoint());
    socket.addEventListener('open', () => {
      attempt = 0;
      onOpen();
    });
    socket.addEventListener('message', (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        // Un message illisible est ignoré.
      }
    });
    socket.addEventListener('close', () => {
      socket = null;
      if (closed) return;
      onClose();
      if (closed) return;
      const delay = Math.min(8000, 400 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    });
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function stop() {
    closed = true;
    clearTimeout(timer);
    try {
      socket?.close();
    } catch {
      // Déjà fermé.
    }
  }

  connect();
  return { send, stop };
}
