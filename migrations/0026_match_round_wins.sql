-- The player page's recent matches show each player's place and rounds won (docs/database.md,
-- "Match stats and head-to-head"). Counted at upload like `kills`: the `WIN` rounds this log id
-- won. The place is worked out from the match's `match_players` rows when a page reads them, so
-- a player merge needs no recount.
ALTER TABLE match_players ADD COLUMN round_wins INTEGER NOT NULL DEFAULT 0;
-- One pass over `rounds`, writing only the rows of players who won a round.
UPDATE match_players SET round_wins = w.n
FROM (SELECT match_id, winner_id, COUNT(*) AS n FROM rounds WHERE result = 'WIN' AND winner_id IS NOT NULL GROUP BY match_id, winner_id) w
WHERE w.match_id = match_players.match_id AND w.winner_id = match_players.log_id;
