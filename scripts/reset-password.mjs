// Operator-side password reset for opt-in accounts (ACCOUNTS_ENABLED=1).
// There's no self-service recovery yet (no email is collected), so the
// deployment operator runs this on the host:
//
//   npm run reset-password -- <username>
//
// Sets a random temporary password, prints it once, and revokes every
// existing session for that account. Safe to run while the server is up —
// SQLite/WAL handles the concurrent writer. Hand the temp password over
// out-of-band and have the user sign in with it.
import Database from 'better-sqlite3';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';

const username = process.argv[2];
if (!username) {
    console.error('Usage: npm run reset-password -- <username>');
    process.exit(1);
}

const dbPath = process.env.ACCOUNTS_DB_PATH || './data/peek.db';
// Never create a DB here — a wrong path should fail loudly, not silently
// make an empty one.
if (!existsSync(dbPath)) {
    console.error(`No accounts DB at ${dbPath} (set ACCOUNTS_DB_PATH if it lives elsewhere).`);
    process.exit(1);
}

const db = new Database(dbPath, { fileMustExist: true });
db.pragma('foreign_keys = ON');

const user = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(username);
if (!user) {
    console.error(`No account named "${username}".`);
    db.close();
    process.exit(1);
}

const tempPassword = randomBytes(12).toString('base64url');
const passwordHash = await hash(tempPassword);

const revoked = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, Date.now(), user.id);
    return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes;
})();

db.close();
console.log(`Password reset for "${user.username}". Signed out ${revoked} session(s).`);
console.log(`Temporary password: ${tempPassword}`);
