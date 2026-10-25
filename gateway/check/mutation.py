#!/usr/bin/env python3
"""Mutation testing for the isolation patches and the gateway.

Removes one protection at a time in a throwaway copy of the repository, runs
`cloudcli-multi check --dev` there, and reports which scenarios failed. A
mutation that leaves every scenario green means the checks cannot see that
protection being removed.

Usage (Node >= 22 on PATH):  python3 gateway/check/mutation.py [BASE] [M01 M02 ...]
Needs about 75 seconds per mutation. The copy lives in gateway/.check-mutation/
(git-ignored) and shares node_modules with the real repository.
"""
import json, os, re, shutil, subprocess, sys, tarfile, time

APP_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(APP_ROOT, 'gateway', '.check-mutation')
REPO = os.path.join(WORK, 'repo')

MUTATIONS = [
    ('M01', '会话入库不再过滤', 'server/modules/database/repositories/sessions.db.ts',
     "    if (!isRecordedPathAllowed(projectPath)) return '';\n", ''),
    ('M02', '项目登记不再校验目录', 'server/modules/database/repositories/projects.db.ts',
     "        assertRequestedPathAllowed(projectPath);\n", ''),
    ('M03', '只读目录不再收窄', 'server/modules/file-tree/file-tree.module.ts',
     'return isReadOnlyPathAllowed(resolved) ? resolved : null;', 'return resolved;'),
    ('M04', '聊天 cwd 不再校验', 'server/modules/websocket/services/chat-websocket.service.ts',
     'cwd: (isRequestedPathAllowed(clientOptions.cwd) ? clientOptions.cwd : undefined) ?? session.project_path ?? undefined,',
     'cwd: clientOptions.cwd ?? session.project_path ?? undefined,'),
    ('M05', '斜杠命令不再校验', 'server/modules/commands/commands.routes.ts',
     'if (projectPath && !isRequestedPathAllowed(projectPath)) {', 'if (false) {'),
    ('M06', 'Agent API 不再校验', 'server/modules/agent/agent.routes.ts',
     'if (projectPath && !isRequestedPathAllowed(projectPath)) {', 'if (false) {'),
    ('M07', 'MCP workspacePath 不再校验', 'server/modules/providers/shared/mcp/mcp.provider.ts',
     '  if (workspacePath) assertRequestedPathAllowed(workspacePath);\n', ''),
    ('M08', 'Skills workspacePath 不再校验', 'server/modules/providers/shared/skills/skills.provider.ts',
     '  if (workspacePath) assertRequestedPathAllowed(workspacePath);\n', ''),
    ('M09', '方案 B 拦截整体失效', 'gateway/proxy/member-policy.mjs',
     'export function checkMemberRequest(req, body = null) {\n', 'export function checkMemberRequest(req, body = null) {\n  return null;\n'),
    ('M10', '方案 B 路径不再转小写', 'gateway/proxy/member-policy.mjs',
     ".replace(/\\/{2,}/g, '/').toLowerCase();", ".replace(/\\/{2,}/g, '/');"),
    ('M11', '切换账号不再清空本地数据', 'gateway/public/static/inject.js',
     "if (storage.getItem('gw-account') !== gw.account) storage.clear();", ''),
    ('M12', '上游登录接口不再拦截', 'gateway/proxy/http.mjs',
     "  ['POST', '/api/auth/login'],\n", ''),
    ('M13', '重置密码后旧 Cookie 仍有效', 'gateway/auth/session.mjs',
     'account && account.password_version === claims.pv ? account : null', 'account ?? null'),
    ('M14', '普通账号子进程不设隔离开关', 'gateway/proc/manager.mjs',
     "      env.CLOUDCLI_ISOLATION_ROOT = account.workspace_root;\n", ''),
    ('M15', '工作目录不再检查编码前缀', 'gateway/admin/workspace-rules.mjs',
     "if (encoded === otherEncoded || encoded.startsWith(`${otherEncoded}-`) || otherEncoded.startsWith(`${encoded}-`)) {", 'if (false) {'),
    ('M16', '文件接口不再拦截 .git 内部', 'server/modules/file-tree/file-tree.service.ts',
     "  assertProjectFilePathAllowed(projectRoot, resolvedPath);\n", ''),
    ('M17', '成员进程不再禁用仓库配置的 fsmonitor', 'gateway/proc/manager.mjs',
     "      env.GIT_CONFIG_COUNT = String(count + 1);\n      env[`GIT_CONFIG_KEY_${count}`] = 'core.fsmonitor';\n      env[`GIT_CONFIG_VALUE_${count}`] = 'false';\n", ''),
    ('M18', 'Taskmaster 文档名不再检查', 'server/shared/isolation.ts',
     "export function isPlainFileName(name: unknown): boolean {\n", "export function isPlainFileName(name: unknown): boolean {\n  return true;\n"),
    ('M19', '克隆不再限制来源', 'server/shared/isolation.ts',
     "export function isAllowedCloneSource(source: string): boolean {\n", "export function isAllowedCloneSource(source: string): boolean {\n  return true;\n"),
    ('M20', '/tmp 不再收窄', 'server/shared/isolation.ts',
     "  for (const tmpRoot of new Set(['/tmp', os.tmpdir()].map(resolveRealPath))) {", "  for (const tmpRoot of new Set<string>()) {"),
    ('M22', '文件接口不再解析符号链接', 'server/shared/isolation.ts',
     "  const realPath = resolveExistingPrefix(resolvedPath);", "  const realPath = normalizeProjectPath(path.resolve(resolvedPath));"),
    ('M23', 'worktree 创建前不再校验目录', 'server/modules/worktrees/services/worktree-create.service.ts',
     "  assertRequestedPathAllowed(worktreePath);\n", ''),
    ('M24', '命令文件不再解析符号链接', 'server/modules/commands/commands.routes.ts',
     "      if (!isCommandFileAllowed(commandPath)) {", "      if (false) {"),
    ('M25', 'git 文件参数不再校验工作区', 'server/modules/git/git.routes.ts',
     "    if (!isRequestedPathAllowed(path.resolve(repositoryRootPath, candidateFilePath))) {", "    if (false) {"),
    ('M26', 'Taskmaster 文档读取不再解析符号链接', 'server/modules/taskmaster/taskmaster.routes.ts',
     "            if (!isRequestedPathAllowed(filePath)) {", "            if (false) {"),
    ('M27', 'Taskmaster 任务文件读取不再解析符号链接', 'server/modules/taskmaster/taskmaster.routes.ts',
     "            if (!isRequestedPathAllowed(tasksFilePath)) {", "            if (false) {"),
    ('M21', 'MCP/Skills 默认目录回到安装目录', 'server/shared/isolation.ts',
     "  return getIsolationRoot() ?? process.cwd();", "  return process.cwd();"),
]

