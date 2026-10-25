import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { APP_ROOT } from '../../config.mjs';
import { LATEST_SCHEMA } from '../../store/migrations.mjs';
import { Client } from '../harness.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'user.name=check', '-c', 'user.email=check@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'branch', branch);
}

export const worktreeScenarios = [
  ['API-07', 'worktree 落到账号目录外时被拒绝，且不会在目录外创建任何东西', async (ctx) => {
    try {
      execFileSync('git', ['--version']);
    } catch {
      ctx.skip('未安装 git');
    }
    const root = path.join(ctx.fixture.w, 'projW');
    assert.equal((await ctx.admin.post('/__gw/api/accounts', { username: 'projW', password: 'passW1', workspaceRoot: root })).status, 201);
    initRepo(root, 'feat-x');
    initRepo(path.join(root, 'app'), 'feat-y');
    const client = new Client(ctx.gw);
    await client.login('projW', 'passW1');
    await client.openApp();
    ctx.state.w = client;
    const created = await client.api('POST', '/api/projects/create-project', { path: root });
    assert.ok(created.status < 300, created.text);
    const projectId = (await client.api('GET', '/api/projects')).body.find((project) => project.fullPath === root).projectId;
    const response = await client.api('POST', '/api/worktrees/create', { project: projectId, branch: 'feat-x' });
    assert.ok(response.status >= 400, `${response.status} ${response.text.slice(0, 160)}`);
    const outside = path.join(ctx.fixture.w, 'projW-worktrees', 'feat-x');
    const paths = (await client.api('GET', '/api/projects')).body.map((project) => project.fullPath);
    assert.ok(!paths.includes(outside), 'the outside worktree is not registered');
    // Refused before git creates anything outside the workspace.
    assert.ok(!fs.existsSync(outside), 'no worktree directory was created');
    assert.ok(!fs.existsSync(path.dirname(outside)), 'no leftover container directory outside the workspace');
  }],

  ['API-07b', '子目录中的仓库可以正常使用 worktree', async (ctx) => {
    const client = ctx.state.w;
    if (!client) ctx.skip('API-07 未运行');
    const repo = path.join(ctx.fixture.w, 'projW', 'app');
    await client.api('POST', '/api/projects/create-project', { path: repo });
    const projectId = (await client.api('GET', '/api/projects')).body.find((project) => project.fullPath === repo).projectId;
    const response = await client.api('POST', '/api/worktrees/create', { project: projectId, branch: 'feat-y' });
    assert.ok(response.status < 300, `${response.status} ${response.text.slice(0, 200)}`);
    const worktree = path.join(ctx.fixture.w, 'projW', 'app-worktrees', 'feat-y');
    assert.ok(fs.existsSync(worktree));
    assert.ok((await client.api('GET', '/api/projects')).body.some((project) => project.fullPath === worktree));
    assert.equal((await ctx.admin.del('/__gw/api/accounts/projW')).status, 200);
  }],
];

