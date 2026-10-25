import fs from 'node:fs';
import http from 'node:http';

import express from 'express';

import { createAdminRouter } from './admin/routes.mjs';
import { createRateLimiter } from './auth/rate-limit.mjs';
import { createAuthRouter } from './auth/routes.mjs';
import { loadOrCreateSecret } from './auth/cookie.mjs';
import { clientIp, currentAccount, requestProto } from './auth/session.mjs';
import { dataPaths, ensurePrivateDir, loadConfig, writePrivateFile } from './config.mjs';
import { createProcessManager } from './proc/manager.mjs';
import { acquireGatewayLock, cleanupOrphans } from './proc/run-files.mjs';
import { isBlocked, proxyHttp, wantsHtml } from './proxy/http.mjs';
import { checkMemberRequest, needsBody, readBody } from './proxy/member-policy.mjs';
import { proxyUpgrade, rejectUpgrade } from './proxy/upgrade.mjs';
import { createAccountStore, openDatabase } from './store/accounts.mjs';
import { createBackup, restoreBackup } from './store/backup.mjs';
import { LATEST_SCHEMA } from './store/migrations.mjs';

const log = (message) => console.log(`[gateway] ${new Date().toISOString()} ${message}`);

function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function statusPage(title, body, { refresh = false } = {}) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="1">' : ''}<title>${title}</title><link rel="stylesheet" href="/__gw/static/gw.css"></head><body><main class="card"><h1>${title}</h1>${body}</main></body></html>`;
}

/**
 * Opens gateway.db, backing up and migrating first when the schema or either
 * version changed (A-7). Child databases migrate themselves when the children
 * start, so every account is started once as a preflight; any failure restores
 * the backup (UPG-08).
 */
async function openStoreWithMigration(config, manager) {
  const paths = dataPaths(config);
  const meta = readMeta(paths.meta);
  const existing = fs.existsSync(paths.db);
  const changed = existing && (!meta || meta.schema !== LATEST_SCHEMA || meta.upstreamVersion !== config.upstreamVersion || meta.gatewayVersion !== config.gatewayVersion);

  let backupName = null;
  if (changed) {
    backupName = createBackup(config);
    log(`version or schema changed; backup ${backupName} created`);
  }

  let db = null;
  try {
    db = openDatabase(paths.db);
    const store = createAccountStore(db);
    if (changed) {
      for (const account of store.list()) {
        const full = store.getByUsername(account.username);
        log(`preflight: starting ${account.username}`);
        await manager.ensureRunning(full);
        if (full.role !== 'admin') await manager.stop(full.username);
      }
    }
    writePrivateFile(paths.meta, JSON.stringify({ schema: LATEST_SCHEMA, upstreamVersion: config.upstreamVersion, gatewayVersion: config.gatewayVersion }, null, 2));
    return { db, store };
  } catch (error) {
    await manager.stopAll();
    db?.close();
    if (backupName) {
      restoreBackup(config, backupName);
      log(`migration failed; data restored from backup ${backupName}`);
    }
    throw error;
  }
}