def kill_strays():
    """Stops servers left behind by an interrupted run (they would otherwise pile up)."""
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            if os.readlink(f'/proc/{entry}/cwd').startswith(REPO):
                os.kill(int(entry), 9)
        except OSError:
            pass


def run_check():
    proc = subprocess.run(['node', 'gateway/bin.mjs', 'check', '--dev'], cwd=REPO,
                          capture_output=True, text=True, timeout=1800)
    out = proc.stdout + proc.stderr
    kill_strays()
    failed = re.findall(r'^  ✘ ([A-Z]+-\d+b?|HARNESS)', out, re.M)
    summary = re.search(r'结果：通过 (\d+)，失败 (\d+)，跳过 (\d+)', out)
    if not summary:
        raise RuntimeError('检查没有正常结束（没有汇总行）：' + out[-300:])
    return sorted(set(failed)), summary.group(0)


def prepare_copy():
    shutil.rmtree(REPO, ignore_errors=True)
    os.makedirs(REPO)
    skip = ('.git', 'node_modules', 'database', os.path.join('gateway', '.check-mutation'), os.path.join('gateway', '.check-shots'))
    for root, dirs, files in os.walk(APP_ROOT):
        rel = os.path.relpath(root, APP_ROOT)
        dirs[:] = [d for d in dirs if os.path.normpath(os.path.join(rel, d)) not in skip and not d.startswith('.check-run-')]
        for f in files:
            target = os.path.join(REPO, rel, f)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(os.path.join(root, f), target)
    os.symlink(os.path.join(APP_ROOT, 'node_modules'), os.path.join(REPO, 'node_modules'))


def main():
    only = set(sys.argv[1:])
    prepare_copy()
    results = []
    if not only or 'BASE' in only:
        start = time.time()
        failed, summary = run_check()
        results.append({'id': 'BASE', 'title': '不做变异（基线）', 'failed': failed, 'summary': summary, 'seconds': round(time.time() - start)})
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    for mid, title, rel, old, new in MUTATIONS:
        if only and mid not in only:
            continue
        path = os.path.join(REPO, rel)
        original = open(path, encoding='utf-8').read()
        if original.count(old) != 1:
            results.append({'id': mid, 'title': title, 'error': f'anchor found {original.count(old)} times'})
            print(json.dumps(results[-1], ensure_ascii=False), flush=True)
            continue
        open(path, 'w', encoding='utf-8').write(original.replace(old, new))
        start = time.time()
        try:
            failed, summary = run_check()
        finally:
            open(path, 'w', encoding='utf-8').write(original)
        results.append({'id': mid, 'title': title, 'file': rel, 'failed': failed, 'summary': summary, 'seconds': round(time.time() - start)})
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    json.dump(results, open(os.path.join(WORK, 'results.json'), 'w'), ensure_ascii=False, indent=1)
    undetected = [r['id'] for r in results if r['id'] != 'BASE' and not r.get('failed') and not r.get('error')]
    print('未被发现的变异：', undetected or '无', flush=True)
    return 1 if undetected or any(r.get('error') for r in results) else 0


if __name__ == '__main__':
    sys.exit(main())
