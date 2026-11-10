import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

function uniqueJsonlPathsFromSessions(
  sessions: Array<{ jsonl_path: string | null }>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const row of sessions) {
    const raw = row.jsonl_path?.trim();
    if (!raw) {
      continue;
    }
    const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    result.push(absolute);
  }

  return result;
}

/**
 * True only when the project directory is definitely gone. Any other failure
 * (permissions, I/O) counts as present so a project is never flagged — or
 * cleaned up — just because its directory could not be read.
 */
export async function isProjectDirectoryMissing(projectPath: string): Promise<boolean> {
  try {
    return !(await fs.stat(projectPath)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/**
 * A Claude transcript `<projects>/<encoded-cwd>/<session>.jsonl` keeps its
 * subagent and tool-result files in a sibling `<session>/` directory. Removes
 * that directory, then the encoded-cwd directory once nothing is left in it.
 * Does nothing for transcripts outside `~/.claude/projects` (other providers).
 */
async function removeClaudeTranscriptLeftovers(filePath: string): Promise<void> {
  const claudeProjectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const projectDir = path.dirname(filePath);
  if (path.dirname(projectDir) !== claudeProjectsRoot || path.extname(filePath) !== '.jsonl') {
    return;
  }

  const sessionDirName = path.basename(filePath, '.jsonl');
  if (sessionDirName) {
    await fs.rm(path.join(projectDir, sessionDirName), { recursive: true, force: true }).catch((error: Error) => {
      console.warn(`[project-delete] Failed to remove ${path.join(projectDir, sessionDirName)}:`, error.message);
    });
  }

  try {
    if ((await fs.readdir(projectDir)).length === 0) {
      await fs.rmdir(projectDir);
    }
  } catch {
    // Already gone, or another session still lives there.
  }
}

async function unlinkJsonlIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    console.warn(`[project-delete] Failed to remove ${filePath}:`, (error as Error).message);
  }
}

/**
 * Loads all session rows for the project path and removes each distinct `jsonl_path` file on disk.
 */
export async function deleteSessionJsonlFilesForProjectPath(projectPath: string): Promise<void> {
  const sessions = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath);
  // Including the transcripts a session has left behind: editing a message on
  // a provider that rewinds by branching moves the session onto a copy, and
  // the row stops pointing at the file the replaced turns are still in.
  const paths = uniqueJsonlPathsFromSessions([
    ...sessions,
    ...sessions.flatMap((session) => sessionsDb
      .getSupersededTranscriptPaths(session.session_id)
      .map((jsonl_path) => ({ jsonl_path }))),
  ]);

  for (const filePath of paths) {
    await unlinkJsonlIfExists(filePath);
    await removeClaudeTranscriptLeftovers(filePath);
  }

  for (const session of sessions) {
    sessionsDb.clearSupersededProviderSessions(session.session_id);
  }
}

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 * - **Force** (`force` true): for each session row for that `project_path`, delete the file at `jsonl_path`
 *   (when set), then remove session rows and the `projects` row.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    return;
  }

  await deleteSessionJsonlFilesForProjectPath(row.project_path);
  sessionsDb.deleteSessionsByProjectPath(row.project_path);
  projectsDb.deleteProjectById(projectId);
}

/**
 * Permanently deletes the given projects whose directory no longer exists.
 * Each id is re-checked here, so a project whose directory came back since the
 * list was loaded (e.g. the repo was cloned again) is skipped, never deleted.
 */
export async function cleanupMissingProjects(
  projectIds: string[],
): Promise<{ deleted: string[]; skipped: string[] }> {
  const deleted: string[] = [];
  const skipped: string[] = [];

  for (const projectId of new Set(projectIds)) {
    const row = projectsDb.getProjectById(projectId);
    if (!row || !(await isProjectDirectoryMissing(row.project_path))) {
      skipped.push(projectId);
      continue;
    }

    try {
      await deleteOrArchiveProject(projectId, true);
      deleted.push(projectId);
    } catch (error) {
      console.warn(`[project-delete] Failed to clean up project ${projectId}:`, (error as Error).message);
      skipped.push(projectId);
    }
  }

  return { deleted, skipped };
}

/**
 * Restores one archived project row back into the active project list.
 */
export function restoreArchivedProject(projectId: string): void {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  projectsDb.updateProjectIsArchivedById(projectId, false);
}
