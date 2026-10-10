-- A match sets a record only with enough players and rated rounds (config `recordsMinPlayers`,
-- `recordsMinRatedRounds`). See docs/database.md, "Records".

-- Different players in the match, bots left out. The cron writes it with the match's other stats.
ALTER TABLE match_stats ADD COLUMN players INTEGER NOT NULL DEFAULT 0;
UPDATE match_stats SET players = (
  SELECT COUNT(DISTINCT mp.player_id) FROM match_players mp JOIN players p ON p.id = mp.player_id
  WHERE mp.match_id = match_stats.match_id AND p.bot = 0
);

-- Every region's records are rebuilt at the next cron run without the matches below the minimum.
UPDATE records_revisions SET revision = revision + 1, urgent = revision + 1;
