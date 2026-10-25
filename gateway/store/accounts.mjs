import crypto from 'node:crypto';
import fs from 'node:fs';

import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';

import { migrate } from './migrations.mjs';

const BCRYPT_COST = 12;
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
export const MIN_PASSWORD_LENGTH = 6;

export function openDatabase(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  fs.chmodSync(file, 0o600);
  return db;
}

/** Account storage for the gateway (gateway.db). */
export function createAccountStore(db) {
  migrate(db);

  const publicFields = 'id, username, role, password_version, workspace_root, note, created_at';

  return {
    hasAdmin() {
      return Boolean(db.prepare("SELECT 1 FROM accounts WHERE role = 'admin' LIMIT 1").get());
    },

    list() {
      return db.prepare(`SELECT ${publicFields} FROM accounts ORDER BY role, created_at, id`).all();
    },

    getById(id) {
      return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) ?? null;
    },

    getByUsername(username) {
      return db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) ?? null;
    },

    async create({ username, password, role, workspaceRoot, note }) {
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const internalPassword = crypto.randomBytes(32).toString('base64url');
      const info = db.prepare(`
        INSERT INTO accounts (username, role, password_hash, workspace_root, note, internal_password)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(username, role, passwordHash, workspaceRoot, note || null, internalPassword);
      return this.getById(info.lastInsertRowid);
    },

    async verifyPassword(account, password) {
      return bcrypt.compare(password, account.password_hash);
    },

    async setPassword(username, password) {
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const info = db.prepare(`
        UPDATE accounts SET password_hash = ?, password_version = password_version + 1 WHERE username = ?
      `).run(passwordHash, username);
      return info.changes > 0;
    },

    remove(username) {
      return db.prepare("DELETE FROM accounts WHERE username = ? AND role <> 'admin'").run(username).changes > 0;
    },
  };
}

/** A constant-time-ish dummy compare so unknown usernames cost the same as wrong passwords. */
const DUMMY_HASH = bcrypt.hashSync('cloudcli-multi-dummy', BCRYPT_COST);
export async function burnPasswordCheck(password) {
  await bcrypt.compare(String(password ?? ''), DUMMY_HASH);
  return false;
}
