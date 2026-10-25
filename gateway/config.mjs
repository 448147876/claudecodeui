import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATEWAY_VERSION = '0.1.0';
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INTERNAL_USERNAME = 'cloudcli-internal';

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the gateway configuration from environment variables (see mydocs/03 section 9). */
export function loadConfig(env = process.env) {
  const upstreamVersion = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
  return {
    appRoot: APP_ROOT,
    upstreamVersion,
    gatewayVersion: GATEWAY_VERSION,
    dataRoot: path.resolve(expandHome(env.CLOUDCLI_MULTI_HOME || '~/.cloudcli-multi')),
    host: env.CLOUDCLI_MULTI_HOST || '127.0.0.1',
    port: readInt(env.CLOUDCLI_MULTI_PORT, 3001),
    workspacesRoot: path.resolve(expandHome(env.CLOUDCLI_MULTI_WORKSPACES || '~/workspaces')),
    // IDLE_SECONDS is a test hook that overrides IDLE_MINUTES.
    idleMs: env.CLOUDCLI_MULTI_IDLE_SECONDS ? readInt(env.CLOUDCLI_MULTI_IDLE_SECONDS, 1800) * 1000 : readInt(env.CLOUDCLI_MULTI_IDLE_MINUTES, 30) * 60_000,
    idleCheckMs: readInt(env.CLOUDCLI_MULTI_IDLE_CHECK_SECONDS, 60) * 1000,
    loginMaxFails: readInt(env.CLOUDCLI_MULTI_LOGIN_MAX_FAILS, 5),
    loginLockMs: readInt(env.CLOUDCLI_MULTI_LOGIN_LOCK_SECONDS, 60) * 1000,
    trustProxy: env.CLOUDCLI_MULTI_TRUST_PROXY === 'true',
    // Child processes run the built server; `dev` runs server/index.ts through tsx instead.
    childMode: env.CLOUDCLI_MULTI_CHILD_MODE === 'dev' ? 'dev' : 'dist',
    // Test hook: HOME for child processes (the check script points it at a fixture).
    childHome: env.CLOUDCLI_MULTI_CHILD_HOME ? path.resolve(env.CLOUDCLI_MULTI_CHILD_HOME) : os.homedir(),
    backupsToKeep: 5,
    cookieMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  };
}

export const dataPaths = (config) => ({
  meta: path.join(config.dataRoot, 'meta.json'),
  db: path.join(config.dataRoot, 'gateway.db'),
  secret: path.join(config.dataRoot, 'secret.key'),
  accounts: path.join(config.dataRoot, 'accounts'),
  run: path.join(config.dataRoot, 'run'),
  backup: path.join(config.dataRoot, 'backup'),
  lock: path.join(config.dataRoot, 'run', 'gateway.lock'),
  accountDir: (username) => path.join(config.dataRoot, 'accounts', username),
  accountDb: (username) => path.join(config.dataRoot, 'accounts', username, 'auth.db'),
  accountLog: (username) => path.join(config.dataRoot, 'accounts', username, 'server.log'),
  runFile: (username) => path.join(config.dataRoot, 'run', `${username}.json`),
});

/** Creates a directory (and parents) with owner-only permissions. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Writes a file with owner-only permissions. */
export function writePrivateFile(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
