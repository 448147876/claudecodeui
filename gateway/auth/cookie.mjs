import crypto from 'node:crypto';
import fs from 'node:fs';

import { writePrivateFile } from '../config.mjs';

export const COOKIE_NAME = 'gw_session';

export function loadOrCreateSecret(file) {
  if (!fs.existsSync(file)) writePrivateFile(file, crypto.randomBytes(32));
  return fs.readFileSync(file);
}

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

/** `base64url(JSON{uid,pv,exp}).signature` */
export function issueSessionValue(secret, account, maxAgeMs) {
  const payload = Buffer.from(JSON.stringify({
    uid: account.id,
    pv: account.password_version,
    exp: Date.now() + maxAgeMs,
  })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns the claims when the value is authentic and unexpired, otherwise null. */
export function readSessionValue(secret, value) {
  if (typeof value !== 'string') return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isInteger(claims.uid) && Number.isInteger(claims.pv) && claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key) cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

/** Removes the gateway cookie from a Cookie header before it reaches a child process. */
export function stripGatewayCookie(header) {
  if (!header) return header;
  const kept = String(header).split(';').map((part) => part.trim()).filter((part) => part && !part.startsWith(`${COOKIE_NAME}=`));
  return kept.length ? kept.join('; ') : undefined;
}

export function serializeCookie(value, { maxAgeMs, secure }) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function serializeClearedCookie({ secure }) {
  return serializeCookie('', { maxAgeMs: 0, secure });
}
