import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import WebSocket from 'ws';

import { APP_ROOT } from '../config.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const encodeDir = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 200, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${message}`);
}

/**
 * A throwaway world for the checks (UPG-09): data root, child HOME with fake
 * Claude transcripts, and workspaces. Lives under the repo (not /tmp, which
 * upstream forbids as a workspace) and is deleted afterwards.
 */
export function createFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(APP_ROOT, 'gateway', '.check-run-')));
  const fixture = {
    root,
    dataRoot: path.join(root, 'data'),
    home: path.join(root, 'home'),
    w: path.join(root, 'w'),
    sessions: {},
  };
  fixture.projA = path.join(fixture.w, 'projA');
  fixture.projB = path.join(fixture.w, 'projB');
  fixture.projAtmp = path.join(fixture.w, 'projA-tmp');
  fs.mkdirSync(path.join(fixture.home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(fixture.w, { recursive: true });
  // A real home has a git identity; the fake one needs it for commits.
  fs.writeFileSync(path.join(fixture.home, '.gitconfig'), '[user]\n\tname = check\n\temail = check@example.invalid\n[init]\n\tdefaultBranch = main\n');
  return fixture;
}

/** Writes a minimal Claude transcript whose cwd is `cwd`. */
export function writeTranscript(fixture, cwd, sessionId, word) {
  const dir = path.join(fixture.home, '.claude', 'projects', encodeDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const now = new Date().toISOString();
  const lines = [
    { type: 'user', sessionId, cwd, uuid: `${sessionId}-1`, timestamp: now, message: { role: 'user', content: `hello ${word}` } },
    { type: 'assistant', sessionId, cwd, uuid: `${sessionId}-2`, timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: `reply ${word}` }] } },
  ];
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

/** Runs `node gateway/bin.mjs start` as a separate process. */
export class GatewayProcess {
  constructor(fixture, { childMode, env = {} } = {}) {
    this.fixture = fixture;
    this.childMode = childMode;
    this.extraEnv = env;
    this.output = '';
  }

  async start(env = {}) {
    this.port = await freePort();
    this.env = {
      ...process.env,
      CLOUDCLI_MULTI_HOME: this.fixture.dataRoot,
      CLOUDCLI_MULTI_PORT: String(this.port),
      CLOUDCLI_MULTI_HOST: '127.0.0.1',
      CLOUDCLI_MULTI_WORKSPACES: this.fixture.w,
      CLOUDCLI_MULTI_CHILD_HOME: this.fixture.home,
      CLOUDCLI_MULTI_CHILD_MODE: this.childMode,
      CLOUDCLI_MULTI_LOGIN_LOCK_SECONDS: '2',
      CLOUDCLI_MULTI_TRUST_PROXY: 'true',
      ...this.extraEnv,
      ...env,
    };
    // Never let the checks reach a real Claude account (and spend its quota).
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) delete this.env[name];
    // The fixture lives inside this repository; keep git from walking up into it.
    this.env.GIT_CEILING_DIRECTORIES = this.fixture.root;
    this.output = '';
    this.proc = spawn(process.execPath, [path.join(APP_ROOT, 'gateway', 'bin.mjs'), 'start'], { cwd: APP_ROOT, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => { this.output += chunk; });
    this.proc.stderr.on('data', (chunk) => { this.output += chunk; });
    this.exited = new Promise((resolve) => this.proc.once('exit', (code) => resolve(code)));
    await waitFor(() => this.output.includes('listening on') || this.proc.exitCode !== null, { timeoutMs: 120_000, message: 'gateway to listen' });
    if (this.proc.exitCode !== null) throw new Error(`gateway exited: ${this.output}`);
    this.base = `http://127.0.0.1:${this.port}`;
    return this;
  }

  /** Starts and expects the process to fail; returns its exit code. */
  async startExpectingFailure(env = {}) {
    this.port = await freePort();
    const proc = spawn(process.execPath, [path.join(APP_ROOT, 'gateway', 'bin.mjs'), 'start'], {
      cwd: APP_ROOT,
      env: { ...this.env, CLOUDCLI_MULTI_PORT: String(this.port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout.on('data', (chunk) => { output += chunk; });
    proc.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => proc.once('exit', resolve));
    return { code, output };
  }

  async stop(signal = 'SIGTERM') {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill(signal);
    await this.exited;
  }
}

/** A browser-ish client: keeps the gateway cookie, does not follow redirects. */
export class Client {
  constructor(gateway, { ip } = {}) {
    this.gateway = gateway;
    this.cookie = null;
    this.ip = ip ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  }

  async request(method, url, { json, headers = {}, raw = false } = {}) {
    const finalHeaders = { ...headers };
    if (this.cookie) finalHeaders.cookie = this.cookie;
    // The checks run the gateway with TRUST_PROXY so each client can look like its own IP.
    if (this.ip) finalHeaders['x-forwarded-for'] = this.ip;
    if (json !== undefined) finalHeaders['content-type'] = 'application/json';
    const response = await fetch(this.gateway.base + url, { method, headers: finalHeaders, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual' });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const value = setCookie.split(';')[0];
      this.cookie = value.endsWith('=') ? null : value;
      this.lastSetCookie = setCookie;
    }
    if (raw) return response;
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, headers: response.headers, text, body };
  }

  get(url, options) { return this.request('GET', url, options); }
  post(url, json, options) { return this.request('POST', url, { ...options, json }); }
  del(url, options) { return this.request('DELETE', url, options); }

  async login(username, password) {
    return this.post('/__gw/api/login', { username, password });
  }

  /** Loads the app page until the child is up; returns the injected bootstrap. */
  async openApp() {
    const page = await waitFor(async () => {
      const response = await this.get('/', { headers: { accept: 'text/html' } });
      return response.status === 200 ? response : null;
    }, { timeoutMs: 60_000, message: 'app page' });
    const match = /window\.__GW__=(\{.*?\})<\/script>/.exec(page.text);
    this.bootstrap = match ? JSON.parse(match[1]) : null;
    return { page, bootstrap: this.bootstrap };
  }

  /** Calls the upstream API through the gateway the way the frontend does. */
  api(method, url, json) {
    return this.request(method, url, { json, headers: { authorization: `Bearer ${this.bootstrap?.token}` } });
  }

  websocket(pathname) {
    return new Promise((resolve) => {
      const url = `${this.gateway.base.replace('http', 'ws')}${pathname}`;
      const socket = new WebSocket(url, { headers: this.cookie ? { cookie: this.cookie } : {} });
      socket.once('open', () => resolve({ ok: true, socket }));
      socket.once('unexpected-response', (req, res) => resolve({ ok: false, status: res.statusCode }));
      socket.once('error', (error) => resolve({ ok: false, error }));
    });
  }
}

/** Reads the search SSE stream until it finishes. */
export async function searchSessions(client, query) {
  const response = await fetch(`${client.gateway.base}/api/providers/search/sessions?q=${encodeURIComponent(query)}&token=${client.bootstrap.token}`, {
    headers: { cookie: client.cookie },
    signal: AbortSignal.timeout(15_000),
  });
  let text = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } catch {
    // Timed out; use what arrived.
  }
  return text;
}

export function readRunFile(fixture, username) {
  try {
    return JSON.parse(fs.readFileSync(path.join(fixture.dataRoot, 'run', `${username}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function processEnv(pid) {
  try {
    return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((entry) => {
      const index = entry.indexOf('=');
      return [entry.slice(0, index), entry.slice(index + 1)];
    }));
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
