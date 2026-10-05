-- Host AFK: the host tool's AFK button (X-Host-Afk on an upload, docs/api.md). The host is dropped
-- from the rating of the rounds they were AFK in, like a leaver (docs/rating.md).

-- The rounds (ROUND_START numbers) the host was AFK in, as a JSON array, ascending: the union of
-- every upload of the match. NULL: none. It isn't in the log, so it lives here and a longer copy
-- (or a re-parse of the stored log) applies it again.
ALTER TABLE matches ADD COLUMN host_afk TEXT;

-- 1: the host, dropped from this round as AFK (no position), for the match page.
ALTER TABLE round_players ADD COLUMN afk INTEGER NOT NULL DEFAULT 0;
