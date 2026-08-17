#!/usr/bin/env node
// Mechanical backstop for CLAUDE.md's "Keep CLAUDE.md current" rule, which
// otherwise only works if every session remembers to self-audit. Run via
// `npm run check:docs`, the pre-commit hook (githooks/pre-commit), and the
// "Docs drift check" CI workflow.
//
// Checks two things CLAUDE.md must stay honest about:
//   1. The `(~N lines)` annotation next to each file in the "Never read large
//      files in full" list — flagged once actual drifts more than
//      LINE_DRIFT_THRESHOLD lines away from stated.
//   2. Every tests/*.mjs file is listed in CLAUDE.md's `tests/` project-structure
//      block, and vice versa (nothing documented that no longer exists).
//
// Exits non-zero (and prints what's stale) on any finding; silent success otherwise.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINE_DRIFT_THRESHOLD = 10;

function countLines(relPath) {
    const text = readFileSync(path.join(ROOT, relPath), 'utf8');
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

const claude = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const problems = [];

// --- 1. Line-count drift ---
const lineCountRe = /`([\w./-]+\.(?:js|html|css))`\s*\(~([\d,]+)\s*lines/g;
for (const m of claude.matchAll(lineCountRe)) {
    const relPath = m[1];
    const stated = parseInt(m[2].replace(/,/g, ''), 10);
    let actual;
    try {
        actual = countLines(relPath);
    } catch {
        problems.push(`CLAUDE.md references "${relPath}" (~${stated} lines) but that file no longer exists.`);
        continue;
    }
    const diff = Math.abs(actual - stated);
    if (diff > LINE_DRIFT_THRESHOLD) {
        problems.push(`CLAUDE.md says ${relPath} is ~${stated} lines, actual is ${actual} (off by ${diff}). Update the parenthetical in CLAUDE.md's file list.`);
    }
}

// --- 2. tests/*.mjs <-> CLAUDE.md's documented tests/ list ---
const actualTests = readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.mjs'));
const docTestRe = /^ {2}([\w-]+\.mjs)\s/gm;
const documentedTests = new Set([...claude.matchAll(docTestRe)].map(m => m[1]));

for (const f of actualTests) {
    if (!documentedTests.has(f)) {
        problems.push(`tests/${f} exists but isn't listed in CLAUDE.md's "tests/" project-structure section.`);
    }
}
for (const f of documentedTests) {
    if (!actualTests.includes(f)) {
        problems.push(`CLAUDE.md documents tests/${f}, but that file no longer exists in tests/.`);
    }
}

if (problems.length) {
    console.error('\nCLAUDE.md doc-drift check failed:\n');
    problems.forEach(p => console.error('  - ' + p));
    console.error('\nRun the /housekeeping skill (or fix CLAUDE.md by hand) and re-commit.');
    console.error('Bypass just this once (not recommended): git commit --no-verify\n');
    process.exit(1);
} else {
    console.log('CLAUDE.md doc-drift check passed.');
}