// Upstream files that touch the home directory, reviewed for plan B (member
// policy). A new one may be a new way to write shared configuration: review it,
// extend gateway/proxy/member-policy.mjs if needed, then add it here.
const REVIEWED_HOME_FILES = [
  'server/index.ts',
  'server/load-env.ts',
  'server/modules/agent/agent.routes.ts',
  'server/modules/browser-use/browser-use.service.ts',
  'server/modules/cli/cli.module.ts',
  'server/modules/commands/commands.routes.ts',
  'server/modules/plugins/plugin-registry.service.ts',
  'server/modules/providers/list/claude/claude-auth.provider.ts',
  'server/modules/providers/list/claude/claude-mcp.provider.ts',
  'server/modules/providers/list/claude/claude-runtime.provider.js',
  'server/modules/providers/list/claude/claude-session-synchronizer.provider.ts',
  'server/modules/providers/list/claude/claude-skills.provider.ts',
  'server/modules/providers/list/codex/codex-auth.provider.ts',
  'server/modules/providers/list/codex/codex-mcp.provider.ts',
  'server/modules/providers/list/codex/codex-models.provider.ts',
  'server/modules/providers/list/codex/codex-session-synchronizer.provider.ts',
  'server/modules/providers/list/codex/codex-skills.provider.ts',
  'server/modules/providers/list/cursor/cursor-mcp.provider.ts',
  'server/modules/providers/list/cursor/cursor-models.provider.ts',
  'server/modules/providers/list/cursor/cursor-session-synchronizer.provider.ts',
  'server/modules/providers/list/cursor/cursor-sessions.provider.ts',
  'server/modules/providers/list/cursor/cursor-skills.provider.ts',
  'server/modules/providers/list/opencode/opencode-auth.provider.ts',
  'server/modules/providers/list/opencode/opencode-mcp.provider.ts',
  'server/modules/providers/list/opencode/opencode-models.provider.ts',
  'server/modules/providers/list/opencode/opencode-skills.provider.ts',
  'server/modules/providers/services/claude-cli-liveness.service.ts',
  'server/modules/providers/services/claude-settings-permissions.service.ts',
  'server/modules/providers/services/provider-token-usage.service.ts',
  'server/modules/providers/services/sessions-watcher.service.ts',
  'server/modules/system/system.module.ts',
  'server/modules/websocket/services/shell-websocket.service.ts',
  'server/shared/image-attachments.ts',
  'server/shared/isolation.ts',
  'server/shared/utils.ts',
];

// Upstream files that run git. Git executes commands named in repository
// config, hooks and attributes; members are protected by the file API refusing
// .git (HARD-01) and the fsmonitor override (HARD-02). A new file that runs git
// needs the same question asked before it is added here.
const REVIEWED_GIT_FILES = [
  'server/modules/agent/agent.routes.ts',
  'server/modules/git/git.routes.ts',
  'server/modules/plugins/plugin-registry.service.ts',
  'server/modules/projects/services/project-clone.service.ts',
  'server/modules/user/user.module.ts',
  'server/modules/worktrees/services/worktree-create.service.ts',
  'server/modules/worktrees/services/worktree-git.service.ts',
  'server/modules/worktrees/services/worktree-list.service.ts',
  'server/modules/worktrees/services/worktree-merge.service.ts',
  'server/modules/worktrees/services/worktree-remove.service.ts',
];

function walkServer(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : walkServer(full);
    return /\.(ts|js)$/.test(entry.name) ? [full] : [];
  });
}

