import { COOKIE_NAME, issueSessionValue, parseCookies, readSessionValue, serializeClearedCookie, serializeCookie } from './cookie.mjs';

export function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? '';
}

export function requestProto(req, config) {
  if (req.socket.encrypted) return 'https';
  if (config.trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https') return 'https';
  return 'http';
}

/** The account behind the request's gateway cookie, or null (expired, tampered, password reset). */
export function currentAccount(req, ctx) {
  const claims = readSessionValue(ctx.secret, parseCookies(req.headers.cookie)[COOKIE_NAME]);
  if (!claims) return null;
  const account = ctx.store.getById(claims.uid);
  return account && account.password_version === claims.pv ? account : null;
}

export function setSessionCookie(req, res, ctx, account) {
  const value = issueSessionValue(ctx.secret, account, ctx.config.cookieMaxAgeMs);
  res.setHeader('Set-Cookie', serializeCookie(value, { maxAgeMs: ctx.config.cookieMaxAgeMs, secure: requestProto(req, ctx.config) === 'https' }));
}

export function clearSessionCookie(req, res, ctx) {
  res.setHeader('Set-Cookie', serializeClearedCookie({ secure: requestProto(req, ctx.config) === 'https' }));
}

/** Only same-origin absolute paths are accepted as a post-login target. */
export function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/__gw/') ? value : '/';
}
