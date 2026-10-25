// Plan B checks (mydocs/06 POL-*): members cannot change configuration that
// every account shares; admin still can; ordinary features keep working.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { checkMemberRequest } from '../../proxy/member-policy.mjs';

const claudeJson = (ctx) => path.join(ctx.fixture.home, '.claude.json');
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const skillsDir = (ctx) => path.join(ctx.fixture.home, '.claude', 'skills');
const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

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
];
