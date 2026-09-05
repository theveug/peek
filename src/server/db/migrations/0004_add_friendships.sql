-- Accounts Phase 2: friends. A table, not a column on users — genuinely
-- many-to-many. status is 'pending'|'accepted' only; a declined/cancelled/
-- unfriended relationship is deleted outright, never soft-stated. No DB-level
-- unique constraint on the unordered (requester,addressee) pair (SQLite can't
-- express that in one index) — FriendsManager.js enforces "no duplicate
-- relationship between the same two users" itself, checking both directions
-- before inserting.
CREATE TABLE friendships (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_friendships_requester ON friendships(requester_id);
CREATE INDEX idx_friendships_addressee ON friendships(addressee_id);
