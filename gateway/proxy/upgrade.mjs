import net from 'node:net';

import { forwardHeaders } from './http.mjs';

export function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Pipes a WebSocket upgrade to the child on `port` at the TCP level
 * (/ws, /shell, /desktop-notifications, /plugin-ws/*; mydocs/03 5.2).
 */
export function proxyUpgrade(req, socket, head, { port, clientIp, proto, onOpen, onClose }) {
  const headers = forwardHeaders(req, { clientIp, proto });
  // forwardHeaders drops hop-by-hop headers; an upgrade needs them back.
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade;

  const upstream = net.connect(port, '127.0.0.1');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    upstream.destroy();
    socket.destroy();
    onClose();
  };

  upstream.once('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) lines.push(`${name}: ${item}`);
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    onOpen();
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('error', close);
  upstream.on('close', close);
  socket.on('error', close);
  socket.on('close', close);
}
