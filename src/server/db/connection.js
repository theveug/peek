// --- src/server/db/connection.js ---
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';

// Only ever called from server.js's ACCOUNTS_ENABLED branch — a disabled
// deployment never imports/calls this, so it never creates a directory or
// file on disk (see CLAUDE.md's "Trust-tier indicator"/accounts entries).
export function openDb(dbPath) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    return db;
}
