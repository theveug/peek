-- Self-service password recovery (2026-10-12): one-time recovery codes,
-- shown once at registration (or regenerated while signed in). Only a
-- SHA-256 hash is stored — same treatment as sessions.token_hash, and for the
-- same reason that's enough: each code carries 80 bits of randomness, so
-- unlike a human-chosen password it doesn't need a slow hash to resist an
-- offline guess. used_at is set (never deleted) so a spent code can't be
-- replayed; a regenerate deletes the whole set and inserts a fresh one.
CREATE TABLE recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE UNIQUE INDEX idx_recovery_codes_user_hash ON recovery_codes(user_id, code_hash);
