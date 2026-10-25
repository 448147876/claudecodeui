import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { dataPaths, ensurePrivateDir, writePrivateFile } from '../config.mjs';

const CHILD_MARKERS = ['dist-server/server/index.js', 'server/index.ts'];

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function commandLine(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function writeRunFile(config, username, info) {
  ensurePrivateDir(dataPaths(config).run);
  writePrivateFile(dataPaths(config).runFile(username), JSON.stringify(info));
}

export function removeRunFile(config, username) {
  fs.rmSync(dataPaths(config).runFile(username), { force: true });
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

/**
 * Stops child processes left behind by a gateway that did not shut down
 * cleanly (PROC-10). A pid is only signalled when its command line still looks
 * like a CloudCLI server, so a recycled pid is never killed.
 */
export async function cleanupOrphans(config, log) {
  const runDir = dataPaths(config).run;
  if (!fs.existsSync(runDir)) return [];
  const cleaned = [];
  for (const file of fs.readdirSync(runDir)) {
    if (!file.endsWith('.json')) continue;
    const runFile = path.join(runDir, file);
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    } catch {
      // Unreadable leftovers are just removed.
    }
    if (info?.pid && isAlive(info.pid) && CHILD_MARKERS.some((marker) => commandLine(info.pid).includes(marker))) {
      log(`stopping leftover child ${file} (pid ${info.pid})`);
      try {
        process.kill(info.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      if (!(await waitForExit(info.pid, 10_000))) {
        try {
          process.kill(info.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      cleaned.push(info.pid);
    }
    fs.rmSync(runFile, { force: true });
  }
  return cleaned;
}

/** Takes run/gateway.lock; throws when another live gateway owns the data root. */
export function acquireGatewayLock(config) {
  const lock = dataPaths(config).lock;
  ensurePrivateDir(path.dirname(lock));
  if (fs.existsSync(lock)) {
    const pid = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`another gateway (pid ${pid}) is already using ${config.dataRoot}`);
    }
  }
  writePrivateFile(lock, String(process.pid));
  return () => fs.rmSync(lock, { force: true });
}