export const staticScenarios = [
  ['UPG-12', '运行 git 的上游文件没有新增（仓库配置里的命令执行风险是否已覆盖）', async () => {
    const current = walkServer(path.join(APP_ROOT, 'server'))
      .filter((file) => /spawnAsync\('git'|runGit\(|spawn\('git'|execFile\('git'/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(APP_ROOT, file))
      .sort();
    const added = current.filter((file) => !REVIEWED_GIT_FILES.includes(file));
    assert.deepEqual(added, [], '以下上游文件新增了 git 调用，请复查隔离模式下是否安全，再加入已审核清单');
  }],

  ['UPG-11', '引用 home 目录的上游文件没有新增（全局写接口拦截清单是否需要更新）', async () => {
    const current = walkServer(path.join(APP_ROOT, 'server'))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('homedir()'))
      .map((file) => path.relative(APP_ROOT, file))
      .sort();
    const added = current.filter((file) => !REVIEWED_HOME_FILES.includes(file));
    assert.deepEqual(added, [], '以下上游文件新引用了 home 目录，请确认是否需要扩充 gateway/proxy/member-policy.mjs');
  }],

  ['PROC-12', '空闲判断只调用上游已有接口', async () => {
    const client = fs.readFileSync(path.join(APP_ROOT, 'gateway', 'proc', 'upstream-client.mjs'), 'utf8');
    const used = [...client.matchAll(/request\(port, '(GET|POST)', '([^']+)'/g)].map((match) => `${match[1]} ${match[2]}`).sort();
    assert.deepEqual(used, ['GET /api/auth/status', 'GET /api/providers/sessions/running', 'GET /api/scheduled-messages', 'POST /api/auth/login', 'POST /api/auth/register', 'POST /api/user/complete-onboarding']);
  }],

  ['UPG-06', '上游改动与 04 清单一致，且都引用 isolation.ts', async (ctx) => {
    let changed;
    try {
      const base = process.env.CLOUDCLI_MULTI_UPSTREAM_BASE || 'HEAD';
      const tracked = git(APP_ROOT, 'diff', '--name-only', base).split('\n');
      const untracked = git(APP_ROOT, 'ls-files', '--others', '--exclude-standard').split('\n');
      changed = [...new Set([...tracked, ...untracked])].filter((file) => file && !file.startsWith('gateway/') && !file.startsWith('mydocs/') && !/^(node_modules|dist|dist-server|database)(\/|$)/.test(file));
    } catch {
      ctx.skip('不是 git 仓库');
    }
    if (!changed.length) ctx.skip('工作区与基线相同（已提交时用 CLOUDCLI_MULTI_UPSTREAM_BASE 指定上游基线）');
    const doc = fs.readFileSync(path.join(APP_ROOT, 'mydocs', '04-上游文件改动清单.md'), 'utf8').split('## 2.')[0];
    for (const file of changed) {
      assert.ok(doc.includes(`\`${file}\``), `${file} 不在 04 清单第 1 节中`);
      if (file.startsWith('server/') && !file.includes('/tests/') && file !== 'server/shared/isolation.ts') {
        assert.match(fs.readFileSync(path.join(APP_ROOT, file), 'utf8'), /shared\/isolation\.js/, `${file} 没有引用 isolation`);
      }
    }
  }],

  ['API-05', '聊天 cwd 被篡改时使用会话目录（上游补丁单元测试）', async (ctx) => {
    const tsx = path.join(APP_ROOT, 'node_modules', '.bin', 'tsx');
    if (!fs.existsSync(tsx)) ctx.skip('未安装 tsx（开发依赖）');
    const result = spawnSync(tsx, ['--tsconfig', 'server/tsconfig.json', '--test', 'server/modules/websocket/tests/chat-isolation.test.ts', 'server/shared/tests/isolation.test.ts'], { cwd: APP_ROOT, encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output.split('\n').filter((line) => /not ok|Error/.test(line)).join('\n'));
    assert.match(output, /# fail 0/);
  }],
];

export const dataScenarios = [
  ['UPG-02', '数据只写入指定的数据根目录', async (ctx) => {
    for (const name of ['gateway.db', 'secret.key', 'meta.json', path.join('accounts', 'projA', 'auth.db')]) {
      assert.ok(fs.existsSync(path.join(ctx.fixture.dataRoot, name)), name);
    }
    for (const name of ['gateway.db', 'secret.key', 'meta.json', 'accounts']) assert.ok(!fs.existsSync(path.join(APP_ROOT, name)), `安装目录中出现了 ${name}`);
    assert.equal(fs.statSync(ctx.fixture.dataRoot).mode & 0o777, 0o700);
    for (const name of ['gateway.db', 'secret.key', 'meta.json']) assert.equal(fs.statSync(path.join(ctx.fixture.dataRoot, name)).mode & 0o777, 0o600, name);
  }],

  ['UPG-03', '账号库结构是最新版本', async (ctx) => {
    const meta = JSON.parse(fs.readFileSync(path.join(ctx.fixture.dataRoot, 'meta.json'), 'utf8'));
    assert.equal(meta.schema, LATEST_SCHEMA);
    const db = new Database(path.join(ctx.fixture.dataRoot, 'gateway.db'), { readonly: true });
    try {
      assert.equal(db.pragma('user_version', { simple: true }), LATEST_SCHEMA);
    } finally {
      db.close();
    }
  }],
];

/** UPG-09: snapshot of a real data root, to prove the checks never touch it. */
export function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name);
    return entry.isDirectory() ? walk(full) : [`${path.relative(dir, full)}:${fs.statSync(full).mtimeMs}`];
  });
  return walk(dir).sort().join('\n');
}
