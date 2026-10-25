import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { INTERNAL_USERNAME, dataPaths, ensurePrivateDir } from '../config.mjs';
import { removeRunFile, writeRunFile } from './run-files.mjs';
import { tokenExpiresAt, upstreamClient } from './upstream-client.mjs';

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 300;
const STOP_GRACE_MS = 10_000;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const PORT_ATTEMPTS = 3;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

// Variables the gateway sets itself or that would break a child (mydocs/03 6.2).
const STRIPPED_ENV = ['JWT_SECRET', 'API_KEY', 'VITE_IS_PLATFORM', 'PORT', 'SERVER_PORT', 'HOST', 'DATABASE_PATH', 'WORKSPACES_ROOT', 'CLOUDCLI_ISOLATION_ROOT'];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rotateLog(file) {
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
}

/**
 * One CloudCLI child process per account (mydocs/03 section 6).
 *
 * States: stopped → starting → running → stopping → stopped; `failed` after
 * CRASH_LIMIT failed starts within CRASH_WINDOW_MS (reset on the next login).
 */
export function createProcessManager({ config, log }) {
  const paths = dataPaths(config);
  /** @type {Map<string, any>} */
  const slots = new Map();

  const slotFor = (account) => {
    let slot = slots.get(account.username);
    if (!slot) {
      slot = { state: 'stopped', child: null, port: null, token: null, starting: null, wsCount: 0, lastActivityAt: Date.now(), failures: [], error: null };
      slots.set(account.username, slot);
    }
    slot.account = account;
    return slot;
  };

  function childCommand() {
    if (config.childMode === 'dev') {
      return [path.join(config.appRoot, 'node_modules', '.bin', 'tsx'), ['--tsconfig', 'server/tsconfig.json', 'server/index.ts']];
    }
    return [process.execPath, [path.join(config.appRoot, 'dist-server', 'server', 'index.js')]];
  }

  function childEnv(account, port) {
    const env = { ...process.env };
    for (const name of STRIPPED_ENV) delete env[name];
    Object.assign(env, {
      NODE_ENV: 'production',
      HOME: config.childHome,
      HOST: '127.0.0.1',
      SERVER_PORT: String(port),
      DATABASE_PATH: paths.accountDb(account.username),
      WORKSPACES_ROOT: account.workspace_root,
    });
    if (account.role === 'member') {
      env.CLOUDCLI_ISOLATION_ROOT = account.workspace_root;
      // Environment git config outranks .git/config: a repository cannot name its
      // own fsmonitor command (it would run as the shared system user).
      const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
      env.GIT_CONFIG_COUNT = String(count + 1);
      env[`GIT_CONFIG_KEY_${count}`] = 'core.fsmonitor';
      env[`GIT_CONFIG_VALUE_${count}`] = 'false';
    }
    return env;
  }

  async function launch(slot) {
    const { account } = slot;
    ensurePrivateDir(paths.accountDir(account.username));
    const logFile = paths.accountLog(account.username);
    rotateLog(logFile);

    let lastError = null;
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
      const port = await freePort();
      const logFd = fs.openSync(logFile, 'a', 0o600);
      const [command, args] = childCommand();
      const child = spawn(command, args, { cwd: config.appRoot, env: childEnv(account, port), stdio: ['ignore', logFd, logFd] });
      fs.closeSync(logFd);

      let exited = false;
      child.once('exit', () => { exited = true; });
      child.once('error', (error) => {
        exited = true;
        log(`${account.username}: cannot spawn child: ${error.message}`);
      });
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      let healthy = false;
      while (!exited && Date.now() < deadline) {
        try {
          if ((await upstreamClient.status(port)).status === 200) {
            healthy = true;
            break;
          }
        } catch {
          // Not listening yet.
        }
        await sleep(HEALTH_INTERVAL_MS);
      }

      if (healthy) {
        slot.child = child;
        slot.port = port;
        writeRunFile(config, account.username, { pid: child.pid, port, startedAt: new Date().toISOString() });
        child.once('exit', (code, signal) => onExit(slot, child, code, signal));
        return;
      }
      lastError = exited ? new Error(`child exited during start (see ${logFile})`) : new Error(`health check timed out after ${HEALTH_TIMEOUT_MS / 1000}s`);
      if (!exited) await killChild(child);
    }
    throw lastError;
  }

  function onExit(slot, child, code, signal) {
    if (slot.child !== child) return;
    removeRunFile(config, slot.account.username);
    const expected = slot.state === 'stopping';
    slot.child = null;
    slot.port = null;
    slot.token = null;
    slot.wsCount = 0;
    if (!expected) {
      log(`${slot.account.username}: child exited unexpectedly (code ${code}, signal ${signal}); it restarts on the next request`);
      slot.state = 'stopped';
    }
  }

  async function killChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  async function refreshToken(slot) {
    slot.token = await upstreamClient.obtainToken(slot.port, INTERNAL_USERNAME, slot.account.internal_password);
    return slot.token;
  }

  async function start(slot) {
    const now = Date.now();
    slot.failures = slot.failures.filter((at) => now - at < CRASH_WINDOW_MS);
    if (slot.failures.length >= CRASH_LIMIT) {
      slot.state = 'failed';
      throw slot.error ?? new Error('start failed repeatedly');
    }
    slot.state = 'starting';
    slot.error = null;
    try {
      await launch(slot);
      await refreshToken(slot);
      if (slot.account.role === 'member') await upstreamClient.completeOnboarding(slot.port, slot.token);
      slot.state = 'running';
      slot.lastActivityAt = Date.now();
      log(`${slot.account.username}: running on 127.0.0.1:${slot.port}`);
    } catch (error) {
      slot.failures.push(Date.now());
      slot.error = error;
      slot.state = slot.failures.length >= CRASH_LIMIT ? 'failed' : 'stopped';
      if (slot.child) await stopSlot(slot);
      log(`${slot.account.username}: start failed: ${error.message}`);
      throw error;
    }
  }

  async function stopSlot(slot) {
    const child = slot.child;
    if (!child) {
      if (slot.state !== 'failed') slot.state = 'stopped';
      return;
    }
    slot.state = 'stopping';
    await killChild(child);
    removeRunFile(config, slot.account.username);
    slot.child = null;
    slot.port = null;
    slot.token = null;
    slot.wsCount = 0;
    slot.state = 'stopped';
  }

  return {
    /** Starts the account's child if needed; concurrent callers share one start (PROC-03). */
    ensureRunning(account) {
      const slot = slotFor(account);
      if (slot.state === 'running' && slot.child) return Promise.resolve(slot);
      if (!slot.starting) {
        slot.starting = start(slot).then(() => slot).finally(() => { slot.starting = null; });
      }
      return slot.starting;
    },

    /** Clears the failure history so a fresh login can try again. */
    resetFailures(account) {
      const slot = slotFor(account);
      slot.failures = [];
      if (slot.state === 'failed') slot.state = 'stopped';
    },

    status(username) {
      const slot = slots.get(username);
      return slot ? { state: slot.state, port: slot.port, wsCount: slot.wsCount, error: slot.error?.message ?? null, pid: slot.child?.pid ?? null } : { state: 'stopped', port: null, wsCount: 0, error: null, pid: null };
    },

    /** A token for the child's internal user, refreshed when it is close to expiry. */
    async getToken(account) {
      const slot = await this.ensureRunning(account);
      if (!slot.token || tokenExpiresAt(slot.token) - Date.now() < TOKEN_REFRESH_MARGIN_MS) await refreshToken(slot);
      return slot.token;
    },

    touch(username) {
      const slot = slots.get(username);
      if (slot) slot.lastActivityAt = Date.now();
    },

    wsOpened(username) {
      const slot = slots.get(username);
      if (slot) {
        slot.wsCount += 1;
        slot.lastActivityAt = Date.now();
      }
    },

    wsClosed(username) {
      const slot = slots.get(username);
      if (slot) {
        slot.wsCount = Math.max(0, slot.wsCount - 1);
        slot.lastActivityAt = Date.now();
      }
    },

    async stop(username) {
      const slot = slots.get(username);
      if (!slot) return;
      if (slot.starting) await slot.starting.catch(() => {});
      await stopSlot(slot);
    },

    forget(username) {
      slots.delete(username);
    },

    async stopAll() {
      await Promise.all([...slots.keys()].map((username) => this.stop(username)));
    },

    /**
     * Stops idle member children (mydocs/03 6.3). Admin stays resident. A child
     * is idle only with no WebSocket, no recent request, no running session and
     * no pending scheduled message; if either API call fails it is kept.
     */
    async reapIdle(now = Date.now()) {
      const stopped = [];
      for (const slot of slots.values()) {
        if (slot.account.role === 'admin' || slot.state !== 'running' || !slot.child) continue;
        if (slot.wsCount > 0 || now - slot.lastActivityAt < config.idleMs) continue;
        try {
          const token = slot.token ?? (await refreshToken(slot));
          const running = await upstreamClient.runningSessionCount(slot.port, token);
          const scheduled = await upstreamClient.pendingScheduledCount(slot.port, token);
          if (running !== 0 || scheduled !== 0) continue;
        } catch {
          continue;
        }
        log(`${slot.account.username}: idle, stopping`);
        await stopSlot(slot);
        stopped.push(slot.account.username);
      }
      return stopped;
    },
  };
}
