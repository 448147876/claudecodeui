import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Client, isAlive, processEnv, readRunFile, sleep, waitFor } from '../harness.mjs';

const accountState = async (ctx, username) => (await ctx.admin.get('/__gw/api/accounts')).body.accounts.find((account) => account.username === username)?.process.state;

function requireProcfs(ctx) {
  if (!fs.existsSync('/proc/self/environ')) ctx.skip('需要 Linux /proc');
}

export const processScenarios = [
  ['PROC-00', 'admin 进程随网关常驻', async (ctx) => {
    await waitFor(async () => (await accountState(ctx, 'admin')) === 'running', { message: 'admin running' });
  }],

  ['PROC-01', '登录时按需启动，环境变量正确', async (ctx) => {
    requireProcfs(ctx);
    const run = readRunFile(ctx.fixture, 'projA');
    const env = processEnv(run.pid);
    assert.ok(env, 'environ readable');
    assert.equal(env.WORKSPACES_ROOT, ctx.fixture.projA);
    assert.equal(env.CLOUDCLI_ISOLATION_ROOT, ctx.fixture.projA);
    assert.equal(env.DATABASE_PATH, path.join(ctx.fixture.dataRoot, 'accounts', 'projA', 'auth.db'));
    assert.equal(env.HOST, '127.0.0.1');
    for (const name of ['JWT_SECRET', 'API_KEY', 'VITE_IS_PLATFORM', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(env[name], undefined, name);
  }],

  ['PROC-02', '管理员进程没有隔离开关', async (ctx) => {
    requireProcfs(ctx);
    const env = processEnv(readRunFile(ctx.fixture, 'admin').pid);
    assert.equal(env.WORKSPACES_ROOT, ctx.fixture.home);
    assert.equal(env.CLOUDCLI_ISOLATION_ROOT, undefined);
  }],

  ['PROC-03', '多个浏览器共用同一进程', async (ctx) => {
    const before = readRunFile(ctx.fixture, 'projA').pid;
    const other = new Client(ctx.gw);
    await other.login('projA', 'passA1');
    await other.openApp();
    assert.equal(readRunFile(ctx.fixture, 'projA').pid, before);
  }],

  ['PROC-11', 'run 文件记录端口和 PID，权限 600', async (ctx) => {
    const file = path.join(ctx.fixture.dataRoot, 'run', 'projA.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const run = readRunFile(ctx.fixture, 'projA');
    assert.ok(run.port > 0 && run.port !== ctx.gw.port);
    assert.ok(isAlive(run.pid));
  }],

  ['PROC-07', '子进程崩溃后自动恢复', async (ctx) => {
    const { pid } = readRunFile(ctx.fixture, 'projB');
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !isAlive(pid), { message: 'child killed' });
    await waitFor(() => readRunFile(ctx.fixture, 'projB') === null, { message: 'run file removed' });
    const response = await ctx.b.api('GET', '/api/projects');
    assert.equal(response.status, 200, 'next request restarts the child');
    const run = readRunFile(ctx.fixture, 'projB');
    assert.notEqual(run.pid, pid);
    await ctx.b.openApp();
  }],
];

export const idleScenarios = [
  ['PROC-05', '有待执行的定时消息时不回收', async (ctx) => {
    const scheduled = await ctx.a.api('POST', '/api/scheduled-messages', { sessionId: ctx.state.appSessionA, content: 'later', scheduledFor: new Date(Date.now() + 2 * 3600 * 1000).toISOString() });
    assert.equal(scheduled.status, 201, scheduled.text);
    ctx.state.scheduledPid = readRunFile(ctx.fixture, 'projA').pid;
  }],

  ['PROC-04', '空闲回收与重新启动', async (ctx) => {
    // projB: no WebSocket, no running session, nothing scheduled.
    await waitFor(() => readRunFile(ctx.fixture, 'projB') === null, { timeoutMs: 30_000, message: 'projB reaped' });
    assert.equal(await accountState(ctx, 'projB'), 'stopped');
    const before = (await ctx.b.api('GET', '/api/projects')).body.map((project) => project.fullPath).sort();
    assert.ok(readRunFile(ctx.fixture, 'projB'), 'restarted on demand');
    await ctx.b.openApp();
    const after = (await ctx.b.api('GET', '/api/projects')).body.map((project) => project.fullPath).sort();
    assert.deepEqual(after, before);
  }],

  ['PROC-05b', '定时消息让 projA 保持运行', async (ctx) => {
    const run = readRunFile(ctx.fixture, 'projA');
    assert.ok(run, 'projA still running');
    assert.equal(run.pid, ctx.state.scheduledPid);
  }],

  ['PROC-00b', 'admin 超过空闲阈值后仍在运行', async (ctx) => {
    assert.equal(await accountState(ctx, 'admin'), 'running');
  }],
];

export const claudeScenarios = [
  ['CL-02', '只有一份 Claude 配置', async (ctx) => {
    requireProcfs(ctx);
    const homes = ['admin', 'projA', 'projB'].map((username) => processEnv(readRunFile(ctx.fixture, username).pid)?.HOME);
    assert.deepEqual(homes, [ctx.fixture.home, ctx.fixture.home, ctx.fixture.home]);
    for (const username of ['admin', 'projA', 'projB']) {
      const env = processEnv(readRunFile(ctx.fixture, username).pid);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      if (!process.env.CLAUDE_CONFIG_DIR) assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    }
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [entry.name]));
    assert.ok(!walk(ctx.fixture.dataRoot).some((name) => /credential/i.test(name)));
  }],
];

