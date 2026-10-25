// End-to-end checks through the gateway with three member accounts:
// ISO-* cross-account isolation, FUN-* features working inside an account,
// GLB-* probes of what a member can change outside its workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { checkMemberRequest } from '../../proxy/member-policy.mjs';
import { Client, waitFor, writeTranscript } from '../harness.mjs';

const html = { headers: { accept: 'text/html' } };
const ACCOUNTS = ['projA', 'projB', 'projC'];

async function projectList(client) {
  const response = await client.api('GET', '/api/projects');
  assert.equal(response.status, 200, response.text);
  return response.body;
}

/** Opens a WebSocket through the gateway and collects JSON frames. */
async function openSocket(client, pathname) {
  const result = await client.websocket(`${pathname}?token=${encodeURIComponent(client.bootstrap.token)}`);
  assert.equal(result.ok, true, `${pathname}: ${result.status ?? result.error}`);
  const frames = [];
  result.socket.on('message', (data) => {
    try {
      frames.push(JSON.parse(String(data)));
    } catch {
      frames.push({ raw: String(data) });
    }
  });
  return { socket: result.socket, frames };
}

/** Runs one command in the web terminal and returns its output. */
async function runInTerminal(client, cwd, command, marker) {
  const { socket, frames } = await openSocket(client, '/shell');
  socket.send(JSON.stringify({ type: 'init', projectPath: cwd, isPlainShell: true, initialCommand: command, cols: 120, rows: 30, forceRestart: true }));
  const output = () => frames.filter((frame) => frame.type === 'output').map((frame) => frame.data).join('');
  try {
    await waitFor(() => output().includes(marker), { timeoutMs: 15_000, message: `terminal output ${marker}` });
  } finally {
    socket.close();
  }
  return output();
}

export const e2eSetupScenarios = [
  ['E2E-00', '准备第三个普通账号 projC 及其会话', async (ctx) => {
    const projC = path.join(ctx.fixture.w, 'projC');
    assert.equal((await ctx.admin.post('/__gw/api/accounts', { username: 'projC', password: 'passC1', workspaceRoot: projC })).status, 201);
    ctx.ids.sC = 'ffffffff-0000-4000-8000-000000000006';
    ctx.transcripts.sC = writeTranscript(ctx.fixture, path.join(projC, 'app3'), ctx.ids.sC, 'ZEBRA-C');
    ctx.fixture.projC = projC;
    ctx.c = new Client(ctx.gw);
    await ctx.c.login('projC', 'passC1');
    await ctx.c.openApp();
    ctx.clients = { projA: ctx.a, projB: ctx.b, projC: ctx.c };
    ctx.roots = { projA: ctx.fixture.projA, projB: ctx.fixture.projB, projC };
    ctx.ownSession = { projA: ctx.ids.sA, projB: ctx.ids.sB, projC: ctx.ids.sC };
    ctx.ownFile = { projA: ctx.transcripts.sA, projB: path.join(ctx.fixture.projB, 'app2', 'CLAUDE.md'), projC: ctx.transcripts.sC };
    for (const name of ACCOUNTS) {
      await waitFor(async () => (await projectList(ctx.clients[name])).length > 0, { message: `${name} projects` });
    }
  }],
];

