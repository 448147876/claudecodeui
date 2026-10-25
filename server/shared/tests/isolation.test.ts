import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, afterEach } from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  assertProjectFilePathAllowed,
  assertRequestedPathAllowed,
  defaultWorkspacePath,
  encodeClaudeProjectDirName,
  getIsolationRoot,
  isAllowedCloneSource,
  isCommandFileAllowed,
  isPlainFileName,
  isReadOnlyPathAllowed,
  isRecordedPathAllowed,
  isRequestedPathAllowed,
} from '@/shared/isolation.js';
import { AppError } from '@/shared/utils.js';

// Fixture layout:
//   <fixture>/w/projA            this account's workspace
//   <fixture>/w/projA-2          a sibling that shares the name prefix
//   <fixture>/w/projB            another account's workspace
//   <fixture>/home/.claude/projects/<encoded dirs>
const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'isolation-')));
const workspaceA = path.join(fixtureRoot, 'w', 'projA');
const siblingA2 = path.join(fixtureRoot, 'w', 'projA-2');
const workspaceB = path.join(fixtureRoot, 'w', 'projB');
const fixtureHome = path.join(fixtureRoot, 'home');
const claudeProjectsDir = path.join(fixtureHome, '.claude', 'projects');
await Promise.all([workspaceA, siblingA2, workspaceB, claudeProjectsDir].map((dir) => mkdir(dir, { recursive: true })));

const previousRoot = process.env.CLOUDCLI_ISOLATION_ROOT;
const previousHome = process.env.HOME;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv('CLOUDCLI_ISOLATION_ROOT', previousRoot);
  restoreEnv('HOME', previousHome);
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function enableIsolation(): void {
  process.env.CLOUDCLI_ISOLATION_ROOT = workspaceA;
}

test('without the switch every check allows and nothing is filtered', () => {
  delete process.env.CLOUDCLI_ISOLATION_ROOT;

  assert.equal(getIsolationRoot(), null);
  assert.equal(isRecordedPathAllowed(workspaceB), true);
  assert.equal(isRecordedPathAllowed(null), true);
  assert.equal(isRequestedPathAllowed('/etc'), true);
  assert.equal(isRequestedPathAllowed(undefined), true);
  assert.doesNotThrow(() => assertRequestedPathAllowed(workspaceB));
  assert.equal(isReadOnlyPathAllowed(path.join(claudeProjectsDir, '-other', 'x.jsonl')), true);
});

test('recorded paths are compared on path boundaries', () => {
  enableIsolation();

  assert.equal(getIsolationRoot(), workspaceA);
  assert.equal(isRecordedPathAllowed(workspaceA), true);
  assert.equal(isRecordedPathAllowed(path.join(workspaceA, 'app1')), true);
  assert.equal(isRecordedPathAllowed(`${workspaceA}/`), true);
  assert.equal(isRecordedPathAllowed(siblingA2), false);
  assert.equal(isRecordedPathAllowed(workspaceB), false);
  assert.equal(isRecordedPathAllowed(path.join(workspaceA, '..', 'projB')), false);
  assert.equal(isRecordedPathAllowed(''), false);
  assert.equal(isRecordedPathAllowed(null), false);
});

test('requested paths resolve symlinks and tolerate paths that do not exist yet', async () => {
  enableIsolation();
  const escapeLink = path.join(workspaceA, 'link-to-b');
  await symlink(workspaceB, escapeLink);

  try {
    assert.equal(isRequestedPathAllowed(path.join(workspaceA, 'new', 'nested')), true);
    assert.equal(isRequestedPathAllowed(escapeLink), false);
    assert.equal(isRequestedPathAllowed(path.join(escapeLink, 'not-yet')), false);
    assert.equal(isRequestedPathAllowed(path.join(workspaceA, '..', 'projB')), false);
    assert.equal(isRequestedPathAllowed(siblingA2), false);
    assert.equal(isRequestedPathAllowed('   '), false);
    assert.equal(isRequestedPathAllowed(42 as unknown as string), false);
  } finally {
    await rm(escapeLink, { force: true });
  }
});

test('assertRequestedPathAllowed throws a 403 AppError outside the workspace', () => {
  enableIsolation();

  assert.doesNotThrow(() => assertRequestedPathAllowed(path.join(workspaceA, 'app1')));
  assert.throws(
    () => assertRequestedPathAllowed(workspaceB),
    (error: unknown) => error instanceof AppError && error.statusCode === 403 && error.code === 'ISOLATION_PATH_FORBIDDEN',
  );
});

