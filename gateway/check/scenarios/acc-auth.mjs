import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { Client, GatewayProcess, readRunFile, waitFor } from '../harness.mjs';

const html = { headers: { accept: 'text/html' } };

export const setupScenarios = [
  ['ACC-01', '首次启动创建管理员', async (ctx) => {
    const anon = new Client(ctx.gw);
    const root = await anon.get('/', html);
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/__gw/setup');
    assert.equal((await anon.get('/__gw/login')).headers.get('location'), '/__gw/setup');
    assert.equal((await anon.get('/__gw/setup')).status, 200);
    const created = await ctx.admin.post('/__gw/api/setup', { username: 'admin', password: '123456' });
    assert.equal(created.status, 200, created.text);
    assert.ok(ctx.admin.cookie, 'setup sets the session cookie');
    const { bootstrap } = await ctx.admin.openApp();
    assert.equal(bootstrap.account, 'admin');
    assert.equal(bootstrap.role, 'admin');
    assert.ok(bootstrap.token);
  }],

  ['ACC-02', '管理员已存在时不能再创建', async (ctx) => {
    const anon = new Client(ctx.gw);
    const page = await anon.get('/__gw/setup');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/__gw/login');
    assert.equal((await anon.post('/__gw/api/setup', { username: 'other', password: '123456' })).status, 409);
  }],

  ['ACC-03', '新增账号时默认工作目录', async (ctx) => {
    const created = await ctx.admin.post('/__gw/api/accounts', { username: 'projA', password: 'passA1', note: 'A 项目' });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.workspaceRoot, ctx.fixture.projA);
    assert.ok(fs.statSync(ctx.fixture.projA).isDirectory());
    const list = await ctx.admin.get('/__gw/api/accounts');
    const projA = list.body.accounts.find((account) => account.username === 'projA');
    assert.equal(projA.process.state, 'stopped');
    assert.equal(projA.note, 'A 项目');
    const createdB = await ctx.admin.post('/__gw/api/accounts', { username: 'projB', password: 'passB1', workspaceRoot: ctx.fixture.projB });
    assert.equal(createdB.status, 201, createdB.text);
  }],

  ['ACC-04', '用户名和密码校验', async (ctx) => {
    const cases = [
      ['ab', '123456', 400],
      ['proj A', '123456', 400],
      ['projA', '123456', 409],
      ['projD', '12345', 400],
      ['proj_D-1', '123456', 201],
    ];
    for (const [username, password, status] of cases) {
      const response = await ctx.admin.post('/__gw/api/accounts', { username, password, workspaceRoot: path.join(ctx.fixture.w, `acc04-${username.replace(/\W/g, '')}`) });
      assert.equal(response.status, status, `${username}/${password}: ${response.text}`);
    }
    assert.equal((await ctx.admin.del('/__gw/api/accounts/proj_D-1')).status, 200);
  }],

  ['ACC-05', '工作目录校验', async (ctx) => {
    const { fixture } = ctx;
    const cases = [
      ['etc', 400, '绝对路径'],
      ['/etc/x', 400, '系统目录'],
      ['/tmp/x', 400, '系统目录'],
      [fixture.home, 400, 'home'],
      [path.join(fixture.home, '.claude', 'x'), 400, '数据目录'],
      [path.join(fixture.projA, 'sub'), 400, '相互包含'],
      [fixture.w, 400, '相互包含'],
      [`${fixture.projA}-2`, 400, '互为前缀'],
      [`${fixture.projA}_2`, 400, '互为前缀'],
    ];
    for (const [workspaceRoot, status, message] of cases) {
      const response = await ctx.admin.post('/__gw/api/accounts', { username: 'projX', password: '123456', workspaceRoot });
      assert.equal(response.status, status, `${workspaceRoot}: ${response.text}`);
      assert.match(response.body.error, new RegExp(message), workspaceRoot);
    }
    assert.ok(!fs.existsSync(path.join(fixture.projA, 'sub')), 'a rejected workspace is not created');
    const ok = await ctx.admin.post('/__gw/api/accounts', { username: 'projX', password: '123456', workspaceRoot: path.join(fixture.w, 'projX') });
    assert.equal(ok.status, 201, ok.text);
    assert.equal((await ctx.admin.del('/__gw/api/accounts/projX')).status, 200);
  }],

  ['ACC-06', '工作目录不可修改', async (ctx) => {
    assert.equal((await ctx.admin.request('PATCH', '/__gw/api/accounts/projA', { json: { workspaceRoot: '/x' } })).status, 405);
    assert.equal((await ctx.admin.request('PUT', '/__gw/api/accounts/projA/workspace', { json: { workspaceRoot: '/x' } })).status, 405);
  }],

  ['ACC-10', '普通账号不能管理账号', async (ctx) => {
    assert.equal((await ctx.a.login('projA', 'passA1')).status, 200);
    const { bootstrap } = await ctx.a.openApp();
    assert.equal(bootstrap.role, 'member');
    for (const [method, url] of [['GET', '/__gw/api/accounts'], ['POST', '/__gw/api/accounts'], ['POST', '/__gw/api/accounts/projB/password'], ['DELETE', '/__gw/api/accounts/projB'], ['GET', '/__gw/admin']]) {
      const response = await ctx.a.request(method, url, { json: method === 'GET' ? undefined : { password: '123456' } });
      assert.equal(response.status, 403, `${method} ${url}`);
    }
  }],
];