export const crossScenarios = [
  ['ISO-01', '三个账号两两之间：项目、会话、搜索互不可见', async (ctx) => {
    const word = { projA: 'ZEBRA-A', projB: 'ZEBRA-B', projC: 'ZEBRA-C' };
    for (const viewer of ACCOUNTS) {
      const list = await projectList(ctx.clients[viewer]);
      const paths = list.map((project) => project.fullPath);
      const sessions = list.flatMap((project) => (project.sessions ?? []).map((session) => session.id));
      assert.ok(paths.every((p) => p === ctx.roots[viewer] || p.startsWith(`${ctx.roots[viewer]}/`)), `${viewer}: ${JSON.stringify(paths)}`);
      assert.ok(sessions.includes(ctx.ownSession[viewer]), `${viewer} sees its own session`);
      for (const other of ACCOUNTS.filter((name) => name !== viewer)) {
        assert.ok(!sessions.includes(ctx.ownSession[other]), `${viewer} sees ${other}'s session`);
        const response = await fetch(`${ctx.gw.base}/api/providers/search/sessions?q=${word[other]}&token=${ctx.clients[viewer].bootstrap.token}`, { headers: { cookie: ctx.clients[viewer].cookie }, signal: AbortSignal.timeout(15_000) });
        const text = await response.text();
        assert.ok(!text.includes(ctx.ownSession[other]), `${viewer} finds ${other}'s session by search`);
      }
    }
  }],

  ['ISO-02', '三个账号两两之间：用自己的项目读写别人的文件', async (ctx) => {
    for (const viewer of ACCOUNTS) {
      const client = ctx.clients[viewer];
      const projectId = (await projectList(client))[0].projectId;
      for (const other of ACCOUNTS.filter((name) => name !== viewer)) {
        const target = ctx.ownFile[other];
        const read = await client.api('GET', `/api/file-tree/projects/${projectId}/file?filePath=${encodeURIComponent(target)}`);
        assert.notEqual(read.status, 200, `${viewer} reads ${target}`);
        const content = await client.api('GET', `/api/file-tree/projects/${projectId}/files/content?path=${encodeURIComponent(target)}`);
        assert.notEqual(content.status, 200, `${viewer} reads content of ${target}`);
        const write = await client.api('PUT', `/api/file-tree/projects/${projectId}/file`, { filePath: path.join(ctx.roots[other], 'pwned.txt'), content: 'x' });
        assert.notEqual(write.status, 200, `${viewer} writes into ${other}`);
        assert.ok(!fs.existsSync(path.join(ctx.roots[other], 'pwned.txt')));
        const relative = path.relative(path.dirname(ctx.ownFile[viewer]), path.join(ctx.roots[other], 'pwned2.txt'));
        const create = await client.api('POST', `/api/file-tree/projects/${projectId}/files/create`, { name: 'pwned2.txt', type: 'file', path: path.dirname(relative) });
        assert.notEqual(create.status, 200, `${viewer} creates a file in ${other} through ../`);
        assert.ok(!fs.existsSync(path.join(ctx.roots[other], 'pwned2.txt')));
        const browse = await client.api('GET', `/api/file-tree/browse-filesystem?path=${encodeURIComponent(ctx.roots[other])}`);
        assert.equal(browse.status, 403, `${viewer} browses ${other}`);
      }
    }
  }],

  ['ISO-03', '三个账号两两之间：用别人的 sessionId / projectId 操作', async (ctx) => {
    const projectIds = {};
    for (const name of ACCOUNTS) projectIds[name] = (await projectList(ctx.clients[name]))[0].projectId;
    for (const viewer of ACCOUNTS) {
      const client = ctx.clients[viewer];
      for (const other of ACCOUNTS.filter((name) => name !== viewer)) {
        const sessionId = ctx.ownSession[other];
        for (const [method, url, body] of [
          ['GET', `/api/providers/sessions/${sessionId}`],
          ['GET', `/api/providers/sessions/${sessionId}/messages`],
          ['PUT', `/api/providers/sessions/${sessionId}`, { summary: 'hijacked' }],
          ['DELETE', `/api/providers/sessions/${sessionId}`],
          ['GET', `/api/projects/${projectIds[other]}/sessions`],
          ['GET', `/api/file-tree/projects/${projectIds[other]}/files`],
        ]) {
          const response = await client.api(method, url, body);
          assert.ok(response.status >= 400 || response.body?.error, `${viewer} ${method} ${url} -> ${response.status} ${response.text.slice(0, 80)}`);
          assert.ok(!response.text.includes('ZEBRA-'), `${viewer} ${method} ${url} leaks content`);
        }
      }
    }
    // Upstream answers a rename of an unknown id with success while updating
    // nothing, so this one is judged by its effect below.
    for (const viewer of ACCOUNTS) {
      for (const other of ACCOUNTS.filter((name) => name !== viewer)) {
        await ctx.clients[viewer].api('PUT', `/api/projects/${projectIds[other]}/rename`, { displayName: 'hijacked' });
      }
    }
    for (const name of ACCOUNTS) {
      const list = await projectList(ctx.clients[name]);
      assert.ok(list.flatMap((project) => project.sessions ?? []).some((session) => session.id === ctx.ownSession[name]), `${name} session survived`);
      assert.ok(!list.some((project) => project.displayName === 'hijacked'));
    }
  }],

  ['ISO-04', '三个账号两两之间：在别人的目录里新建会话、新建项目', async (ctx) => {
    for (const viewer of ACCOUNTS) {
      for (const other of ACCOUNTS.filter((name) => name !== viewer)) {
        const target = path.join(ctx.roots[other], 'intrude');
        const session = await ctx.clients[viewer].api('POST', '/api/providers/sessions', { provider: 'claude', projectPath: target, initialMessage: 'x' });
        assert.equal(session.status, 403, `${viewer} session in ${other}`);
        const project = await ctx.clients[viewer].api('POST', '/api/projects/create-project', { path: target });
        assert.ok(project.status >= 400, `${viewer} project in ${other}: ${project.status}`);
        assert.ok(!fs.existsSync(target));
      }
    }
  }],

  ['ISO-05', '各账号的设置（API Key）互不可见', async (ctx) => {
    const created = await ctx.c.api('POST', '/api/settings/api-keys', { keyName: 'only-for-C' });
    assert.equal(created.status, 200, created.text);
    for (const viewer of ['projA', 'projB']) {
      const list = await ctx.clients[viewer].api('GET', '/api/settings/api-keys');
      assert.ok(!list.text.includes('only-for-C'), `${viewer} sees projC's key`);
    }
    assert.match((await ctx.c.api('GET', '/api/settings/api-keys')).text, /only-for-C/);
  }],
];

