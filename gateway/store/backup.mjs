import fs from 'node:fs';
import path from 'node:path';

import { dataPaths, ensurePrivateDir } from '../config.mjs';

const SKIPPED_TOP_LEVEL = new Set(['run', 'backup']);

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function listBackups(config) {
  const dir = dataPaths(config).backup;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^\d{8}-\d{6}(-\d+)?$/.test(name)).sort();
}

/** Copies the data root (minus run/ and backup/) to backup/<time>/ and keeps the newest N. */
export function createBackup(config) {
  const paths = dataPaths(config);
  ensurePrivateDir(paths.backup);
  let name = timestamp();
  for (let i = 1; fs.existsSync(path.join(paths.backup, name)); i += 1) name = `${timestamp()}-${i}`;
  const target = path.join(paths.backup, name);
  ensurePrivateDir(target);
  for (const entry of fs.readdirSync(config.dataRoot)) {
    if (SKIPPED_TOP_LEVEL.has(entry)) continue;
    fs.cpSync(path.join(config.dataRoot, entry), path.join(target, entry), { recursive: true, preserveTimestamps: true });
  }
  const backups = listBackups(config);
  for (const old of backups.slice(0, Math.max(0, backups.length - config.backupsToKeep))) {
    fs.rmSync(path.join(paths.backup, old), { recursive: true, force: true });
  }
  return name;
}

/** Replaces the data root contents (minus run/ and backup/) with a backup. */
export function restoreBackup(config, name) {
  const source = path.join(dataPaths(config).backup, name);
  if (!fs.existsSync(source)) throw new Error(`backup not found: ${name}`);
  for (const entry of fs.readdirSync(config.dataRoot)) {
    if (SKIPPED_TOP_LEVEL.has(entry)) continue;
    fs.rmSync(path.join(config.dataRoot, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(config.dataRoot, entry), { recursive: true, preserveTimestamps: true });
  }
}