test('read-only transcripts are narrowed to this account\'s encoded project directories', () => {
  enableIsolation();
  process.env.HOME = fixtureHome;
  const ownPrefix = encodeClaudeProjectDirName(workspaceA);

  assert.equal(isReadOnlyPathAllowed(path.join(claudeProjectsDir, ownPrefix, 's.jsonl')), true);
  assert.equal(isReadOnlyPathAllowed(path.join(claudeProjectsDir, `${ownPrefix}-app1`, 'sub', 'agent-1.jsonl')), true);
  assert.equal(isReadOnlyPathAllowed(path.join(claudeProjectsDir, encodeClaudeProjectDirName(workspaceB), 's.jsonl')), false);
  assert.equal(isReadOnlyPathAllowed(path.join(claudeProjectsDir, `${ownPrefix}x`, 's.jsonl')), false);
  assert.equal(isReadOnlyPathAllowed(claudeProjectsDir), false);
  assert.equal(isReadOnlyPathAllowed(null), true);
  assert.equal(isReadOnlyPathAllowed(path.join(process.cwd(), 'elsewhere.txt')), true, 'not under a read-only root: left to the other checks');
});

test('only this account\'s Claude task output stays readable under the temp directory', async () => {
  enableIsolation();
  const tmp = await realpath(tmpdir());
  const ownPrefix = encodeClaudeProjectDirName(workspaceA);

  assert.equal(isReadOnlyPathAllowed(path.join(tmp, 'claude-1000', ownPrefix, 'tasks', 'a.output')), true);
  assert.equal(isReadOnlyPathAllowed(path.join(tmp, 'claude-1000', `${ownPrefix}-app1`, 's', 'a.output')), true);
  assert.equal(isReadOnlyPathAllowed(path.join(tmp, 'claude-1000', encodeClaudeProjectDirName(workspaceB), 'a.output')), false);
  assert.equal(isReadOnlyPathAllowed(path.join(tmp, 'claude-1000', 'a.output')), false);
  assert.equal(isReadOnlyPathAllowed(path.join(tmp, 'watch.sh')), false);
  assert.equal(isReadOnlyPathAllowed(path.join(tmp, 'other-user-dir', ownPrefix, 'x')), false);
  assert.equal(isReadOnlyPathAllowed(tmp), false, 'the temp directory cannot be listed');
});

test('the file API refuses .git internals only when isolation is on', () => {
  const projectRoot = path.join(workspaceA, 'app1');
  const inGit = [path.join(projectRoot, '.git', 'config'), path.join(projectRoot, '.git', 'hooks', 'pre-commit'), path.join(projectRoot, 'sub', '.GIT', 'config'), path.join(projectRoot, '.git')];
  const normal = [path.join(projectRoot, 'src', 'a.ts'), path.join(projectRoot, '.gitignore'), path.join(projectRoot, '.github', 'workflow.yml'), path.join(projectRoot, 'git', 'x')];

  delete process.env.CLOUDCLI_ISOLATION_ROOT;
  for (const file of inGit) assert.doesNotThrow(() => assertProjectFilePathAllowed(projectRoot, file), file);

  enableIsolation();
  for (const file of inGit) {
    assert.throws(() => assertProjectFilePathAllowed(projectRoot, file), (error: unknown) => error instanceof AppError && error.statusCode === 403, file);
  }
  for (const file of normal) assert.doesNotThrow(() => assertProjectFilePathAllowed(projectRoot, file), file);
});

