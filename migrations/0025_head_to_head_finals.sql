-- Finals in the head-to-head records: the rated rounds two players finished 1st and 2nd, so the last
-- two alive, and which of them won. See docs/database.md, "Match stats and head-to-head".

-- `finals`: of the pair's rated rounds (`rounds`), the ones the two finished 1st and 2nd.
-- `final_wins`: of those, the ones the player won. A final implies a round, so a row whose `rounds`,
-- `kills` and `deaths` are 0 still has nothing in it.
ALTER TABLE match_pairs ADD COLUMN finals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_pairs ADD COLUMN final_wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pair_stats ADD COLUMN finals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pair_stats ADD COLUMN final_wins INTEGER NOT NULL DEFAULT 0;

-- The triggers of migration 0017, with the two new counts. matches_pairs_delete names no column.
DROP TRIGGER match_pairs_insert;
DROP TRIGGER match_pairs_delete;
DROP TRIGGER matches_pairs_update;

CREATE TRIGGER match_pairs_insert AFTER INSERT ON match_pairs
WHEN (SELECT status = 'accepted' AND region IS NOT NULL FROM matches WHERE id = NEW.match_id)
BEGIN
  INSERT INTO pair_stats (region, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
  SELECT region, NEW.player_id, NEW.opponent_id, NEW.rounds, NEW.ahead, NEW.kills, NEW.deaths, NEW.finals, NEW.final_wins
  FROM matches WHERE id = NEW.match_id
  ON CONFLICT (region, player_id, opponent_id) DO UPDATE SET rounds = rounds + excluded.rounds, ahead = ahead + excluded.ahead,
    kills = kills + excluded.kills, deaths = deaths + excluded.deaths, finals = finals + excluded.finals, final_wins = final_wins + excluded.final_wins;
END;

CREATE TRIGGER match_pairs_delete AFTER DELETE ON match_pairs
WHEN (SELECT status = 'accepted' AND region IS NOT NULL FROM matches WHERE id = OLD.match_id)
BEGIN
  UPDATE pair_stats SET rounds = rounds - OLD.rounds, ahead = ahead - OLD.ahead, kills = kills - OLD.kills, deaths = deaths - OLD.deaths,
    finals = finals - OLD.finals, final_wins = final_wins - OLD.final_wins
  WHERE region = (SELECT region FROM matches WHERE id = OLD.match_id) AND player_id = OLD.player_id AND opponent_id = OLD.opponent_id;
  DELETE FROM pair_stats
  WHERE region = (SELECT region FROM matches WHERE id = OLD.match_id) AND player_id = OLD.player_id AND opponent_id = OLD.opponent_id
    AND rounds = 0 AND kills = 0 AND deaths = 0;
END;

CREATE TRIGGER matches_pairs_update AFTER UPDATE OF status, region ON matches
WHEN (OLD.status = 'accepted') != (NEW.status = 'accepted') OR (NEW.status = 'accepted' AND NEW.region IS NOT OLD.region)
BEGIN
  INSERT INTO pair_stats (region, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
  SELECT OLD.region, p.player_id, p.opponent_id, -p.rounds, -p.ahead, -p.kills, -p.deaths, -p.finals, -p.final_wins FROM match_pairs p
  WHERE OLD.status = 'accepted' AND OLD.region IS NOT NULL AND p.match_id = OLD.id
  ON CONFLICT (region, player_id, opponent_id) DO UPDATE SET rounds = rounds + excluded.rounds, ahead = ahead + excluded.ahead,
    kills = kills + excluded.kills, deaths = deaths + excluded.deaths, finals = finals + excluded.finals, final_wins = final_wins + excluded.final_wins;
  DELETE FROM pair_stats
  WHERE OLD.status = 'accepted' AND region = OLD.region AND rounds = 0 AND kills = 0 AND deaths = 0
    AND (player_id, opponent_id) IN (SELECT player_id, opponent_id FROM match_pairs WHERE match_id = OLD.id);
  INSERT INTO pair_stats (region, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
  SELECT NEW.region, p.player_id, p.opponent_id, p.rounds, p.ahead, p.kills, p.deaths, p.finals, p.final_wins FROM match_pairs p
  WHERE NEW.status = 'accepted' AND NEW.region IS NOT NULL AND p.match_id = NEW.id
  ON CONFLICT (region, player_id, opponent_id) DO UPDATE SET rounds = rounds + excluded.rounds, ahead = ahead + excluded.ahead,
    kills = kills + excluded.kills, deaths = deaths + excluded.deaths, finals = finals + excluded.finals, final_wins = final_wins + excluded.final_wins;
END;

-- What's stored already: the finals of every pair, from its matches' rated rounds (two rows per
-- final, one each way), then the totals of the accepted ones. Only the rows with a final are written.
-- The same count as the upload's (src/upload/pairs.ts).
UPDATE match_pairs SET finals = f.finals, final_wins = f.final_wins
FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, count(*) AS finals, sum(a.position = 1) AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IN (1, 2)
  JOIN round_players b ON b.round_id = r.id AND b.position IN (1, 2) AND b.player_id != a.player_id
  WHERE r.rated = 1
  GROUP BY r.match_id, a.player_id, b.player_id
) f
WHERE match_pairs.match_id = f.match_id AND match_pairs.player_id = f.player_id AND match_pairs.opponent_id = f.opponent_id;

UPDATE pair_stats SET finals = t.finals, final_wins = t.final_wins
FROM (
  SELECT m.region, p.player_id, p.opponent_id, sum(p.finals) AS finals, sum(p.final_wins) AS final_wins
  FROM match_pairs p JOIN matches m ON m.id = p.match_id
  WHERE p.finals > 0 AND m.status = 'accepted' AND m.region IS NOT NULL
  GROUP BY m.region, p.player_id, p.opponent_id
) t
WHERE pair_stats.region = t.region AND pair_stats.player_id = t.player_id AND pair_stats.opponent_id = t.opponent_id;