export const featureScenarios = [
  ['FUN-01', '前端页面和静态资源经网关正常加载', async (ctx) => {
    const page = await ctx.c.get('/', html);
    assert.equal(page.status, 200);
    const assets = [...page.text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    assert.ok(assets.length >= 2, `assets: ${assets.join(',')}`);
    for (const asset of assets) {
      const response = await ctx.c.get(asset);
      assert.equal(response.status, 200, asset);
      assert.ok(response.text.length > 0, asset);
    }
  }],

  ['FUN-02', '新建项目、重命名项目', async (ctx) => {
    const target = path.join(ctx.roots.projC, 'newproj');
    const created = await ctx.c.api('POST', '/api/projects/create-project', { path: target });
    assert.ok(created.status < 300, created.text);
    const project = (await projectList(ctx.c)).find((entry) => entry.fullPath === target);
    assert.ok(project, 'new project listed');
    ctx.state.newProjectId = project.projectId;
    const renamed = await ctx.c.api('PUT', `/api/projects/${project.projectId}/rename`, { displayName: '新项目' });
    assert.ok(renamed.status < 300, renamed.text);
    assert.equal((await projectList(ctx.c)).find((entry) => entry.projectId === project.projectId).displayName, '新项目');
  }],

  ['FUN-03', '文件新建、写入、读取、重命名、删除', async (ctx) => {
    const id = ctx.state.newProjectId;
    const root = path.join(ctx.roots.projC, 'newproj');
    const base = `/api/file-tree/projects/${id}`;
    assert.ok((await ctx.c.api('POST', `${base}/files/create`, { name: 'hello.txt', type: 'file', path: '' })).status < 300);
    assert.ok((await ctx.c.api('POST', `${base}/files/create`, { name: 'src', type: 'directory', path: '' })).status < 300);
    const saved = await ctx.c.api('PUT', `${base}/file`, { filePath: path.join(root, 'hello.txt'), content: '你好 gateway' });
    assert.ok(saved.status < 300, saved.text);
    const read = await ctx.c.api('GET', `${base}/file?filePath=${encodeURIComponent(path.join(root, 'hello.txt'))}`);
    assert.equal(read.status, 200);
    assert.match(read.text, /你好 gateway/);
    const listed = await ctx.c.api('GET', `${base}/files`);
    assert.match(listed.text, /hello\.txt/);
    assert.ok((await ctx.c.api('PUT', `${base}/files/rename`, { oldPath: path.join(root, 'hello.txt'), newName: 'hello2.txt' })).status < 300);
    assert.ok(fs.existsSync(path.join(root, 'hello2.txt')));
    assert.ok((await ctx.c.api('DELETE', `${base}/files`, { path: path.join(root, 'hello2.txt') })).status < 300);
    assert.ok(!fs.existsSync(path.join(root, 'hello2.txt')));
  }],

  ['FUN-04', 'git：初始化、状态、首次提交、分支', async (ctx) => {
    const project = ctx.state.newProjectId;
    fs.writeFileSync(path.join(ctx.roots.projC, 'newproj', 'README.md'), '# demo\n');
    const init = await ctx.c.api('POST', '/api/git/init', { project });
    assert.ok(init.status < 300, init.text);
    assert.ok(fs.existsSync(path.join(ctx.roots.projC, 'newproj', '.git')), 'repository created in the project itself');
    const status = await ctx.c.api('GET', `/api/git/status?project=${project}`);
    assert.equal(status.status, 200, status.text);
    assert.notEqual(status.body.branch, 'feat/multi-account', 'must not operate on the outer repository');
    assert.ok(!status.body.error, status.text);
    assert.match(status.text, /README\.md/);
    const commit = await ctx.c.api('POST', '/api/git/initial-commit', { project });
    assert.ok(commit.status < 300 && !commit.body?.error, commit.text);
    const branches = await ctx.c.api('GET', `/api/git/branches?project=${project}`);
    assert.equal(branches.status, 200);
    assert.ok(!branches.body.error, branches.text);
  }],

  ['FUN-05', '会话：读取消息、重命名', async (ctx) => {
    const id = ctx.ids.sC;
    const messages = await ctx.c.api('GET', `/api/providers/sessions/${id}/messages`);
    assert.equal(messages.status, 200, messages.text.slice(0, 200));
    assert.match(messages.text, /ZEBRA-C/);
    const renamed = await ctx.c.api('PUT', `/api/providers/sessions/${id}`, { summary: '我的会话' });
    assert.ok(renamed.status < 300, renamed.text);
    const sessions = (await projectList(ctx.c)).flatMap((project) => project.sessions ?? []);
    assert.equal(sessions.find((session) => session.id === id)?.summary, '我的会话');
  }],

  ['FUN-06', '网页终端：在本账号目录执行命令', async (ctx) => {
    const cwd = path.join(ctx.roots.projC, 'newproj');
    const output = await runInTerminal(ctx.c, cwd, 'echo TERM-OK-$((20+22)); pwd', 'TERM-OK-42');
    assert.match(output, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }],

  ['FUN-07', '聊天 WebSocket：消息送达本账号的会话并收到回应', async (ctx) => {
    const created = await ctx.c.api('POST', '/api/providers/sessions', { provider: 'claude', projectPath: path.join(ctx.roots.projC, 'newproj'), initialMessage: 'hi' });
    assert.equal(created.status, 201, created.text);
    const sessionId = created.body.data.sessionId;
    const { socket, frames } = await openSocket(ctx.c, '/ws');
    try {
      socket.send(JSON.stringify({ type: 'chat.send', sessionId, content: 'hi', options: { cwd: ctx.roots.projA } }));
      await waitFor(() => frames.some((frame) => JSON.stringify(frame).includes(sessionId)), { timeoutMs: 20_000, message: 'chat frames' });
      // Wait for the run (and the Claude CLI it started) to end: the CLI rewrites
      // ~/.claude.json and would race later scenarios that edit it (T-7).
      await waitFor(() => frames.some((frame) => frame.kind === 'complete' || frame.type === 'complete'), { timeoutMs: 60_000, message: 'chat complete' });
      await waitFor(async () => (await ctx.c.api('GET', '/api/providers/sessions/running')).body?.data?.sessions?.length === 0, { timeoutMs: 30_000, message: 'no running session' });
    } finally {
      socket.close();
    }
    ctx.state.chatFrameTypes = [...new Set(frames.map((frame) => frame.type ?? frame.kind ?? '?'))].join(', ');
  }],

  ['FUN-08', '上传附件并读回', async (ctx) => {
    const form = new FormData();
    form.append('files', new Blob(['attachment from projC'], { type: 'text/plain' }), 'note.txt');
    const response = await fetch(`${ctx.gw.base}/api/assets/files`, { method: 'POST', body: form, headers: { cookie: ctx.c.cookie, authorization: `Bearer ${ctx.c.bootstrap.token}` } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const stored = JSON.stringify(body).match(/[\w-]+\.txt/g)?.find((name) => name !== 'note.txt');
    assert.ok(stored, JSON.stringify(body));
    const back = await ctx.c.api('GET', `/api/assets/files/${stored}`);
    assert.equal(back.status, 200);
    assert.match(back.text, /attachment from projC/);
    ctx.state.uploadedName = stored;
  }],

  ['FUN-09', 'MCP（项目级）和 Skills 列表在本账号内正常', async (ctx) => {
    const own = path.join(ctx.roots.projC, 'newproj');
    const added = await ctx.c.api('POST', '/api/providers/claude/mcp/servers', { name: 'c-mcp', scope: 'project', transport: 'stdio', command: 'echo', workspacePath: own });
    assert.equal(added.status, 201, added.text);
    const listed = await ctx.c.api('GET', `/api/providers/claude/mcp/servers?workspacePath=${encodeURIComponent(own)}`);
    assert.match(listed.text, /c-mcp/);
    const removed = await ctx.c.api('DELETE', `/api/providers/claude/mcp/servers/c-mcp?scope=project&workspacePath=${encodeURIComponent(own)}`);
    assert.ok(removed.status < 300, removed.text);
    assert.equal((await ctx.c.api('GET', `/api/providers/claude/skills?workspacePath=${encodeURIComponent(own)}`)).status, 200);
  }],
];

/**
 * GLB-*: what a member can change outside its workspace. These record the
 * current behaviour (mydocs/01 1.1 accepts it) instead of asserting a policy.
 */
export const globalProbeScenarios = [
  ['GLB-01', '普通账号新增用户级 MCP（写 ~/.claude.json），其他账号可见', async (ctx) => {
    const added = await ctx.a.api('POST', '/api/providers/claude/mcp/servers', { name: 'global-from-A', scope: 'user', transport: 'stdio', command: 'echo' });
    const seenByB = (await ctx.b.api('GET', '/api/providers/claude/mcp/servers')).text.includes('global-from-A');
    ctx.findings.push(['GLB-01', '用户级 MCP（~/.claude.json）', added.status < 300 ? '可以修改' : `被拒绝（${added.status}）`, seenByB ? '其他账号可见' : '其他账号不可见']);
  }],

  ['GLB-02', '普通账号新增 Skill（写 ~/.claude/skills），其他账号可见', async (ctx) => {
    const added = await ctx.a.api('POST', '/api/providers/claude/skills', { content: '---\nname: from-a\ndescription: global skill from A\n---\nbody' });
    const seenByB = (await ctx.b.api('GET', '/api/providers/claude/skills')).text.includes('from-a');
    ctx.findings.push(['GLB-02', '用户级 Skills（~/.claude/skills）', added.status < 300 ? '可以修改' : `被拒绝（${added.status}）`, seenByB ? '其他账号可见' : '其他账号不可见']);
  }],

  ['GLB-03', '普通账号在网页终端里改全局 Claude 配置', async (ctx) => {
    const settings = path.join(ctx.fixture.home, '.claude', 'settings.json');
    await runInTerminal(ctx.a, ctx.roots.projA, `echo '{"probe":"from-A"}' > ~/.claude/settings.json && echo GLB3-DONE`, 'GLB3-DONE');
    const changed = fs.existsSync(settings) && fs.readFileSync(settings, 'utf8').includes('from-A');
    ctx.findings.push(['GLB-03', '网页终端写 ~/.claude/settings.json', changed ? '可以修改' : '未能修改', '影响所有账号']);
  }],

  ['GLB-04', '普通账号在网页终端里读写网关数据（账号库、签名密钥）', async (ctx) => {
    const marker = path.join(ctx.fixture.dataRoot, 'probe-from-A.txt');
    await runInTerminal(ctx.a, ctx.roots.projA, `ls ${ctx.fixture.dataRoot} > ${marker} && echo GLB4-DONE`, 'GLB4-DONE');
    const listed = fs.existsSync(marker) && /gateway\.db/.test(fs.readFileSync(marker, 'utf8')) && /secret\.key/.test(fs.readFileSync(marker, 'utf8'));
    fs.rmSync(marker, { force: true });
    ctx.findings.push(['GLB-04', '网页终端访问 ~/.cloudcli-multi（gateway.db、secret.key）', listed ? '可以读写' : '未能访问', '可借此提升为管理员或伪造登录态']);
  }],

  ['GLB-05', '普通账号在网页终端里访问其他账号的目录', async (ctx) => {
    const output = await runInTerminal(ctx.a, ctx.roots.projA, `cat ${path.join(ctx.fixture.projB, 'app2', 'CLAUDE.md')}; echo; echo GLB5-DONE`, 'GLB5-DONE');
    ctx.findings.push(['GLB-05', '网页终端读取 projB 的文件', output.includes('SECRET-B') ? '可以读取' : '未能读取', '终端不隔离（需求 1.1）']);
  }],

  ['GLB-06', '凭文件名读取其他账号上传的附件', async (ctx) => {
    if (!ctx.state.uploadedName) ctx.skip('FUN-08 未运行');
    const response = await ctx.a.api('GET', `/api/assets/files/${ctx.state.uploadedName}`);
    ctx.findings.push(['GLB-06', '附件目录 ~/.cloudcli/assets（共用）', response.status === 200 ? '知道文件名即可读取' : `被拒绝（${response.status}）`, '文件名随机，不会被列出']);
  }],

  ['GLB-07', '插件、系统更新、browser-use、全局 git 配置（只发请求看是否被拦截）', async (ctx) => {
    for (const [target, method, url] of [
      ['插件安装（~/.claude-code-ui）', 'POST', '/api/plugins/install'],
      ['browser-use 设置（~/.cloudcli/browser-use）', 'PUT', '/api/browser-use/settings'],
      ['全局 git 配置（~/.gitconfig）', 'POST', '/api/user/git-config'],
    ]) {
      const response = await ctx.a.api(method, url, {});
      ctx.findings.push(['GLB-07', target, response.status === 403 ? '被拒绝（403，方案 B）' : `未拦截（${response.status}）`, '仅管理员可改']);
    }
    // Not requested for real: an update that got through would modify the install.
    const update = checkMemberRequest({ method: 'POST', url: '/api/system/update' }, null);
    ctx.findings.push(['GLB-07', '系统更新', update?.status === 403 ? '被拒绝（403，方案 B）' : '未拦截', '仅管理员可改']);
  }],
];
