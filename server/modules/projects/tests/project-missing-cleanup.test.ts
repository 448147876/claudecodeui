import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  cleanupMissingProjects,
  isProjectDirectoryMissing,
} from '@/modules/projects/services/project-delete.service.js';

type Stubbable = Record<string, unknown>;

/** Swaps methods on a repository object for the duration of `run`, restoring them afterwards. */
async function withStubs(
  target: object,
  stubs: Record<string, unknown>,
  run: () => Promise<void>,
): Promise<void> {
  const record = target as Stubbable;
  const originals = Object.fromEntries(Object.keys(stubs).map((key) => [key, record[key]]));
  Object.assign(record, stubs);
  try {
    await run();
  } finally {
    Object.assign(record, originals);
  }
}

test('isProjectDirectoryMissing: existing directory is present, missing path and plain file are missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-project-'));
  try {
    const filePath = path.join(root, 'file.txt');
    await fs.writeFile(filePath, 'x');
    assert.equal(await isProjectDirectoryMissing(root), false);
    assert.equal(await isProjectDirectoryMissing(path.join(root, 'gone')), true);
    assert.equal(await isProjectDirectoryMissing(filePath), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cleanupMissingProjects skips unknown projects and projects whose directory exists', async () => {
  const existingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'existing-project-'));
  const deletedIds: string[] = [];
  try {
    await withStubs(projectsDb, {
      getProjectById: (projectId: string) =>
        projectId === 'present' ? { project_id: 'present', project_path: existingDir } : null,
      deleteProjectById: (projectId: string) => { deletedIds.push(projectId); },
    }, async () => {
      const result = await cleanupMissingProjects(['present', 'unknown']);
      assert.deepEqual(result, { deleted: [], skipped: ['present', 'unknown'] });
      assert.deepEqual(deletedIds, []);
    });
  } finally {
    await fs.rm(existingDir, { recursive: true, force: true });
  }
});

test('cleanupMissingProjects deletes a missing project with its transcript, session directory and empty project folder', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-home-'));
  const originalHome = process.env.HOME;
  const missingPath = path.join(home, 'gone-repo');
  const encodedDir = path.join(home, '.claude', 'projects', '-gone-repo');
  const jsonlPath = path.join(encodedDir, 'session-1.jsonl');
  const deletedProjectIds: string[] = [];
  const deletedSessionPaths: string[] = [];

  try {
    process.env.HOME = home;
    await fs.mkdir(path.join(encodedDir, 'session-1', 'subagents'), { recursive: true });
    await fs.writeFile(jsonlPath, '{}\n');
    await fs.writeFile(path.join(encodedDir, 'session-1', 'subagents', 'agent.jsonl'), '{}\n');

    await withStubs(projectsDb, {
      getProjectById: () => ({ project_id: 'missing', project_path: missingPath }),
      deleteProjectById: (projectId: string) => { deletedProjectIds.push(projectId); },
    }, () => withStubs(sessionsDb, {
      getSessionsByProjectPathIncludingArchived: () => [{ session_id: 'session-1', jsonl_path: jsonlPath }],
      getSupersededTranscriptPaths: () => [],
      clearSupersededProviderSessions: () => {},
      deleteSessionsByProjectPath: (projectPath: string) => { deletedSessionPaths.push(projectPath); },
    }, async () => {
      const result = await cleanupMissingProjects(['missing', 'missing']);
      assert.deepEqual(result, { deleted: ['missing'], skipped: [] });
    }));

    assert.deepEqual(deletedProjectIds, ['missing']);
    assert.deepEqual(deletedSessionPaths, [missingPath]);
    await assert.rejects(fs.stat(encodedDir), { code: 'ENOENT' });
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
