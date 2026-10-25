// Checks for the gaps an independent test found (mydocs/07): file API vs .git,
// Taskmaster file names, clone sources, /tmp read access, MCP default workspace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { APP_ROOT } from '../../config.mjs';


const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const gitEnv = (ctx) => ({ PATH: process.env.PATH, HOME: ctx.fixture.home, GIT_CEILING_DIRECTORIES: ctx.fixture.root });

/** Clone is two steps: POST registers the request, the SSE progress stream runs it. */
async function runClone(client, githubUrl, targetPath) {
  const registered = await client.api('POST', '/api/projects/clone', { githubUrl, path: targetPath });
  assert.equal(registered.status, 200, registered.text.slice(0, 120));
  const response = await fetch(`${client.gateway.base}/api/projects/clone-progress?cloneId=${registered.body.cloneId}&token=${client.bootstrap.token}`, {
    headers: { cookie: client.cookie },
    signal: AbortSignal.timeout(30_000),
  });
  let text = '';
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } catch {
    // Timed out: judge by what arrived.
  }
  return text;
}

async function projectIdFor(client, dir) {
  const response = await client.api('GET', '/api/projects');
  return response.body.find((project) => project.fullPath === dir)?.projectId;
}

export const hardeningScenarios = [
  ['HARD-01', '文件接口不能改写 .git 内部（配置、hooks），普通文件不受影响', async (ctx) => {
    const repo = path.join(ctx.roots.projC, 'hard');
    assert.ok((await ctx.c.api('POST', '/api/projects/create-project', { path: repo })).status < 300);
    const id = await projectIdFor(ctx.c, repo);
    assert.ok((await ctx.c.api('POST', '/api/git/init', { project: id })).status < 300);
    ctx.state.hardRepo = repo;
    ctx.state.hardId = id;
    const base = `/api/file-tree/projects/${id}`;
    assert.ok((await ctx.c.api('POST', `${base}/files/create`, { name: 'README.md', type: 'file', path: '' })).status < 300);
    const attempts = [
      ['PUT', `${base}/file`, { filePath: path.join(repo, '.git', 'config'), content: '[core]\n' }],
      ['PUT', `${base}/file`, { filePath: path.join(repo, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh\n' }],
      ['POST', `${base}/files/create`, { name: 'post-commit', type: 'file', path: '.git/hooks' }],
      ['PUT', `${base}/files/rename`, { oldPath: path.join(repo, 'README.md'), newName: '.git' }],
      ['DELETE', `${base}/files`, { path: path.join(repo, '.git') }],
    ];
    const before = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    for (const [method, url, body] of attempts) {
      const response = await ctx.c.api(method, url, body);
      assert.equal(response.status, 403, `${method} ${url} ${JSON.stringify(body)} -> ${response.status} ${response.text.slice(0, 100)}`);
    }
    assert.equal(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'), before, '.git/config unchanged');
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')));
    const ok = await ctx.c.api('PUT', `${base}/file`, { filePath: path.join(repo, '.gitignore'), content: 'node_modules\n' });
    assert.ok(ok.status < 300, `.gitignore stays editable: ${ok.text}`);
  }],

  ['HARD-07', '项目内的符号链接不能把文件接口带进 .git，也带不出项目、进不了别的账号', async (ctx) => {
    const repo = ctx.state.hardRepo;
    const id = ctx.state.hardId;
    if (!repo) ctx.skip('HARD-01 未运行');
    const base = `/api/file-tree/projects/${id}`;
    const victim = path.join(ctx.roots.projB, 'app2', 'CLAUDE.md');
    const victimBefore = fs.readFileSync(victim, 'utf8');
    const gitConfig = path.join(repo, '.git', 'config');
    const gitConfigBefore = fs.readFileSync(gitConfig, 'utf8');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    // Links as a cloned repository, or the terminal, could leave in the project.
    const links = {
      toGit: path.join(repo, 'link-git'),
      toOther: path.join(repo, 'link-other'),
      inside: path.join(repo, 'link-inside'),
    };
    fs.symlinkSync('.git', links.toGit);
    fs.symlinkSync(path.join(ctx.roots.projB, 'app2'), links.toOther);
    fs.symlinkSync('sub', links.inside);
    try {
      const write = (file, content) => ctx.c.api('PUT', `${base}/file`, { filePath: file, content });
      assert.equal((await write('link-git/config', '[core]\n')).status, 403, 'write into .git through a link');
      assert.equal((await write('link-git/hooks/pre-commit', '#!/bin/sh\n')).status, 403);
      assert.equal(fs.readFileSync(gitConfig, 'utf8'), gitConfigBefore, '.git/config unchanged');
      assert.equal((await write('link-other/INTRUDER.txt', 'x')).status, 403, "write into another account through a link");
      assert.ok(!fs.existsSync(path.join(ctx.roots.projB, 'app2', 'INTRUDER.txt')));
      const read = await ctx.c.api('GET', `${base}/file?filePath=${encodeURIComponent('link-other/CLAUDE.md')}`);
      assert.notEqual(read.status, 200);
      assert.ok(!read.text.includes('SECRET-B'));
      assert.equal((await ctx.c.api('DELETE', `${base}/files`, { path: 'link-other/CLAUDE.md' })).status, 403);
      assert.equal(fs.readFileSync(victim, 'utf8'), victimBefore, "another account's file untouched");
      const ok = await write('link-inside/note.txt', 'through an inside link');
      assert.ok(ok.status < 300, `a link that stays inside the project keeps working: ${ok.text.slice(0, 100)}`);
      assert.ok(fs.existsSync(path.join(repo, 'sub', 'note.txt')));
    } finally {
      for (const link of Object.values(links)) fs.rmSync(link, { force: true });
      fs.rmSync(path.join(repo, 'sub'), { recursive: true, force: true });
    }
  }],

  ['HARD-08', '命令文件：指向别的账号文件的符号链接读不出来，用户级和本账号的命令照常可用', async (ctx) => {
    const repo = ctx.state.hardRepo;
    if (!repo) ctx.skip('HARD-01 未运行');
    const victim = path.join(ctx.roots.projB, 'app2', 'CLAUDE.md');
    const commandsDir = path.join(repo, '.claude', 'commands');
    const userCommandsDir = path.join(ctx.fixture.home, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(userCommandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'mine.md'), 'my own command');
    fs.writeFileSync(path.join(userCommandsDir, 'shared.md'), 'a shared command');
    fs.symlinkSync(victim, path.join(commandsDir, 'evil.md'));
    try {
      const run = (name, file) => ctx.c.api('POST', '/api/commands/execute', { commandName: name, commandPath: file, context: { projectPath: repo } });
      const evil = await run('evil', path.join(commandsDir, 'evil.md'));
      assert.equal(evil.status, 403, evil.text.slice(0, 160));
      assert.ok(!evil.text.includes('SECRET-B'));
      const mine = await run('mine', path.join(commandsDir, 'mine.md'));
      assert.equal(mine.status, 200, mine.text.slice(0, 160));
      assert.match(mine.text, /my own command/);
      const shared = await run('shared', path.join(userCommandsDir, 'shared.md'));
      assert.equal(shared.status, 200, shared.text.slice(0, 160));
      assert.match(shared.text, /a shared command/);
    } finally {
      fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true });
      fs.rmSync(userCommandsDir, { recursive: true, force: true });
    }
  }],

  ['HARD-10', 'Taskmaster 文档、任务文件、命令列表：指向别的账号文件的符号链接不会被读出', async (ctx) => {
    const repo = ctx.state.hardRepo;
    const id = ctx.state.hardId;
    if (!repo) ctx.skip('HARD-01 未运行');
    const source = path.join(ctx.roots.projB, 'app2', 'leak-source.md');
    fs.writeFileSync(source, '---\ndescription: LEAK-DESC\n---\nLEAK-BODY');
    const tasksSource = path.join(ctx.roots.projB, 'app2', 'leak-tasks.json');
    fs.writeFileSync(tasksSource, JSON.stringify({ tasks: [{ id: 1, title: 'LEAK-TASK', status: 'pending' }] }));
    fs.mkdirSync(path.join(repo, '.taskmaster', 'docs'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.taskmaster', 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.taskmaster', 'docs', 'own.md'), 'OWN-DOC');
    fs.writeFileSync(path.join(repo, '.claude', 'commands', 'own.md'), '---\ndescription: OWN-DESC\n---\nown');
    fs.symlinkSync(source, path.join(repo, '.taskmaster', 'docs', 'leak.md'));
    fs.symlinkSync(tasksSource, path.join(repo, '.taskmaster', 'tasks', 'tasks.json'));
    fs.symlinkSync(source, path.join(repo, '.claude', 'commands', 'linked.md'));
    try {
      const doc = await ctx.c.api('GET', `/api/taskmaster/prd/${id}/leak.md`);
      assert.equal(doc.status, 403, doc.text.slice(0, 120));
      assert.ok(!doc.text.includes('LEAK-BODY'));
      const tasks = await ctx.c.api('GET', `/api/taskmaster/tasks/${id}`);
      assert.ok(!tasks.text.includes('LEAK-TASK'), tasks.text.slice(0, 160));
      const list = await ctx.c.api('POST', '/api/commands/list', { projectPath: repo });
      assert.equal(list.status, 200, list.text.slice(0, 120));
      assert.ok(!list.text.includes('LEAK-DESC'), 'the linked command is not listed');
      assert.match(list.text, /OWN-DESC/, 'the own command still is');
      const own = await ctx.c.api('GET', `/api/taskmaster/prd/${id}/own.md`);
      assert.equal(own.status, 200, own.text.slice(0, 120));
      assert.match(own.text, /OWN-DOC/);
    } finally {
      fs.rmSync(path.join(repo, '.taskmaster'), { recursive: true, force: true });
      fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true });
      fs.rmSync(source, { force: true });
      fs.rmSync(tasksSource, { force: true });
    }
  }],

  ['HARD-09', 'git 的文件参数指向工作区以外时，在应用层就被拒绝', async (ctx) => {
    const id = ctx.state.hardId;
    if (!id) ctx.skip('HARD-01 未运行');
    const outside = '../../projB/app2/CLAUDE.md';
    for (const url of [`/api/git/diff?project=${id}&file=${encodeURIComponent(outside)}`, `/api/git/file-with-diff?project=${id}&file=${encodeURIComponent(outside)}`]) {
      const response = await ctx.c.api('GET', url);
      assert.ok(!response.text.includes('SECRET-B'), `${url} leaks`);
      assert.match(response.text, /outside this account's workspace/, `rejected by the gateway-side check, not only by git: ${response.text.slice(0, 160)}`);
    }
    const own = await ctx.c.api('GET', `/api/git/diff?project=${id}&file=README.md`);
    assert.ok(!/outside this account's workspace/.test(own.text), `a file inside the project is not refused: ${own.text.slice(0, 120)}`);
  }],

  ['HARD-02', '成员进程里 git 不执行仓库配置的 fsmonitor（即使配置是从终端写进去的）', async (ctx) => {
    const repo = ctx.state.hardRepo;
    if (!repo) ctx.skip('HARD-01 未运行');
    const marker = path.join(ctx.fixture.root, 'fsmonitor-ran');
    const configFile = path.join(repo, '.git', 'config');
    const original = fs.readFileSync(configFile, 'utf8');
    // Written on disk directly: the terminal can do this (accepted), the file API cannot.
    fs.writeFileSync(configFile, `${original}\n[core]\n\tfsmonitor = touch ${marker}; false\n`);
    try {
      // Control: plain git does run the configured command, so the check below means something.
      try { execFileSync('git', ['status'], { cwd: repo, env: gitEnv(ctx), stdio: 'ignore' }); } catch { /* the hook exits non-zero */ }
      assert.ok(fs.existsSync(marker), 'control: git alone runs the configured fsmonitor');
      fs.rmSync(marker);
      const status = await ctx.c.api('GET', `/api/git/status?project=${ctx.state.hardId}`);
      assert.equal(status.status, 200, status.text.slice(0, 120));
      assert.ok(!fs.existsSync(marker), 'the member process must not run it');
    } finally {
      fs.writeFileSync(configFile, original);
      fs.rmSync(marker, { force: true });
    }
  }],

  ['HARD-03', 'Taskmaster 文档名不能带路径，合法文档名仍可用', async (ctx) => {
    const id = ctx.state.hardId;
    if (!id) ctx.skip('HARD-01 未运行');
    const outside = path.join(ctx.roots.projB, 'app2', 'CLAUDE.md');
    const before = fs.readFileSync(outside, 'utf8');
    const climb = '..%2f..%2f..%2f..%2fprojB%2fapp2%2fCLAUDE.md';
    const read = await ctx.c.api('GET', `/api/taskmaster/prd/${id}/${climb}`);
    assert.equal(read.status, 400, read.text.slice(0, 120));
    assert.ok(!read.text.includes('SECRET-B'));
    for (const [method, url, body] of [
      ['POST', `/api/taskmaster/apply-template/${id}`, { templateId: 'web-app', fileName: '../../../../projB/app2/CLAUDE.md' }],
      ['POST', `/api/taskmaster/parse-prd/${id}`, { fileName: '../../../../projB/app2/CLAUDE.md' }],
    ]) {
      const response = await ctx.c.api(method, url, body);
      assert.equal(response.status, 400, `${url}: ${response.status} ${response.text.slice(0, 120)}`);
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), before, "projB's file untouched");
    const saved = await ctx.c.api('POST', `/api/taskmaster/prd/${id}`, { fileName: 'plan.md', content: '# plan' });
    assert.ok(saved.status < 300, saved.text.slice(0, 120));
    const back = await ctx.c.api('GET', `/api/taskmaster/prd/${id}/plan.md`);
    assert.equal(back.status, 200, back.text.slice(0, 120));
    assert.match(back.text, /# plan/);
  }],

  ['HARD-04', '克隆只接受远程地址：本机路径和 file:// 被拒绝，管理员不受限', async (ctx) => {
    const source = path.join(ctx.fixture.root, 'some-local-repo');
    fs.mkdirSync(source, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: source, env: gitEnv(ctx) });
    fs.writeFileSync(path.join(source, 'LOCAL-SECRET.txt'), 'local secret');
    execFileSync('git', ['add', '.'], { cwd: source, env: gitEnv(ctx) });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: source, env: gitEnv(ctx) });
    for (const githubUrl of [source, `file://${source}`, '../some-local-repo', 'https://example.invalid/r.git\n/etc', 'https://example.invalid/r .git']) {
      const stream = await runClone(ctx.c, githubUrl, ctx.roots.projC);
      assert.match(stream, /Only remote repository URLs/, `${githubUrl}: ${stream.slice(0, 200)}`);
      assert.doesNotMatch(stream, /LOCAL-SECRET/);
    }
    assert.ok(!fs.existsSync(path.join(ctx.roots.projC, 'some-local-repo')), 'nothing was cloned');
    assert.deepEqual(fs.readdirSync(ctx.roots.projC).filter((name) => name.includes('local')), []);
    // Admin keeps upstream behaviour: the same source is not refused for being local.
    const adminStream = await runClone(ctx.admin, source, path.join(ctx.fixture.home, 'admin-clone-target'));
    assert.doesNotMatch(adminStream, /Only remote repository URLs/, adminStream.slice(0, 200));
  }],

  ['HARD-05', '/tmp 只读范围收窄：不能列出或读取其他文件，只能读本账号的 Claude 任务输出', async (ctx) => {
    const tmp = fs.realpathSync(os.tmpdir());
    const foreign = path.join(tmp, `gw-check-${process.pid}.txt`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const taskRoot = path.join(tmp, `claude-${uid}`);
    const createdTaskRoot = !fs.existsSync(taskRoot);
    const own = path.join(taskRoot, encode(ctx.roots.projC), 'tasks');
    const other = path.join(taskRoot, encode(ctx.roots.projB), 'tasks');
    fs.writeFileSync(foreign, 'FOREIGN-TMP-SECRET');
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(own, 'a.output'), 'OWN-TASK-OUTPUT');
    fs.writeFileSync(path.join(other, 'b.output'), 'OTHER-TASK-OUTPUT');
    try {
      const id = await projectIdFor(ctx.c, ctx.state.hardRepo);
      const read = (file) => ctx.c.api('GET', `/api/file-tree/projects/${id}/files/content?path=${encodeURIComponent(file)}`);
      assert.equal((await ctx.c.api('GET', `/api/file-tree/browse-filesystem?path=${encodeURIComponent(tmp)}`)).status, 403, 'the temp directory cannot be listed');
      for (const file of [foreign, path.join(other, 'b.output')]) {
        const response = await read(file);
        assert.notEqual(response.status, 200, file);
        assert.ok(!/FOREIGN-TMP-SECRET|OTHER-TASK-OUTPUT/.test(response.text), `${file} leaked`);
      }
      const mine = await read(path.join(own, 'a.output'));
      assert.equal(mine.status, 200, mine.text.slice(0, 120));
      assert.match(mine.text, /OWN-TASK-OUTPUT/);
      const admin = await ctx.admin.api('GET', `/api/file-tree/browse-filesystem?path=${encodeURIComponent(tmp)}`);
      assert.equal(admin.status, 200, 'admin keeps upstream behaviour');
    } finally {
      fs.rmSync(foreign, { force: true });
      fs.rmSync(path.join(taskRoot, encode(ctx.roots.projC)), { recursive: true, force: true });
      fs.rmSync(path.join(taskRoot, encode(ctx.roots.projB)), { recursive: true, force: true });
      if (createdTaskRoot) fs.rmSync(taskRoot, { recursive: true, force: true });
    }
  }],

  ['HARD-06', 'MCP、Skills 没有指定目录时落在本账号目录，而不是共用的安装目录', async (ctx) => {
    const shared = path.join(APP_ROOT, '.mcp.json');
    const sharedBefore = fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : null;
    const added = await ctx.c.api('POST', '/api/providers/claude/mcp/servers', { name: 'no-workspace-given', scope: 'project', transport: 'stdio', command: 'echo' });
    assert.equal(added.status, 201, added.text.slice(0, 160));
    assert.match(fs.readFileSync(path.join(ctx.roots.projC, '.mcp.json'), 'utf8'), /no-workspace-given/, "written to this account's workspace");
    assert.equal(fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : null, sharedBefore, 'the shared install directory is untouched');
    const removed = await ctx.c.api('DELETE', '/api/providers/claude/mcp/servers/no-workspace-given?scope=project');
    assert.ok(removed.status < 300, removed.text.slice(0, 120));
    assert.equal((await ctx.c.api('GET', '/api/providers/claude/skills')).status, 200);
  }],
];

