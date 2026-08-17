#!/usr/bin/env node
// Copies githooks/pre-commit into .git/hooks/pre-commit so the CLAUDE.md
// doc-drift check (scripts/check-doc-drift.mjs) runs automatically before
// every commit. Runs via npm's "prepare" lifecycle script (fires on `npm
// install`/`npm ci`), so a fresh clone picks it up without a husky/
// simple-git-hooks dependency — just a plain file copy into .git/hooks/.

import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'githooks', 'pre-commit');
const gitDir = path.join(ROOT, '.git');

// Not a git checkout (e.g. installed as a tarball/dependency) — nothing to hook into.
if (!existsSync(gitDir)) process.exit(0);

const hooksDir = path.join(gitDir, 'hooks');
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

const dest = path.join(hooksDir, 'pre-commit');
copyFileSync(src, dest);
try {
    chmodSync(dest, 0o755);
} catch {
    // no-op — platforms without POSIX permission bits (still executable via the shebang under Git Bash)
}

console.log('Installed pre-commit hook (CLAUDE.md doc-drift check).');