test('the file API guard follows symbolic links (into .git, out of the project, into another account)', async () => {
  const projectRoot = path.join(workspaceA, 'guard-app');
  await mkdir(path.join(projectRoot, '.git'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  const links = {
    toGit: path.join(projectRoot, 'to-git'),
    toOtherAccount: path.join(projectRoot, 'to-other-account'),
    toOutside: path.join(projectRoot, 'to-outside'),
    inside: path.join(projectRoot, 'inside-link'),
  };
  await symlink('.git', links.toGit);
  await symlink(workspaceB, links.toOtherAccount);
  await symlink(fixtureRoot, links.toOutside);
  await symlink('src', links.inside);

  try {
    delete process.env.CLOUDCLI_ISOLATION_ROOT;
    for (const link of [links.toGit, links.toOtherAccount]) {
      assert.doesNotThrow(() => assertProjectFilePathAllowed(projectRoot, path.join(link, 'config')), 'no-op without the switch');
    }

    enableIsolation();
    for (const target of [
      path.join(links.toGit, 'config'),
      path.join(links.toGit, 'hooks', 'pre-commit'),
      path.join(links.toOtherAccount, 'secret.txt'),
      path.join(links.toOtherAccount, 'not-yet', 'new.txt'),
      path.join(links.toOutside, 'x'),
      links.toOtherAccount,
    ]) {
      assert.throws(() => assertProjectFilePathAllowed(projectRoot, target), (error: unknown) => error instanceof AppError && error.statusCode === 403, target);
    }
    for (const target of [
      path.join(projectRoot, 'src', 'a.ts'),
      path.join(projectRoot, 'src', 'new', 'deep', 'a.ts'),
      path.join(links.inside, 'a.ts'),
      path.join(links.inside, 'brand-new.ts'),
    ]) {
      assert.doesNotThrow(() => assertProjectFilePathAllowed(projectRoot, target), target);
    }
  } finally {
    await Promise.all(Object.values(links).map((link) => rm(link, { force: true })));
  }
});

test('custom command files: user-level and workspace files are readable, links out of both are not', async () => {
  process.env.HOME = fixtureHome;
  const userCommands = path.join(fixtureHome, '.claude', 'commands');
  const ownCommands = path.join(workspaceA, 'cmd-app', '.claude', 'commands');
  await mkdir(userCommands, { recursive: true });
  await mkdir(ownCommands, { recursive: true });
  const foreign = path.join(workspaceB, 'secret.txt');
  await writeFile(foreign, 'other account');
  await writeFile(path.join(userCommands, 'shared.md'), 'shared');
  await writeFile(path.join(ownCommands, 'ok.md'), 'mine');
  const links = [path.join(ownCommands, 'evil.md'), path.join(userCommands, 'evil-shared.md')];
  for (const link of links) await symlink(foreign, link);

  try {
    delete process.env.CLOUDCLI_ISOLATION_ROOT;
    assert.equal(isCommandFileAllowed(links[0]), true, 'no-op without the switch');

    enableIsolation();
    assert.equal(isCommandFileAllowed(path.join(userCommands, 'shared.md')), true);
    assert.equal(isCommandFileAllowed(path.join(ownCommands, 'ok.md')), true);
    for (const target of [links[0], links[1], foreign, path.join(workspaceB, 'x.md'), '/etc/passwd']) {
      assert.equal(isCommandFileAllowed(target), false, target);
    }
  } finally {
    await Promise.all(links.map((link) => rm(link, { force: true })));
  }
});

test('plain file names: traversal is refused only when isolation is on', () => {
  const bad = ['../../x.md', 'a/b.md', 'a\\b.md', '..', '.', '', 'x\0.md', '/etc/passwd', undefined, 42];
  delete process.env.CLOUDCLI_ISOLATION_ROOT;
  for (const name of bad) assert.equal(isPlainFileName(name), true, String(name));
  enableIsolation();
  for (const name of bad) assert.equal(isPlainFileName(name), false, String(name));
  for (const name of ['prd.txt', 'my notes.md', '.hidden', 'a..b.md']) assert.equal(isPlainFileName(name), true, name);
});

test('clone sources: only remote URLs are accepted when isolation is on', () => {
  const local = ['/home/user/repo', '../repo', 'file:///home/user/repo', 'repo', 'ext::sh -c id', '~/repo'];
  const unsafe = ['https://github.com/o/r.git\n/etc/passwd', 'https://github.com/o/r .git', 'https://github.com/o/r.git\t/etc', 'https://host/\u0000x'];
  const remote = ['https://github.com/o/r.git', 'http://example.com/r.git', 'ssh://git@host/o/r.git', 'git://host/o/r.git', 'git@github.com:o/r.git'];
  delete process.env.CLOUDCLI_ISOLATION_ROOT;
  for (const source of [...local, ...remote]) assert.equal(isAllowedCloneSource(source), true, source);
  enableIsolation();
  for (const source of [...local, ...unsafe]) assert.equal(isAllowedCloneSource(source), false, JSON.stringify(source));
  for (const source of remote) assert.equal(isAllowedCloneSource(source), true, source);
});

test('the default workspace is this account\'s root, else upstream\'s working directory', () => {
  delete process.env.CLOUDCLI_ISOLATION_ROOT;
  assert.equal(defaultWorkspacePath(), process.cwd());
  enableIsolation();
  assert.equal(defaultWorkspacePath(), workspaceA);
});

test('encodeClaudeProjectDirName matches Claude\'s directory naming', () => {
  assert.equal(encodeClaudeProjectDirName('/w/proj_A.v2'), '-w-proj-A-v2');
});

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'isolation-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    restoreEnv('DATABASE_PATH', previousDatabasePath);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('createSession skips transcripts outside the workspace without registering a project', async () => {
  enableIsolation();

  await withDatabase(() => {
    const ownProject = path.join(workspaceA, 'app1');
    assert.equal(sessionsDb.createSession('own-session', 'claude', ownProject), 'own-session');
    assert.ok(projectsDb.getProjectPath(ownProject));

    assert.equal(sessionsDb.createSession('foreign-session', 'claude', path.join(workspaceB, 'app2')), '');
    assert.equal(sessionsDb.createSession('sibling-session', 'claude', siblingA2), '');
    assert.equal(projectsDb.getProjectPath(path.join(workspaceB, 'app2')), null);
    assert.equal(projectsDb.getProjectPath(siblingA2), null);
    assert.equal(sessionsDb.getSessionById('foreign-session'), null);
  });
});

test('createProjectPath refuses paths outside the workspace', async () => {
  enableIsolation();

  await withDatabase(() => {
    assert.throws(
      () => projectsDb.createProjectPath(path.join(workspaceB, 'app2')),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );
    assert.equal(projectsDb.createProjectPath(path.join(workspaceA, 'app1')).outcome, 'created');
  });
});

test('without the switch the repositories behave as upstream', async () => {
  delete process.env.CLOUDCLI_ISOLATION_ROOT;

  await withDatabase(() => {
    assert.equal(sessionsDb.createSession('any-session', 'claude', path.join(workspaceB, 'app2')), 'any-session');
    assert.equal(projectsDb.createProjectPath(siblingA2).outcome, 'created');
  });
});
