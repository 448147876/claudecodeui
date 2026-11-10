// Plan B checks (mydocs/06 POL-*): members cannot change configuration that
// every account shares; admin still can; ordinary features keep working.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { APP_ROOT } from '../../config.mjs';
import { ADMIN_ONLY_PLUGINS, checkMemberRequest, isAdminOnlyPluginPath } from '../../proxy/member-policy.mjs';

const claudeJson = (ctx) => path.join(ctx.fixture.home, '.claude.json');
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const skillsDir = (ctx) => path.join(ctx.fixture.home, '.claude', 'skills');
const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

/** Writes a minimal tab plugin (manifest + entry, no server) into the shared plugin directory. */
function writePlugin(ctx, name) {
  const dir = path.join(ctx.fixture.home, '.claude-code-ui', 'plugins', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name, displayName: name, entry: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function mount() {}\n');
  return dir;
}

function assertForbidden(response, label) {
  assert.equal(response.status, 403, `${label}: ${response.status} ${response.text.slice(0, 120)}`);
  assert.equal(response.body?.error?.code, 'GATEWAY_MEMBER_FORBIDDEN', label);
  assert.match(response.body.error.message, /普通账号不能修改全局配置/);
}

export const policyScenarios = [
  ['POL-01', '普通账号调用全局写接口被拒绝，且没有写入任何文件', async (ctx) => {
    const before = { claude: readText(claudeJson(ctx)), skills: listDir(skillsDir(ctx)), git: readText(path.join(ctx.fixture.home, '.gitconfig')) };
    const cases = [
      ['POST', '/api/providers/claude/mcp/servers', { name: 'm-user', scope: 'user', transport: 'stdio', command: 'echo' }],
      ['POST', '/api/providers/mcp/servers/global', { name: 'm-global', scope: 'user', transport: 'stdio', command: 'echo' }],
      ['DELETE', '/api/providers/claude/mcp/servers/anything?scope=user'],
      ['POST', '/api/providers/claude/skills', { content: '---\nname: m-skill\ndescription: x\n---\nx' }],
      ['DELETE', '/api/providers/claude/skills/x'],
      ['POST', '/api/plugins/install', { url: 'https://example.invalid/plugin.git' }],
      ['PUT', '/api/plugins/some-plugin/enable', { enabled: true }],
      ['POST', '/api/plugins/some-plugin/update'],
      ['DELETE', '/api/plugins/some-plugin'],
      ['PUT', '/api/browser-use/settings', { enabled: true }],
      ['POST', '/api/browser-use/runtime/install'],
      ['POST', '/api/user/git-config', { gitName: 'hacker', gitEmail: 'h@example.invalid' }],
    ];
    for (const [method, url, body] of cases) assertForbidden(await ctx.a.api(method, url, body), `${method} ${url}`);
    assert.equal(readText(claudeJson(ctx)), before.claude, '~/.claude.json unchanged');
    assert.deepEqual(listDir(skillsDir(ctx)), before.skills, '~/.claude/skills unchanged');
    assert.equal(readText(path.join(ctx.fixture.home, '.gitconfig')), before.git, '~/.gitconfig unchanged');
  }],

  ['POL-02', '绕过写法同样被拒绝（大小写、斜杠、编码、重复参数）', async (ctx) => {
    // System update has real side effects if it ever got through, so it is
    // checked on the policy function itself; the HTTP cases below use endpoints
    // that are harmless when unblocked (removing a skill that does not exist).
    for (const url of ['/api/system/update', '/API/System/Update', '/api/system/update/', '//api//system//update', '/api/%73ystem/update', '/api/system/update?x=1']) {
      const denied = checkMemberRequest({ method: 'POST', url }, null);
      assert.equal(denied?.status, 403, `POST ${url} must be refused`);
      assert.equal(denied.body.error.code, 'GATEWAY_MEMBER_FORBIDDEN');
    }
    assert.equal(checkMemberRequest({ method: 'GET', url: '/api/system/update' }, null), null, 'only the POST is refused');
    const cases = [
      ['DELETE', '/API/Providers/Claude/Skills/no-such-skill'],
      ['DELETE', '/api/providers/claude/skills/no-such-skill/'],
      ['DELETE', '//api//providers//claude//skills//no-such-skill'],
      ['DELETE', '/api/providers/claude/%73kills/no-such-skill'],
      ['POST', '/api/Providers/Claude/Skills/', { content: '---\nname: m2\ndescription: x\n---\nx' }],
      ['DELETE', '/api/providers/claude/mcp/servers/x?scope=project&scope=user'],
      ['DELETE', '/api/providers/claude/mcp/servers/x?scope=USER'],
      ['POST', '/api/providers/claude/mcp/servers/', { name: 'm3', scope: 'user', transport: 'stdio', command: 'echo' }],
    ];
    for (const [method, url, body] of cases) assertForbidden(await ctx.a.api(method, url, body), `${method} ${url}`);
  }],

  ['POL-03', '普通账号的正常功能不受影响', async (ctx) => {
    const own = path.join(ctx.fixture.projA, 'app1');
    const project = await ctx.a.api('POST', '/api/providers/claude/mcp/servers', { name: 'pol-project', scope: 'project', transport: 'stdio', command: 'echo', workspacePath: own });
    assert.equal(project.status, 201, project.text);
    const local = await ctx.a.api('POST', '/api/providers/claude/mcp/servers', { name: 'pol-local', scope: 'local', transport: 'stdio', command: 'echo', workspacePath: own });
    assert.equal(local.status, 201, local.text);
    const removed = await ctx.a.api('DELETE', `/api/providers/claude/mcp/servers/pol-project?scope=project&workspacePath=${encodeURIComponent(own)}`);
    assert.ok(removed.status < 300, removed.text);
    for (const url of ['/api/providers/claude/mcp/servers', '/api/providers/claude/skills', '/api/plugins', '/api/user/git-config', '/api/browser-use/settings']) {
      const response = await ctx.a.api('GET', url);
      assert.ok(response.status !== 403, `${url} should stay readable: ${response.status}`);
    }
  }],

  ['POL-04', '管理员仍可修改全局配置', async (ctx) => {
    const mcp = await ctx.admin.api('POST', '/api/providers/claude/mcp/servers', { name: 'admin-user-mcp', scope: 'user', transport: 'stdio', command: 'echo' });
    assert.equal(mcp.status, 201, mcp.text);
    assert.match(readText(claudeJson(ctx)), /admin-user-mcp/);
    const skill = await ctx.admin.api('POST', '/api/providers/claude/skills', { content: '---\nname: admin-skill\ndescription: x\n---\nx' });
    assert.ok(skill.status < 300, skill.text);
    const git = await ctx.admin.api('POST', '/api/user/git-config', { gitName: 'admin', gitEmail: 'admin@example.invalid' });
    assert.ok(git.status < 300, git.text);
    assert.match(readText(path.join(ctx.fixture.home, '.gitconfig')), /admin@example\.invalid/);
    // A member still sees what admin configured globally. A Claude CLI that is
    // still running rewrites ~/.claude.json and can drop this entry (T-7);
    // FUN-07 waits for its run to end, the retry is a last safety margin.
    let seen = '';
    for (let attempt = 0; attempt < 10 && !seen.includes('admin-user-mcp'); attempt += 1) {
      seen = (await ctx.a.api('GET', '/api/providers/claude/mcp/servers')).text;
      if (!seen.includes('admin-user-mcp')) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.match(seen, /admin-user-mcp/, `member list: ${seen}\n~/.claude.json: ${readText(claudeJson(ctx)).slice(0, 400)}`);
  }],

  ['POL-05', '普通账号首次进入时跳过引导（不需要设置全局 git）', async (ctx) => {
    const member = await ctx.a.api('GET', '/api/user/onboarding-status');
    assert.equal(member.status, 200, member.text);
    assert.match(member.text, /"hasCompletedOnboarding":\s*true/);
    const admin = await ctx.admin.api('GET', '/api/user/onboarding-status');
    assert.equal(admin.status, 200);
  }],

  ['POL-06', '仅管理员可见的插件：普通账号的列表里没有，接口和 WebSocket 被拒绝；管理员不受影响', async (ctx) => {
    const dirs = [writePlugin(ctx, 'agent-monitor'), writePlugin(ctx, 'pol-visible')];
    try {
      const names = async (client) => {
        const response = await client.api('GET', '/api/plugins');
        assert.equal(response.status, 200, response.text);
        return response.body.plugins.map((plugin) => plugin.name);
      };
      const memberNames = await names(ctx.a);
      assert.ok(!memberNames.includes('agent-monitor'), `member list: ${memberNames}`);
      assert.ok(memberNames.includes('pol-visible'), 'other plugins stay listed');
      assert.ok((await names(ctx.admin)).includes('agent-monitor'), 'admin sees the full list');
      // Same browser after admin: its cached ETag must not turn into a 304 that reuses admin's list.
      const adminList = await ctx.admin.api('GET', '/api/plugins');
      const etag = adminList.headers.get('etag');
      assert.ok(etag, 'upstream sends an ETag, so the revalidation case is real');
      const revalidated = await ctx.a.request('GET', '/api/plugins', { headers: { authorization: `Bearer ${ctx.a.bootstrap.token}`, 'if-none-match': etag } });
      assert.equal(revalidated.status, 200, 'member never gets a 304 for a filtered response');
      assert.ok(!revalidated.body.plugins.some((plugin) => plugin.name === 'agent-monitor'));

      const denied = [
        ['GET', '/api/plugins/agent-monitor/manifest'],
        ['GET', '/api/plugins/agent-monitor/assets/index.js'],
        ['POST', '/api/plugins/agent-monitor/rpc/processes'],
        ['GET', '/api/plugins/Agent-Monitor/manifest'],
        ['GET', '//api//plugins/agent%2Dmonitor/manifest/'],
      ];
      for (const [method, url] of denied) {
        const response = await ctx.a.api(method, url);
        assert.equal(response.status, 403, `${method} ${url}: ${response.status} ${response.text.slice(0, 120)}`);
        assert.equal(response.body?.error?.message, '该插件仅管理员可用。', `${method} ${url}`);
      }
      assert.equal((await ctx.a.api('GET', '/api/plugins/pol-visible/manifest')).status, 200, 'other plugins stay usable');
      assert.equal((await ctx.admin.api('GET', '/api/plugins/agent-monitor/manifest')).status, 200, 'admin can still open it');

      const memberWs = await ctx.a.websocket(`/plugin-ws/agent-monitor?token=${encodeURIComponent(ctx.a.bootstrap.token)}`);
      assert.equal(memberWs.status, 403, 'member plugin WebSocket is refused');
      const adminWs = await ctx.admin.websocket(`/plugin-ws/agent-monitor?token=${encodeURIComponent(ctx.admin.bootstrap.token)}`);
      assert.ok(adminWs.ok, `admin plugin WebSocket reaches upstream: ${adminWs.status ?? adminWs.error?.message}`);
      adminWs.socket.close();

      assert.deepEqual(ctx.a.bootstrap.hiddenPlugins, ADMIN_ONLY_PLUGINS, 'member page gets the list for inject.js');
      assert.equal(ctx.admin.bootstrap.hiddenPlugins, undefined, 'admin page does not');
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  }],

  ['POL-07', '仅管理员可见的插件：名单完整，依赖的上游界面结构仍然存在（变化时需同步修改 inject.js 第 5 段）', async () => {
    assert.deepEqual(ADMIN_ONLY_PLUGINS.map((plugin) => plugin.name).sort(), ['agent-monitor', 'session-manager', 'task-queue', 'token-cost-calculator']);
    for (const name of ['agent-monitor', 'session-manager', 'task-queue', 'token-cost-calculator']) {
      assert.ok(isAdminOnlyPluginPath(`/plugin-ws/${name}`), `/plugin-ws/${name}`);
      assert.ok(checkMemberRequest({ method: 'GET', url: `/api/plugins/${name}/manifest` }), name);
    }
    for (const url of ['/api/plugins', '/api/plugins/install', '/api/plugins/claude-usage/rpc/history', '/plugin-ws/claude-usage', '/api/plugins/agent-monitor-x/manifest']) {
      assert.equal(isAdminOnlyPluginPath(url), false, url);
    }
    const settingsTab = fs.readFileSync(path.join(APP_ROOT, 'src', 'modules', 'plugins', 'PluginSettingsTab.tsx'), 'utf8');
    const card = /function PluginRecommendationCard[\s\S]*?\n}\n/.exec(settingsTab)?.[0] ?? '';
    assert.match(card, /<div className=\{`[^`]*\bborder-dashed\b/, 'recommendation card root is the dashed div');
    assert.match(card, /href=\{recommendation\.repoUrl\}/, 'recommendation card links its repo');
    for (const plugin of ADMIN_ONLY_PLUGINS) {
      assert.ok(settingsTab.includes(`'${plugin.repoUrl}'`), `recommendation URL unchanged: ${plugin.repoUrl}`);
    }
    assert.match(fs.readFileSync(path.join(APP_ROOT, 'src', 'modules', 'project-workspace', 'hooks', 'useProjectsState.ts'), 'utf8'), /localStorage\.getItem\('activeTab'\)/, 'persisted tab key');
  }],
];
