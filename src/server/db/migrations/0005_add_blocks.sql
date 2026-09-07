-- Accounts Phase 2 follow-up (2026-09-07 security review): account-level
-- blocking. Directional storage (blocker_id -> blocked_id) but checked
-- bidirectionally in FriendsManager.isBlockedEitherWay() — if A blocks B,
-- neither side can send the other a friend request, matching the mutual-
-- invisibility semantics a "block" implies rather than only silencing one
-- direction. A separate table from friendships (not a status value on that
-- table) because a block and a friendship are independent facts: blocking
-- someone you're not even friends with must work, and blocking a friend
-- must sever the friendship (handled by deleting the friendships row in
-- FriendsManager.blockUser()) while still recording who blocked whom.
CREATE TABLE blocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_blocks_pair ON blocks(blocker_id, blocked_id);
CREATE INDEX idx_blocks_blocked ON blocks(blocked_id);