export async function startGateway(config = loadConfig()) {
  const paths = dataPaths(config);
  for (const dir of [config.dataRoot, paths.accounts, paths.run]) ensurePrivateDir(dir);

  const releaseLock = acquireGatewayLock(config);
  await cleanupOrphans(config, log);

  const manager = createProcessManager({ config, log });
  let opened;
  try {
    opened = await openStoreWithMigration(config, manager);
  } catch (error) {
    releaseLock();
    throw error;
  }
  const { db, store } = opened;
  const ctx = {
    config,
    store,
    manager,
    log,
    secret: loadOrCreateSecret(paths.secret),
    limiter: createRateLimiter({ maxFails: config.loginMaxFails, lockMs: config.loginLockMs }),
  };

  const app = express();
  app.disable('x-powered-by');
  app.use('/__gw/api', express.json({ limit: '64kb' }));
  app.use('/__gw', createAuthRouter(ctx));
  app.use('/__gw', createAdminRouter(ctx));
  app.use('/__gw', (req, res) => res.status(404).json({ error: 'not found' }));

  app.use(async (req, res) => {
    const account = currentAccount(req, ctx);
    if (!account) {
      if (wantsHtml(req)) {
        const target = store.hasAdmin() ? `/__gw/login?next=${encodeURIComponent(req.url)}` : '/__gw/setup';
        return res.redirect(302, target);
      }
      return res.status(401).json({ error: 'Not signed in', code: 'GATEWAY_AUTH_REQUIRED' });
    }
    if (isBlocked(req)) return res.status(403).json({ error: 'Handled by the gateway' });

    // Plan B: members may not change configuration shared by all accounts.
    let body = null;
    if (account.role === 'member') {
      if (needsBody(req)) {
        try {
          body = await readBody(req);
        } catch (error) {
          return res.status(error.status ?? 400).json({ error: error.message });
        }
      }
      const denied = checkMemberRequest(req, body);
      if (denied) {
        log(`${account.username}: blocked ${req.method} ${req.url}`);
        return res.status(denied.status).json(denied.body);
      }
    }

    manager.touch(account.username);
    const state = manager.status(account.username).state;
    if (state !== 'running' && wantsHtml(req)) {
      manager.ensureRunning(account).catch(() => {});
      res.setHeader('Cache-Control', 'no-store');
      if (manager.status(account.username).state === 'failed') {
        const reason = manager.status(account.username).error ?? '';
        return res.status(503).type('html').send(statusPage('启动失败', `<p>账号 ${account.username} 的服务连续启动失败。</p><p class="muted">${reason.replace(/</g, '&lt;')}</p><p>日志：<code>${paths.accountLog(account.username)}</code></p><p><a href="/__gw/logout">退出并重新登录</a>后会再次尝试。</p>`));
      }
      return res.status(503).type('html').send(statusPage('正在启动…', `<p>正在为 ${account.username} 启动服务，页面会自动刷新。</p>`, { refresh: true }));
    }

    let slot;
    try {
      slot = await manager.ensureRunning(account);
    } catch (error) {
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ error: `Service unavailable: ${error.message}` });
    }
    proxyHttp(req, res, {
      port: slot.port,
      clientIp: clientIp(req, config),
      proto: requestProto(req, config),
      body,
      getBootstrap: async () => ({ account: account.username, role: account.role, token: await manager.getToken(account) }),
      onError: (error) => {
        log(`${account.username}: proxy error ${req.method} ${req.url}: ${error.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Bad gateway' });
        else res.destroy();
      },
    });
  });

  app.use((error, req, res, next) => {
    log(`error ${req.method} ${req.url}: ${error.stack ?? error.message}`);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'Internal error' });
  });

  const server = http.createServer(app);
  // Long-lived SSE streams and agent runs must not be cut off.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;

  const upgradedSockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const account = currentAccount(req, ctx);
    if (!account) return rejectUpgrade(socket, 401, 'Unauthorized');
    manager.ensureRunning(account).then((slot) => {
      if (socket.destroyed) return;
      proxyUpgrade(req, socket, head, {
        port: slot.port,
        clientIp: clientIp(req, config),
        proto: requestProto(req, config),
        onOpen: () => manager.wsOpened(account.username),
        onClose: () => manager.wsClosed(account.username),
      });
    }).catch(() => rejectUpgrade(socket, 503, 'Service Unavailable'));
  });

  // The admin child is resident (PROC-00).
  for (const account of store.list().filter((entry) => entry.role === 'admin')) {
    manager.ensureRunning(store.getByUsername(account.username)).catch((error) => log(`admin start failed: ${error.message}`));
  }

  const idleTimer = setInterval(() => {
    manager.reapIdle().catch((error) => log(`idle check failed: ${error.message}`));
  }, config.idleCheckMs);
  idleTimer.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  log(`listening on http://${config.host}:${server.address().port} (data ${config.dataRoot})`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1' && !config.trustProxy) {
    log('WARNING: listening on a non-loopback address without HTTPS; put the gateway behind an HTTPS reverse proxy or an SSH tunnel');
  }

  let closing = null;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        clearInterval(idleTimer);
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        for (const socket of upgradedSockets) socket.destroy();
        await closed;
        await manager.stopAll();
        db.close();
        releaseLock();
        log('stopped');
      })();
    }
    return closing;
  };

  return { server, close, ctx, port: server.address().port };
}
