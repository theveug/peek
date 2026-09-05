// --- src/server/db/migrate.js ---
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Hand-rolled on purpose, matching this codebase's existing aversion to
// ORMs/query-builders (see WebSocketServer.js's hand-rolled switch dispatch,
// server.js's hand-rolled rateLimit()) — better-sqlite3's own
// .prepare().get()/.all()/.run() is already as ergonomic as this project's
// handful of queries need.
export function runMigrations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
    )`);

    const applied = new Set(
        db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
    );

    const files = readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const applyOne = db.transaction(() => {
            db.exec(sql);
            db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
                .run(file, Date.now());
        });
        applyOne();
    }
}
