import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readRunFile, searchSessions, waitFor, writeTranscript } from '../harness.mjs';

async function projects(client) {
  const response = await client.api('GET', '/api/projects');
  assert.equal(response.status, 200, response.text);
  return response.body;
}

const projectPaths = async (client) => (await projects(client)).map((project) => project.fullPath);
const sessionIds = async (client) => (await projects(client)).flatMap((project) => (project.sessions ?? []).map((session) => session.id));
const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}/`);

export const workspaceScenarios = [
  ['WS-01', '目录浏览限定在本账号目录', async (ctx) => {
    const { fixture } = ctx;
    const browse = (p) => ctx.a.api('GET', `/api/file-tree/browse-filesystem?path=${encodeURIComponent(p)}`);
    assert.equal((await browse(fixture.projA)).status, 200);
    assert.equal((await browse(path.join(fixture.projA, 'app1'))).status, 200);
    for (const p of [fixture.projB, `${fixture.projA}/../projB`, '/etc']) assert.equal((await browse(p)).status, 403, p);
  }],

  ['WS-02', '符号链接不能绕过', async (ctx) => {
    const link = path.join(ctx.fixture.projA, 'link-to-b');
    fs.symlinkSync(ctx.fixture.projB, link);
    try {
      assert.equal((await ctx.a.api('GET', `/api/file-tree/browse-filesystem?path=${encodeURIComponent(link)}`)).status, 403);
    } finally {
      fs.rmSync(link, { force: true });
    }
  }],

  ['WS-03', '新建文件夹限定在本账号目录', async (ctx) => {
    const evil = path.join(ctx.fixture.projB, 'evil');
    assert.equal((await ctx.a.api('POST', '/api/file-tree/create-folder', { path: evil })).status, 403);
    assert.ok(!fs.existsSync(evil));
  }],

  ['WS-05', '只读目录收窄到本账号的对话记录', async (ctx) => {
    const list = await projects(ctx.a);
    const projectId = list[0].projectId;
    const read = (file) => ctx.a.api('GET', `/api/file-tree/projects/${projectId}/file?filePath=${encodeURIComponent(file)}`);
    const own = await read(ctx.transcripts.sA);
    assert.equal(own.status, 200, own.text);
    // sT (projA-tmp) shares projA's encoded prefix and stays readable: known limitation T-4 (mydocs/03 section 14).
    for (const file of [ctx.transcripts.sB, ctx.transcripts.sH]) {
      const response = await read(file);
      assert.notEqual(response.status, 200, file);
      assert.doesNotMatch(response.text, /ZEBRA/);
    }
  }],
];

export const sessionScenarios = [
  ['SES-01', '项目列表只含本账号项目', async (ctx) => {
    const paths = await waitFor(async () => {
      const list = await projectPaths(ctx.a);
      return list.length ? list : null;
    }, { message: 'projA projects' });
    assert.ok(paths.includes(path.join(ctx.fixture.projA, 'app1')), JSON.stringify(paths));
    assert.ok(paths.every((p) => within(ctx.fixture.projA, p)), JSON.stringify(paths));
  }],

  ['SES-02', '会话列表只含本账号会话', async (ctx) => {
    const ids = await sessionIds(ctx.a);
    assert.ok(ids.includes(ctx.ids.sA));
    for (const id of [ctx.ids.sB, ctx.ids.sT, ctx.ids.sH]) assert.ok(!ids.includes(id), id);
  }],

  ['SES-03', '搜索不跨账号', async (ctx) => {
    const fromA = await searchSessions(ctx.a, 'ZEBRA');
    assert.ok(fromA.includes(ctx.ids.sA), 'projA finds its own session');
    for (const id of [ctx.ids.sB, ctx.ids.sT, ctx.ids.sH]) assert.ok(!fromA.includes(id), id);
    const fromB = await searchSessions(ctx.b, 'ZEBRA-B');
    assert.ok(fromB.includes(ctx.ids.sB), 'projB finds sB');
  }],

  ['SES-04', '在账号目录里新产生的会话自动归属（模拟系统终端里运行 claude）', async (ctx) => {
    const id = 'dddddddd-0000-4000-8000-000000000004';
    writeTranscript(ctx.fixture, path.join(ctx.fixture.projA, 'app1'), id, 'ZEBRA-NEW');
    await waitFor(async () => (await sessionIds(ctx.a)).includes(id), { timeoutMs: 60_000, message: 'new session in projA' });
    assert.ok(!(await sessionIds(ctx.b)).includes(id));
    await waitFor(async () => (await sessionIds(ctx.admin)).includes(id), { timeoutMs: 60_000, message: 'new session in admin' });
  }],

  ['SES-05', '路径边界不误判', async (ctx) => {
    const paths = await projectPaths(ctx.a);
    assert.ok(!paths.includes(ctx.fixture.projAtmp), JSON.stringify(paths));
    assert.ok(!(await sessionIds(ctx.a)).includes(ctx.ids.sT));
  }],

  ['SES-06', '用 sessionId 访问别的账号的会话', async (ctx) => {
    const id = ctx.ids.sB;
    assert.equal((await ctx.a.api('GET', `/api/providers/sessions/${id}`)).status, 404);
    assert.equal((await ctx.a.api('PUT', `/api/providers/sessions/${id}`, { summary: 'x' })).status, 404);
    assert.notEqual((await ctx.a.api('POST', `/api/providers/sessions/${id}/fork`, {})).status, 200);
    assert.notEqual((await ctx.a.api('DELETE', `/api/providers/sessions/${id}`)).status, 200);
    assert.ok(fs.existsSync(ctx.transcripts.sB), 'transcript untouched');
    assert.ok((await sessionIds(ctx.b)).includes(id), 'still listed for projB');
  }],

  ['SES-07', '用 projectId 访问别的账号的项目', async (ctx) => {
    const projectB = (await projects(ctx.b)).find((project) => project.fullPath === path.join(ctx.fixture.projB, 'app2'));
    assert.ok(projectB);
    const id = projectB.projectId;
    for (const url of [`/api/projects/${id}/sessions`, `/api/file-tree/projects/${id}/files`, `/api/git/status?project=${id}`, `/api/taskmaster/tasks/${id}`, `/api/worktrees?project=${id}`]) {
      const response = await ctx.a.api('GET', url);
      // Some upstream routes answer 200 with an error body; either way nothing of projB may come back.
      assert.ok(response.status !== 200 || response.body?.error, `${url}: ${response.text.slice(0, 120)}`);
      assert.ok(!response.text.includes(ctx.fixture.projB), `${url} leaks projB`);
    }
  }],

  ['SES-08', '管理员能看到全机会话', async (ctx) => {
    const paths = await waitFor(async () => {
      const list = await projectPaths(ctx.admin);
      return list.length >= 4 ? list : null;
    }, { message: 'admin projects' });
    for (const p of [path.join(ctx.fixture.projA, 'app1'), path.join(ctx.fixture.projB, 'app2'), ctx.fixture.projAtmp, path.join(ctx.fixture.home, 'other')]) {
      assert.ok(paths.includes(p), `${p} in ${JSON.stringify(paths)}`);
    }
  }],
];

export const apiScenarios = [
  ['API-01', '新建会话指定目录外路径', async (ctx) => {
    const target = path.join(ctx.fixture.projB, 'app2');
    const response = await ctx.a.api('POST', '/api/providers/sessions', { provider: 'claude', projectPath: target, initialMessage: 'x' });
    assert.equal(response.status, 403, response.text);
    assert.ok(!(await projectPaths(ctx.a)).includes(target));
  }],

  ['API-02', '新建会话指定本账号路径', async (ctx) => {
    const response = await ctx.a.api('POST', '/api/providers/sessions', { provider: 'claude', projectPath: path.join(ctx.fixture.projA, 'app1'), initialMessage: 'x' });
    assert.equal(response.status, 201, response.text);
    ctx.state.appSessionA = response.body.data.sessionId;
  }],

  ['API-03', 'Agent API 指定目录外路径', async (ctx) => {
    const key = await ctx.a.api('POST', '/api/settings/api-keys', { keyName: 'check' });
    ctx.state.agentKey = key.body.apiKey.apiKey;
    const response = await ctx.a.request('POST', '/api/agent', { json: { projectPath: path.join(ctx.fixture.projB, 'app2'), message: 'hi', stream: false }, headers: { 'x-api-key': ctx.state.agentKey } });
    assert.equal(response.status, 403, response.text);
    assert.match(response.text, /workspace/);
  }],

  ['API-04', 'Agent API 克隆到目录外', async (ctx) => {
    const target = path.join(ctx.fixture.projB, 'clone');
    const response = await ctx.a.request('POST', '/api/agent', { json: { githubUrl: 'https://github.com/octocat/Hello-World', projectPath: target, message: 'hi', stream: false }, headers: { 'x-api-key': ctx.state.agentKey } });
    assert.equal(response.status, 403, response.text);
    assert.ok(!fs.existsSync(target));
  }],

  ['API-04b', 'Agent API 未指定 projectPath', async (ctx) => {
    const response = await ctx.a.request('POST', '/api/agent', { json: { githubUrl: 'https://github.com/octocat/Hello-World', message: 'hi', stream: false }, headers: { 'x-api-key': ctx.state.agentKey } });
    assert.equal(response.status, 400, response.text);
    assert.match(response.text, /projectPath is required/);
    assert.ok(!fs.existsSync(path.join(ctx.fixture.home, '.claude', 'external-projects')));
  }],

  ['API-06', '斜杠命令读取目录外文件', async (ctx) => {
    const target = path.join(ctx.fixture.projB, 'app2');
    const list = await ctx.a.api('POST', '/api/commands/list', { projectPath: target });
    assert.equal(list.status, 403);
    const memory = await ctx.a.api('POST', '/api/commands/execute', { commandName: '/memory', context: { projectPath: target } });
    assert.equal(memory.status, 403);
    assert.doesNotMatch(memory.text, /SECRET-B/);
    const own = await ctx.a.api('POST', '/api/commands/list', { projectPath: path.join(ctx.fixture.projA, 'app1') });
    assert.equal(own.status, 200);
  }],

  ['API-09', 'MCP 接口指定目录外的 workspacePath', async (ctx) => {
    const target = path.join(ctx.fixture.projB, 'app2');
    const query = `workspacePath=${encodeURIComponent(target)}`;
    assert.equal((await ctx.a.api('GET', `/api/providers/claude/mcp/servers?${query}`)).status, 403);
    assert.equal((await ctx.a.api('POST', '/api/providers/claude/mcp/servers', { name: 'x', scope: 'project', transport: 'stdio', command: 'echo', workspacePath: target })).status, 403);
    assert.equal((await ctx.a.api('DELETE', `/api/providers/claude/mcp/servers/x?scope=project&${query}`)).status, 403);
    assert.ok(!fs.existsSync(path.join(target, '.mcp.json')));
  }],

  ['API-10', 'Skills 列表指定目录外的 workspacePath', async (ctx) => {
    // Only listing takes a workspace; adding and removing skills work on the user-level directory.
    const target = path.join(ctx.fixture.projB, 'app2');
    assert.equal((await ctx.a.api('GET', `/api/providers/claude/skills?workspacePath=${encodeURIComponent(target)}`)).status, 403);
  }],

  ['API-11', 'MCP 与 Skills 在本账号目录内正常', async (ctx) => {
    const own = path.join(ctx.fixture.projA, 'app1');
    const added = await ctx.a.api('POST', '/api/providers/claude/mcp/servers', { name: 'check-mcp', scope: 'project', transport: 'stdio', command: 'echo', workspacePath: own });
    assert.equal(added.status, 201, added.text);
    assert.match(fs.readFileSync(path.join(own, '.mcp.json'), 'utf8'), /check-mcp/);
    assert.equal((await ctx.a.api('GET', `/api/providers/claude/skills?workspacePath=${encodeURIComponent(own)}`)).status, 200);
  }],

  ['API-08', '子进程只监听 127.0.0.1', async (ctx) => {
    const run = readRunFile(ctx.fixture, 'projA');
    assert.ok(run?.port);
    const listening = fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1).filter(Boolean).map((line) => line.trim().split(/\s+/)).filter((cols) => cols[3] === '0A');
    const own = listening.filter((cols) => Number.parseInt(cols[1].split(':')[1], 16) === run.port);
    assert.ok(own.length > 0, 'child port is listening');
    for (const cols of own) assert.equal(cols[1].split(':')[0], '0100007F', 'bound to 127.0.0.1');
  }],
];