export const authScenarios = [
  ['AUTH-01', '未登录时被拦截', async (ctx) => {
    const anon = new Client(ctx.gw);
    for (const url of ['/', '/some/deep/link']) {
      const response = await anon.get(url, html);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `/__gw/login?next=${encodeURIComponent(url)}`);
    }
    assert.equal((await anon.get('/api/projects')).status, 401);
    for (const pathname of ['/ws', '/shell']) {
      const result = await anon.websocket(pathname);
      assert.equal(result.ok, false);
      assert.equal(result.status, 401, pathname);
    }
  }],

  ['AUTH-02', '登录后直接进入主界面，聊天和终端 WebSocket 可连接', async (ctx) => {
    assert.equal(ctx.a.bootstrap.account, 'projA');
    const page = await ctx.a.get('/', html);
    assert.match(page.text, /\/__gw\/static\/inject\.js/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    for (const pathname of ['/ws', '/shell']) {
      const result = await ctx.a.websocket(`${pathname}?token=${encodeURIComponent(ctx.a.bootstrap.token)}`);
      assert.equal(result.ok, true, `${pathname}: ${result.status ?? result.error}`);
      result.socket.close();
    }
  }],

  ['AUTH-03', '密码错误不会启动子进程', async (ctx) => {
    const client = new Client(ctx.gw);
    const response = await client.login('projB', 'wrong-password');
    assert.equal(response.status, 401);
    assert.equal(response.body.error, '用户名或密码错误');
    assert.equal(readRunFile(ctx.fixture, 'projB'), null);
    assert.equal((await new Client(ctx.gw).login('nobody', 'whatever')).status, 401);
  }],

  ['AUTH-04', '上游登录接口不对浏览器开放', async (ctx) => {
    for (const url of ['/api/auth/register', '/api/auth/login']) {
      const response = await ctx.a.post(url, { username: 'cloudcli-internal', password: 'x' });
      assert.equal(response.status, 403, url);
      assert.equal(response.body.error, 'Handled by the gateway');
    }
  }],

  ['AUTH-05', 'token 不能跨账号使用', async (ctx) => {
    assert.equal((await ctx.b.login('projB', 'passB1')).status, 200);
    await ctx.b.openApp();
    const runB = readRunFile(ctx.fixture, 'projB');
    assert.ok(runB?.port);
    const crossed = await fetch(`http://127.0.0.1:${runB.port}/api/auth/user`, { headers: { authorization: `Bearer ${ctx.a.bootstrap.token}` } });
    assert.equal(crossed.status, 401);
    const own = await fetch(`http://127.0.0.1:${runB.port}/api/auth/user`, { headers: { authorization: `Bearer ${ctx.b.bootstrap.token}` } });
    assert.equal(own.status, 200);
  }],

  ['AUTH-06', '切换账号时注入脚本会清空本地数据（静态检查）', async (ctx) => {
    const script = await ctx.a.get('/__gw/static/inject.js');
    assert.equal(script.status, 200);
    assert.match(script.text, /storage\.getItem\('gw-account'\) !== gw\.account\) storage\.clear\(\)/);
    assert.notEqual(ctx.a.bootstrap.token, ctx.b.bootstrap.token);
  }],

  ['AUTH-07', '退出登录清除登录态', async (ctx) => {
    const client = new Client(ctx.gw);
    await client.login('projA', 'passA1');
    const logout = await client.get('/__gw/logout');
    assert.equal(logout.status, 200);
    assert.match(client.lastSetCookie, /Max-Age=0/);
    assert.match(logout.text, /localStorage\.clear\(\)/);
    assert.equal(client.cookie, null);
    assert.equal((await client.get('/', html)).status, 302);
  }],

  ['AUTH-08', '管理员能进入账号管理', async (ctx) => {
    assert.equal((await ctx.admin.get('/__gw/admin')).status, 200);
    assert.equal(ctx.admin.bootstrap.role, 'admin');
  }],

  ['AUTH-09', '登录态过期或被篡改', async (ctx) => {
    const secret = fs.readFileSync(path.join(ctx.fixture.dataRoot, 'secret.key'));
    const account = (await ctx.admin.get('/__gw/api/accounts')).body.accounts.find((entry) => entry.username === 'projA');
    assert.ok(account);
    const payload = Buffer.from(JSON.stringify({ uid: 2, pv: 1, exp: Date.now() - 1000 })).toString('base64url');
    const expired = `gw_session=${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
    const forged = `gw_session=${payload}.AAAA`;
    for (const cookie of [expired, forged]) {
      const client = new Client(ctx.gw);
      client.cookie = cookie;
      assert.equal((await client.get('/api/projects')).status, 401);
      assert.equal((await client.get('/', html)).status, 302);
    }
  }],

  ['AUTH-10', '登录失败限速', async (ctx) => {
    const client = new Client(ctx.gw);
    for (let i = 0; i < 4; i += 1) assert.equal((await client.login('projB', 'bad')).status, 401);
    assert.equal((await client.login('projB', 'passB1')).status, 200, '4 failures then the right password succeeds');
    for (let i = 0; i < 5; i += 1) assert.equal((await client.login('projB', 'bad')).status, 401);
    const locked = await client.login('projB', 'passB1');
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal((await client.login('projB', 'bad')).status, 429);
  }],

  ['AUTH-11', '锁定到期后恢复', async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    assert.equal((await new Client(ctx.gw).login('projB', 'passB1')).status, 200);
  }],

  ['AUTH-12', '同一 IP 尝试多个用户名也被限速', async (ctx) => {
    const ip = '10.99.0.1';
    for (let i = 0; i < 5; i += 1) assert.equal((await new Client(ctx.gw, { ip }).login(`ghost${i}`, 'bad')).status, 401);
    assert.equal((await new Client(ctx.gw, { ip }).login('projA', 'passA1')).status, 429);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
  }],

  ['AUTH-13', 'Cookie 安全属性', async (ctx) => {
    const plain = new Client(ctx.gw);
    await plain.login('projA', 'passA1');
    assert.match(plain.lastSetCookie, /HttpOnly/);
    assert.match(plain.lastSetCookie, /SameSite=Lax/);
    assert.doesNotMatch(plain.lastSetCookie, /Secure/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(plain.lastSetCookie)[1]);
    assert.ok(maxAge > 0 && maxAge <= 7 * 24 * 3600);
    const behindHttps = new Client(ctx.gw);
    await behindHttps.request('POST', '/__gw/api/login', { json: { username: 'projA', password: 'passA1' }, headers: { 'x-forwarded-proto': 'https' } });
    assert.match(behindHttps.lastSetCookie, /Secure/);
  }],

  ['AUTH-14', '打开首页时下发有效的上游 token', async (ctx) => {
    const { bootstrap } = await ctx.a.openApp();
    const payload = JSON.parse(Buffer.from(bootstrap.token.split('.')[1], 'base64url').toString('utf8'));
    assert.ok(payload.exp * 1000 - Date.now() > 24 * 3600 * 1000, 'token has more than a day left');
    const user = await ctx.a.api('GET', '/api/auth/user');
    assert.equal(user.status, 200);
  }],

  ['AUTH-15', '网关默认只监听本机', async () => {
    assert.equal(loadConfig({}).host, '127.0.0.1');
  }],

  ['AUTH-16', '对外监听且无 HTTPS 时给出警告', async (ctx) => {
    const other = new GatewayProcess({ ...ctx.fixture, dataRoot: path.join(ctx.fixture.root, 'data-warning') }, { childMode: ctx.childMode });
    await other.start({ CLOUDCLI_MULTI_HOST: '0.0.0.0', CLOUDCLI_MULTI_TRUST_PROXY: 'false' });
    try {
      await waitFor(() => other.output.includes('WARNING'), { timeoutMs: 5_000, message: 'warning' });
    } finally {
      await other.stop();
    }
  }],
];

export const passwordScenarios = [
  ['ACC-07', '重置密码', async (ctx) => {
    const browserX = new Client(ctx.gw);
    assert.equal((await browserX.login('projA', 'passA1')).status, 200);
    assert.equal((await ctx.admin.post('/__gw/api/accounts/projA/password', { password: 'newpassA' })).status, 200);
    assert.equal((await new Client(ctx.gw).login('projA', 'passA1')).status, 401);
    assert.equal((await new Client(ctx.gw).login('projA', 'newpassA')).status, 200);
    assert.equal((await browserX.get('/api/projects')).status, 401, 'an existing session is signed out');
    assert.equal((await browserX.get('/', html)).status, 302);
    // Restore the password for the scenarios that follow.
    await ctx.admin.post('/__gw/api/accounts/projA/password', { password: 'passA1' });
    assert.equal((await ctx.a.login('projA', 'passA1')).status, 200);
    await ctx.a.openApp();
  }],
];