export const lifecycleScenarios = [
  ['PROC-08', '网关退出时清理子进程', async (ctx) => {
    const pids = ['admin', 'projA', 'projB'].map((username) => readRunFile(ctx.fixture, username)?.pid).filter(Boolean);
    await ctx.gw.stop('SIGTERM');
    for (const pid of pids) await waitFor(() => !isAlive(pid), { message: `pid ${pid} stopped` });
    const left = fs.readdirSync(path.join(ctx.fixture.dataRoot, 'run'));
    assert.deepEqual(left, []);
  }],

  ['UPG-01', '重启后数据不丢', async (ctx) => {
    await ctx.gw.start();
    const client = new Client(ctx.gw);
    assert.equal((await client.login('projA', 'passA1')).status, 200);
    await client.openApp();
    const paths = (await client.api('GET', '/api/projects')).body.map((project) => project.fullPath);
    assert.ok(paths.includes(path.join(ctx.fixture.projA, 'app1')));
    ctx.a = client;
    ctx.admin = new Client(ctx.gw);
    await ctx.admin.login('admin', '123456');
    await ctx.admin.openApp();
  }],

  ['PROC-10', '网关异常退出后清理遗留进程', async (ctx) => {
    const admin = await waitFor(() => readRunFile(ctx.fixture, 'admin'), { message: 'admin run file' });
    const projA = readRunFile(ctx.fixture, 'projA');
    await ctx.gw.stop('SIGKILL');
    assert.ok(isAlive(admin.pid) && isAlive(projA.pid), 'children outlive a killed gateway');
    await ctx.gw.start();
    await waitFor(() => !isAlive(admin.pid) && !isAlive(projA.pid), { message: 'leftovers stopped' });
    const fresh = await waitFor(() => readRunFile(ctx.fixture, 'admin'), { message: 'new admin' });
    assert.notEqual(fresh.pid, admin.pid);
    ctx.admin = new Client(ctx.gw);
    await ctx.admin.login('admin', '123456');
  }],

  ['UPG-07', '迁移前备份并只保留 5 份', async (ctx) => {
    const backupDir = path.join(ctx.fixture.dataRoot, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 1; i <= 5; i += 1) fs.mkdirSync(path.join(backupDir, `2000010${i}-000000`), { recursive: true });
    await ctx.gw.stop();
    const metaFile = path.join(ctx.fixture.dataRoot, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, upstreamVersion: '0.0.0' }));
    await ctx.gw.start();
    const backups = fs.readdirSync(backupDir).sort();
    assert.equal(backups.length, 5, backups.join(','));
    assert.ok(!backups.includes('20000101-000000'), 'oldest removed');
    const newest = path.join(backupDir, backups.at(-1));
    assert.ok(fs.existsSync(path.join(newest, 'gateway.db')));
    assert.ok(!fs.existsSync(path.join(newest, 'run')) && !fs.existsSync(path.join(newest, 'backup')));
    assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).upstreamVersion, meta.upstreamVersion, 'meta updated after success');
    assert.match(ctx.gw.output, /preflight: starting projB/);
    ctx.admin = new Client(ctx.gw);
    await ctx.admin.login('admin', '123456');
  }],

  ['UPG-08', '迁移失败自动恢复', async (ctx) => {
    await ctx.gw.stop();
    const metaFile = path.join(ctx.fixture.dataRoot, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, upstreamVersion: '0.0.1' }));
    const dbB = path.join(ctx.fixture.dataRoot, 'accounts', 'projB', 'auth.db');
    const original = fs.readFileSync(dbB);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbB}${suffix}`, { force: true });
    fs.writeFileSync(dbB, 'this is not a sqlite database');
    const { code, output } = await ctx.gw.startExpectingFailure();
    assert.notEqual(code, 0);
    assert.match(output, /restored from backup/);
    assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).upstreamVersion, '0.0.1', 'meta not advanced');
    // Repair for the remaining scenarios.
    fs.writeFileSync(dbB, original);
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    await ctx.gw.start();
    ctx.admin = new Client(ctx.gw);
    await ctx.admin.login('admin', '123456');
  }],

  ['ACC-08', '删除账号时保留工作目录和对话记录', async (ctx) => {
    const client = new Client(ctx.gw);
    await client.login('projB', 'passB1');
    await client.openApp();
    const { pid } = readRunFile(ctx.fixture, 'projB');
    assert.equal((await ctx.admin.del('/__gw/api/accounts/projB')).status, 200);
    await waitFor(() => !isAlive(pid), { message: 'projB stopped' });
    assert.ok(!fs.existsSync(path.join(ctx.fixture.dataRoot, 'accounts', 'projB')));
    assert.ok(fs.existsSync(path.join(ctx.fixture.projB, 'app2', 'CLAUDE.md')));
    assert.ok(fs.existsSync(ctx.transcripts.sB));
    assert.equal((await new Client(ctx.gw).login('projB', 'passB1')).status, 401);
    assert.equal((await client.get('/api/projects')).status, 401);
  }],

  ['ACC-09', '同名重建后恢复会话', async (ctx) => {
    assert.equal((await ctx.admin.post('/__gw/api/accounts', { username: 'projB', password: 'passB1', workspaceRoot: ctx.fixture.projB })).status, 201);
    const client = new Client(ctx.gw);
    await client.login('projB', 'passB1');
    await client.openApp();
    await waitFor(async () => {
      const list = (await client.api('GET', '/api/projects')).body ?? [];
      return list.some((project) => (project.sessions ?? []).some((session) => session.id === ctx.ids.sB));
    }, { message: 'sB reindexed' });
    await sleep(0);
  }],
];
