-- How many players are on each region's leaderboard, for its page count ("Page 2 of 28"). Counting
-- them on every leaderboard view would read the region's whole `ratings` once a view; this way the
-- rating writes count them (`boardPlayersStatement` in src/rating/store.ts) and a view reads one row.
-- See docs/database.md, "Tables".
ALTER TABLE rating_state ADD COLUMN board_players INTEGER;

-- Counted now from the stored ratings, as `boardPlayersStatement` does (3: `minRankedRounds`).
UPDATE rating_state SET board_players = (
  SELECT COUNT(*) FROM ratings r
  WHERE r.board = rating_state.board AND r.rounds >= 3 AND r.player_id NOT IN (SELECT id FROM players WHERE alt = 1));
