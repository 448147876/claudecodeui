import http from 'node:http';

import { stripGatewayCookie } from '../auth/cookie.mjs';

// Upstream's own login endpoints stay private to the gateway (AUTH-04).
const BLOCKED = [
  ['POST', '/api/auth/register'],
  ['POST', '/api/auth/login'],
];

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

export function isBlocked(req) {
  const pathname = req.url.split('?')[0];
  return BLOCKED.some(([method, blockedPath]) => req.method === method && pathname === blockedPath);
}

export function wantsHtml(req) {
  return req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');
}

/** Headers to send to a child: no gateway cookie, plus forwarding info. */
export function forwardHeaders(req, { clientIp, proto }) {
  const headers = { ...req.headers };
  for (const name of HOP_BY_HOP) delete headers[name];
  const cookie = stripGatewayCookie(headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  headers['x-forwarded-for'] = clientIp;
  headers['x-forwarded-proto'] = proto;
  headers['x-forwarded-host'] = req.headers.host ?? '';
  return headers;
}

function escapeForScript(value) {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Inserts the gateway bootstrap right after <head> (mydocs/03 4.3). */
export function injectBootstrap(html, bootstrap) {
  const tags = `<script>window.__GW__=${escapeForScript(bootstrap)}</script><script src="/__gw/static/inject.js"></script>`;
  const match = /<head[^>]*>/i.exec(html);
  if (!match) return tags + html;
  const at = match.index + match[0].length;
  return html.slice(0, at) + tags + html.slice(at);
}

/**
 * Streams one request to the child on `port`. HTML responses are buffered and
 * get the bootstrap injected; everything else (including SSE) is piped.
 */
export function proxyHttp(req, res, { port, clientIp, proto, getBootstrap, onError, body = null }) {
  const headers = forwardHeaders(req, { clientIp, proto });
  // A body the gateway already read (to inspect it) is sent as-is.
  if (body) {
    delete headers['transfer-encoding'];
    headers['content-length'] = String(body.length);
  }
  const html = wantsHtml(req);
  if (html) headers['accept-encoding'] = 'identity';

  const upstreamReq = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (upstreamRes) => {
    const contentType = String(upstreamRes.headers['content-type'] ?? '');
    if (html && contentType.includes('text/html') && !upstreamRes.headers['content-encoding']) {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', async () => {
        try {
          const body = injectBootstrap(Buffer.concat(chunks).toString('utf8'), await getBootstrap());
          const responseHeaders = { ...upstreamRes.headers };
          delete responseHeaders['content-length'];
          delete responseHeaders.etag;
          delete responseHeaders['last-modified'];
          for (const name of HOP_BY_HOP) delete responseHeaders[name];
          responseHeaders['cache-control'] = 'no-store';
          res.writeHead(upstreamRes.statusCode ?? 200, responseHeaders);
          res.end(body);
        } catch (error) {
          onError(error);
        }
      });
      upstreamRes.on('error', onError);
      return;
    }
    const responseHeaders = { ...upstreamRes.headers };
    for (const name of HOP_BY_HOP.filter((h) => h !== 'transfer-encoding')) delete responseHeaders[name];
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
    upstreamRes.pipe(res);
    res.on('close', () => upstreamRes.destroy());
  });

  upstreamReq.on('error', onError);
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });
  if (body) upstreamReq.end(body);
  else req.pipe(upstreamReq);
}
