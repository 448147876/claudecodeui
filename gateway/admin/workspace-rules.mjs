import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude's on-disk project directory naming (mirrors server/shared/isolation.ts).
export const encodeClaudeProjectDirName = (projectPath) => projectPath.replace(/[^a-zA-Z0-9]/g, '-');

const isUnder = (root, candidate) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

let forbiddenPaths = null;
async function upstreamForbiddenPaths(appRoot) {
  if (!forbiddenPaths) {
    // Reuse upstream's list (rule 1). A missing build fails loudly (mydocs/03 T-5).
    const utils = await import(path.join(appRoot, 'dist-server', 'server', 'shared', 'utils.js'));
    forbiddenPaths = utils.FORBIDDEN_WORKSPACE_PATHS.filter((entry) => entry.startsWith('/'));
  }
  return forbiddenPaths;
}

export class WorkspaceRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceRuleError';
  }
}

/**
 * Validates a member workspace (mydocs/01 FR-1 rules 1–5) and creates it.
 * Returns `{ root, warnings }` with `root` resolved through symlinks.
 */
export async function prepareWorkspaceRoot(input, { appRoot, dataRoot, home = os.homedir(), others }) {
  if (typeof input !== 'string' || !input.trim()) throw new WorkspaceRuleError('工作目录不能为空');
  const requested = input.trim();
  if (!path.isAbsolute(requested)) throw new WorkspaceRuleError('工作目录必须是绝对路径');

  const lexical = path.resolve(requested);
  const forbidden = await upstreamForbiddenPaths(appRoot);
  const check = (candidate) => {
    if (candidate === '/' || forbidden.some((entry) => entry !== '/' && isUnder(entry, candidate))) {
      throw new WorkspaceRuleError(`不能使用系统目录：${candidate}`);
    }
    if (candidate === home || isUnder(candidate, home)) throw new WorkspaceRuleError('不能使用 home 目录本身或它的上级目录');
    for (const dataDir of [path.join(home, '.claude'), path.join(home, '.cloudcli'), dataRoot]) {
      if (isUnder(dataDir, candidate) || isUnder(candidate, dataDir)) throw new WorkspaceRuleError(`不能使用数据目录：${dataDir}`);
    }
  };
  const checkOthers = (candidate) => {
    const encoded = encodeClaudeProjectDirName(candidate);
    for (const other of others) {
      if (isUnder(other.workspace_root, candidate) || isUnder(candidate, other.workspace_root)) {
        throw new WorkspaceRuleError(`与账号 ${other.username} 的工作目录相互包含（${other.workspace_root}）`);
      }
      const otherEncoded = encodeClaudeProjectDirName(other.workspace_root);
      if (encoded === otherEncoded || encoded.startsWith(`${otherEncoded}-`) || otherEncoded.startsWith(`${encoded}-`)) {
        throw new WorkspaceRuleError(`与账号 ${other.username} 的工作目录编码后互为前缀（${other.workspace_root}）`);
      }
    }
  };

  // Check before creating anything, then again once symlinks are resolved.
  check(lexical);
  checkOthers(lexical);
  fs.mkdirSync(lexical, { recursive: true });
  const root = fs.realpathSync(lexical);
  check(root);
  checkOthers(root);
  if (!fs.statSync(root).isDirectory()) throw new WorkspaceRuleError('工作目录不是文件夹');

  const warnings = [];
  if (fs.existsSync(path.join(root, '.git'))) {
    warnings.push('该目录本身是 git 仓库；建议把项目放在子目录中，否则 worktree 会落到账号目录外');
  }
  return { root, warnings };
}
