// Gateway database schema. Each entry upgrades `user_version` by one; never
// edit a released step, append a new one instead.
const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE accounts (
        id                INTEGER PRIMARY KEY,
        username          TEXT NOT NULL UNIQUE,
        role              TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        password_hash     TEXT NOT NULL,
        password_version  INTEGER NOT NULL DEFAULT 1,
        workspace_root    TEXT NOT NULL,
        note              TEXT,
        internal_password TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  },
];

export const LATEST_SCHEMA = MIGRATIONS.length;

export function pendingMigrations(db) {
  return LATEST_SCHEMA - db.pragma('user_version', { simple: true });
}

/** Applies pending migrations in one transaction. */
export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current > LATEST_SCHEMA) {
    throw new Error(`gateway.db schema ${current} is newer than this gateway (${LATEST_SCHEMA}); upgrade the package.`);
  }
  db.transaction(() => {
    for (let version = current; version < LATEST_SCHEMA; version += 1) {
      MIGRATIONS[version](db);
    }
    db.pragma(`user_version = ${LATEST_SCHEMA}`);
  })();
}
