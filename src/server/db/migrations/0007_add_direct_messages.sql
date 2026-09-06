-- Accounts Phase 4 (2026-09-07): direct messages. Friends-only by
-- application-level check (DirectMessagesManager.sendMessage() re-validates
-- the accepted-friendship each send, not just at read time) — no DB
-- constraint enforces this, same "app enforces relationship invariants"
-- precedent as friendships' own no-duplicate-pair rule. `read_at` is
-- nullable (unread) and only ever set by the recipient fetching the
-- conversation (DirectMessagesManager.getConversation()), never by the
-- sender or by listing conversations.
CREATE TABLE direct_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);
-- Two directional indexes rather than one on an unordered pair (SQLite has
-- no LEAST()/GREATEST() to normalize into a single composite key without a
-- generated column) — a conversation query ORs both directions, and each
-- side gets its own efficient index range scan.
CREATE INDEX idx_dm_sender_recipient ON direct_messages(sender_id, recipient_id, created_at);
CREATE INDEX idx_dm_recipient_sender ON direct_messages(recipient_id, sender_id, created_at);
