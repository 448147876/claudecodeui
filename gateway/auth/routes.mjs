import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { wrap } from '../http-utils.mjs';
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN, burnPasswordCheck } from '../store/accounts.mjs';
import { clearSessionCookie, clientIp, currentAccount, safeNext, setSessionCookie } from './session.mjs';

const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');

function sendPage(res, name) {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'));
}

/** Starts the child in the background so the first page load is quicker. */
function warmUp(ctx, account) {
  ctx.manager.resetFailures(account);
  ctx.manager.ensureRunning(account).catch(() => {});
}

export function createAuthRouter(ctx) {
  const router = express.Router();

  router.get('/setup', (req, res) => {
    if (ctx.store.hasAdmin()) return res.redirect(302, '/__gw/login');
    sendPage(res, 'setup.html');
  });

  router.post('/api/setup', wrap(async (req, res) => {
    if (ctx.store.hasAdmin()) return res.status(409).json({ error: '管理员已存在' });
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      return res.status(400).json({ error: '用户名需为 3–32 位字母、数字、- 或 _' });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` });
    }
    const workspaceRoot = fs.realpathSync(ctx.config.childHome);
    const admin = await ctx.store.create({ username, password, role: 'admin', workspaceRoot });
    setSessionCookie(req, res, ctx, admin);
    warmUp(ctx, admin);
    ctx.log(`admin ${username} created`);
    res.json({ ok: true, next: '/' });
  }));

  router.get('/login', (req, res) => {
    if (!ctx.store.hasAdmin()) return res.redirect(302, '/__gw/setup');
    sendPage(res, 'login.html');
  });

  router.post('/api/login', wrap(async (req, res) => {
    const { username, password, next } = req.body ?? {};
    const keys = [`user:${String(username ?? '').toLowerCase()}`, `ip:${clientIp(req, ctx.config)}`];
    const lockedMs = ctx.limiter.lockedFor(keys);
    if (lockedMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(lockedMs / 1000)));
      return res.status(429).json({ error: `尝试次数过多，请 ${Math.ceil(lockedMs / 1000)} 秒后再试` });
    }
    const account = typeof username === 'string' ? ctx.store.getByUsername(username) : null;
    const ok = account ? await ctx.store.verifyPassword(account, String(password ?? '')) : await burnPasswordCheck(password);
    if (!ok) {
      ctx.limiter.recordFailure(keys);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    ctx.limiter.recordSuccess(keys);
    setSessionCookie(req, res, ctx, account);
    warmUp(ctx, account);
    res.json({ ok: true, next: safeNext(next) });
  }));

  router.get('/logout', (req, res) => {
    clearSessionCookie(req, res, ctx);
    sendPage(res, 'logout.html');
  });

  router.get('/api/me', (req, res) => {
    const account = currentAccount(req, ctx);
    if (!account) return res.status(401).json({ error: '未登录' });
    res.json({ username: account.username, role: account.role });
  });

  router.use('/static', express.static(path.join(PUBLIC_DIR, 'static'), { maxAge: 0, etag: true }));

  return router;
}
