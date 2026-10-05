-- AI bots aren't players in head-to-head and records. See docs/database.md, "Match stats and head-to-head".

-- 1: an AI bot (config `legacyBotNames`), set when an upload first sees the name. Its rounds are
-- never rated; it keeps its place in match player lists, but has no head-to-head and holds no record.
ALTER TABLE players ADD COLUMN bot INTEGER NOT NULL DEFAULT 0 CHECK (bot IN (0, 1));
-- The bots already stored, by alias key (lowercase) of the names in `legacyBotNames`.
UPDATE players SET bot = 1 WHERE id IN (SELECT player_id FROM aliases WHERE name_key IN ('genji bot', 'zsh4d0ws bozo'));

-- Their pairs go; the triggers take them out of `pair_stats`.
DELETE FROM match_pairs
WHERE player_id IN (SELECT id FROM players WHERE bot = 1) OR opponent_id IN (SELECT id FROM players WHERE bot = 1);

-- Their matches' records are counted again without them, and every region's records are rebuilt at
-- the next cron run, as after a merge.
INSERT INTO match_stats_recount (match_id)
SELECT DISTINCT match_id FROM match_players WHERE player_id IN (SELECT id FROM players WHERE bot = 1);
UPDATE records_revisions SET revision = revision + 1, urgent = revision + 1;
