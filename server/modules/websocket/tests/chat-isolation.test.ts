import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// Some modules in this import chain open the database while loading (the auth
// middleware creates its JWT secret), so point DATABASE_PATH at a scratch file
// first; otherwise they create the legacy database inside the repository.
const bootstrapDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-isolation-boot-'));
process.env.DATABASE_PATH ??= path.join(bootstrapDirectory, 'auth.db');

const { closeConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { handleChatConnection } = await import('@/modules/websocket/services/chat-websocket.service.js');
const { chatRunRegistry } = await import('@/modules/websocket/services/chat-run-registry.service.js');
const { connectedClients } = await import('@/modules/websocket/services/websocket-state.service.js');

after(async () => {
  await rm(bootstrapDirectory, { recursive: true, force: true });
});

// cloudcli-multi (mydocs/06 API-05): a client-supplied chat cwd outside the
// account's workspace must not reach the provider runtime.

const SESSION_ID = 'isolation-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (data: string) => void };
  socket.readyState = 1;
  socket.send = () => {};
  return socket;
}

type RunCall = { options: Record<string, unknown> };

async function sendWithCwd(isolated: boolean, clientCwd: string | undefined): Promise<{ run: RunCall; projectDir: string; outsideDir: string }> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousRoot = process.env.CLOUDCLI_ISOLATION_ROOT;
  const tempDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chat-isolation-')));
  const workspace = path.join(tempDirectory, 'w', 'projA');
  const projectDir = path.join(workspace, 'app1');
  const outsideDir = path.join(tempDirectory, 'w', 'projB');
  await mkdir(projectDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  if (isolated) process.env.CLOUDCLI_ISOLATION_ROOT = workspace;
  else delete process.env.CLOUDCLI_ISOLATION_ROOT;
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', projectDir, 'Isolation session', now, now, null);
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, _command: string, options: Record<string, unknown>) => {
          runs.push({ options });
        },
      } as never,
    });
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'hello',
      options: clientCwd === undefined ? {} : { cwd: clientCwd.replace('<outside>', outsideDir).replace('<inside>', path.join(projectDir, 'sub')) },
    }));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    assert.equal(runs.length, 1);
    return { run: runs[0], projectDir, outsideDir };
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousRoot === undefined) delete process.env.CLOUDCLI_ISOLATION_ROOT;
    else process.env.CLOUDCLI_ISOLATION_ROOT = previousRoot;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an outside cwd falls back to the session project when isolation is on', async () => {
  const { run, projectDir } = await sendWithCwd(true, '<outside>');
  assert.equal(run.options.cwd, projectDir);
  assert.equal(run.options.projectPath, projectDir);
});

test('a cwd inside the workspace is kept when isolation is on', async () => {
  const { run, projectDir } = await sendWithCwd(true, '<inside>');
  assert.equal(run.options.cwd, path.join(projectDir, 'sub'));
});

test('without a client cwd the session project is used', async () => {
  const { run, projectDir } = await sendWithCwd(true, undefined);
  assert.equal(run.options.cwd, projectDir);
});

test('without the switch a client cwd is honoured as upstream does', async () => {
  const { run, outsideDir } = await sendWithCwd(false, '<outside>');
  assert.equal(run.options.cwd, outsideDir);
});
