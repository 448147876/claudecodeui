import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError, normalizeProjectPath } from '@/shared/utils.js';

/**
 * Multi-account isolation (cloudcli-multi).
 *
 * The multi-account gateway runs one server process per account and sets
 * `CLOUDCLI_ISOLATION_ROOT` to that account's workspace directory. Every
 * helper here is a no-op when the variable is unset, so upstream behaviour is
 * unchanged unless the gateway opts in. See mydocs/03-技术方案.md section 8.
 */

let cachedRaw: string | undefined;
let cachedRoot: string | null = null;

function resolveRealPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/** The account's workspace directory, or `null` when isolation is off. */
export function getIsolationRoot(): string | null {
  const raw = process.env.CLOUDCLI_ISOLATION_ROOT?.trim() || undefined;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedRoot = raw ? normalizeProjectPath(resolveRealPath(raw)) : null;
  }
  return cachedRoot;
}

function isUnder(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Resolves symlinks on the longest existing prefix, so not-yet-created paths still compare correctly. */
function resolveExistingPrefix(candidate: string): string {
  let current = path.resolve(candidate);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    rest.unshift(path.basename(current));
    current = parent;
  }
  return normalizeProjectPath(path.join(resolveRealPath(current), ...rest));
}

/** Lexical check for paths recorded by providers (a transcript's cwd); no filesystem access. */
export function isRecordedPathAllowed(projectPath: string | null | undefined): boolean {
  const root = getIsolationRoot();
  if (!root) {
    return true;
  }
  if (!projectPath) {
    return false;
  }
  return isUnder(root, normalizeProjectPath(path.resolve(projectPath)));
}

/** Symlink-aware check for client-supplied paths. */
export function isRequestedPathAllowed(candidate: string | null | undefined): boolean {
  const root = getIsolationRoot();
  if (!root) {
    return true;
  }
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return false;
  }
  return isUnder(root, resolveExistingPrefix(candidate.trim()));
}

export function assertRequestedPathAllowed(candidate: string | null | undefined): void {
  if (!isRequestedPathAllowed(candidate)) {
    throw new AppError(`Path is outside this account's workspace: ${candidate}`, {
      code: 'ISOLATION_PATH_FORBIDDEN',
      statusCode: 403,
    });
  }
}

/** Claude's on-disk project directory name for a working directory. */
export function encodeClaudeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function ownProjectDirPrefixMatches(name: string | undefined, root: string): boolean {
  if (!name) {
    return false;
  }
  const prefix = encodeClaudeProjectDirName(root);
  return name === prefix || name.startsWith(prefix + '-');
}

/**
 * Post-filter for an already-resolved read-only path.
 *
 * - Inside the Claude transcripts directory only this account's encoded
 *   project directories stay readable.
 * - Inside the temp directories only Claude's background-task output for this
 *   account stays readable: `<tmp>/claude-<uid>/<encoded cwd>/...`. The rest of
 *   /tmp belongs to other programs and, with a shared system user, to the other
 *   accounts; the temp directory itself cannot be listed.
 */
export function isReadOnlyPathAllowed(resolvedPath: string | null | undefined): boolean {
  const root = getIsolationRoot();
  if (!root || !resolvedPath) {
    return true;
  }
  const claudeProjectsDir = resolveRealPath(path.join(os.homedir(), '.claude', 'projects'));
  if (isUnder(claudeProjectsDir, resolvedPath)) {
    return ownProjectDirPrefixMatches(path.relative(claudeProjectsDir, resolvedPath).split(path.sep)[0], root);
  }
  for (const tmpRoot of new Set(['/tmp', os.tmpdir()].map(resolveRealPath))) {
    if (isUnder(tmpRoot, resolvedPath)) {
      const [taskRoot, projectDir] = path.relative(tmpRoot, resolvedPath).split(path.sep);
      return /^claude-\d+$/.test(taskRoot ?? '') && ownProjectDirPrefixMatches(projectDir, root);
    }
  }
  return true;
}

/** Whether `resolvedPath` is `.git` or anything inside a `.git` directory below `projectRoot`. */
export function isGitInternalsPath(projectRoot: string, resolvedPath: string): boolean {
  const relative = path.relative(projectRoot, resolvedPath);
  return relative.split(path.sep).some((segment) => segment.toLowerCase() === '.git');
}

const GIT_INTERNALS_ERROR = 'Files inside .git cannot be changed through the file API in this account';

/**
 * Guards a path the file API is about to touch inside a project, on top of the
 * plain "under the project root" check (isolation on only):
 *
 * - Git runs repository-defined commands (core.fsmonitor, credential.helper,
 *   hooks, filter drivers) from `.git/config` and `.git/hooks`; the file API
 *   must not write there, or an account could turn a file write into command
 *   execution as the shared system user.
 * - Symbolic links are resolved first. Without that, a link inside the project
 *   (a cloned repository can contain one) reaches `.git`, or another account's
 *   workspace, under a name that passes the textual checks.
 *
 * The final path component is followed too, so a link pointing out of the
 * project can be neither read nor written through; remove it in the terminal.
 */
export function assertProjectFilePathAllowed(projectRoot: string, resolvedPath: string): void {
  if (!getIsolationRoot()) {
    return;
  }
  if (isGitInternalsPath(projectRoot, resolvedPath)) {
    throw new AppError(GIT_INTERNALS_ERROR, { code: 'ISOLATION_GIT_INTERNALS_FORBIDDEN', statusCode: 403 });
  }
  const realRoot = normalizeProjectPath(resolveRealPath(projectRoot));
  const realPath = resolveExistingPrefix(resolvedPath);
  if (!isUnder(realRoot, realPath)) {
    throw new AppError('Path leaves the project through a symbolic link', { code: 'ISOLATION_SYMLINK_ESCAPE', statusCode: 403 });
  }
  if (isGitInternalsPath(realRoot, realPath)) {
    throw new AppError(GIT_INTERNALS_ERROR, { code: 'ISOLATION_GIT_INTERNALS_FORBIDDEN', statusCode: 403 });
  }
}

/** A bare file name: no directory part, no traversal. Always true with isolation off. */
export function isPlainFileName(name: unknown): boolean {
  if (!getIsolationRoot()) {
    return true;
  }
  return typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && !/[\\/\0]/.test(name);
}

/**
 * Clone sources: with isolation on only remote URLs. A local path or a file://
 * URL would let an account copy any repository on the machine into its workspace.
 */
export function isAllowedCloneSource(source: string): boolean {
  if (!getIsolationRoot()) {
    return true;
  }
  const value = source.trim();
  // Whitespace and control characters never belong in a repository address.
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  return /^(https?|ssh|git):\/\//i.test(value) || /^[\w.-]+@[\w.-]+:/.test(value);
}

/**
 * A custom-command file may be read when it really is a user-level command
 * (`~/.claude/commands`, shared by design) or lies inside this account's
 * workspace. Symbolic links are resolved first: a link under `.claude/commands`
 * (a cloned repository can contain one) must not hand out another account's file.
 */
export function isCommandFileAllowed(commandPath: string): boolean {
  const root = getIsolationRoot();
  if (!root) {
    return true;
  }
  const real = resolveExistingPrefix(commandPath);
  const userCommands = normalizeProjectPath(resolveRealPath(path.join(os.homedir(), '.claude', 'commands')));
  return isUnder(userCommands, real) || isUnder(root, real);
}

/** Workspace to use when a request names none: this account's root, else upstream's default. */
export function defaultWorkspacePath(): string {
  return getIsolationRoot() ?? process.cwd();
}
