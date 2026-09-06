-- Accounts Phase 3 (2026-09-07): presence, built poll-first per the security
-- review's revised plan (TODO.md's Deployment models entry) rather than an
-- always-on socket. A nullable last-seen timestamp is enough to derive
-- "online" (last_seen_at within a threshold the poll route computes) without
-- a separate session-tracking table — one column, not a new table, same
-- reasoning migration 0002 used for the settings blob (a single small value
-- always read/written as a unit doesn't justify a table of its own). NULL
-- means "never polled since this column existed" — always treated offline.
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
