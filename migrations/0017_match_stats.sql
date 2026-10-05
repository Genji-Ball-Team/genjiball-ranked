-- Match stats (#15) and head-to-head records (#18). See docs/database.md, "Match stats and head-to-head".

-- Counted at upload so the match page reads no events. `kills`: KILL lines with the player as
-- attacker that aren't a self-kill (as the tourney standings count them), in the round and in the
-- whole match (between rounds too). `deflects`: DEFLECT lines in the round, NULL for legacy logs (none).
ALTER TABLE round_players ADD COLUMN kills INTEGER NOT NULL DEFAULT 0;
ALTER TABLE round_players ADD COLUMN deflects INTEGER;
ALTER TABLE match_players ADD COLUMN kills INTEGER NOT NULL DEFAULT 0;

-- Derived at upload: one row per ordered pair of players in a match, both directions, so a player's
-- records read only their own rows. `rounds`: rated rounds both finished (`position` set), `ahead`:
-- those the player finished above the opponent. `kills`: KILL lines of the player on the opponent,
-- anywhere in the match; `deaths`: the reverse. A pair with kills but no shared rated round has a row.
CREATE TABLE match_pairs (
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  opponent_id INTEGER NOT NULL REFERENCES players(id),
  rounds      INTEGER NOT NULL,
  ahead       INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  deaths      INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id, opponent_id)
) WITHOUT ROWID;

-- The sum of match_pairs over a region's accepted matches, kept by the triggers below, so a player
-- page or head-to-head reads totals instead of every round. Derived: `npm run rebuild:head-to-head`
-- rebuilds it. A row whose counts all reach 0 is deleted. A player merge (#8) re-derives the pairs of
-- the matches it moves (src/admin/playerStore.ts), and the triggers move the totals.
CREATE TABLE pair_stats (
  region      TEXT NOT NULL,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  opponent_id INTEGER NOT NULL REFERENCES players(id),
  rounds      INTEGER NOT NULL,
  ahead       INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  deaths      INTEGER NOT NULL,
  PRIMARY KEY (region, player_id, opponent_id)
) WITHOUT ROWID;

-- Invariant: pair_stats = the sum of match_pairs of the `accepted` matches, in their region. Each
-- trigger keeps it whatever order an upload or admin action writes in, and every write to pair_stats
-- goes through its primary key, so a trigger reads the match's pairs, not the region's.
CREATE TRIGGER match_pairs_insert AFTER INSERT ON match_pairs
WHEN (SELECT status = 'accepted' AND region IS NOT NULL FROM matches WHERE id = NEW.match_id)
BEGIN
  INSERT INTO pair_stats (region, player_id, opponent_id, rounds, ahead, kills, deaths)
  SELECT region, NEW.player_id, NEW.opponent_id, NEW.rounds, NEW.ahead, NEW.kills, NEW.deaths FROM matches WHERE id = NEW.match_id
  ON CONFLICT (region, player_id, opponent_id) DO UPDATE SET rounds = rounds + excluded.rounds, ahead = ahead + excluded.ahead,
    kills = kills + excluded.kills, deaths = deaths + excluded.deaths;
END;

CREATE TRIGGER match_pairs_delete AFTER DELETE ON match_pairs
WHEN (SELECT status = 'accepted' AND region IS NOT NULL FROM matches WHERE id = OLD.match_id)
BEGIN
  UPDATE pair_stats SET rounds = rounds - OLD.rounds, ahead = ahead - OLD.ahead, kills = kills - OLD.kills, deaths = deaths - OLD.deaths
  WHERE region = (SELECT region FROM matches WHERE id = OLD.match_id) AND player_id = OLD.player_id AND opponent_id = OLD.opponent_id;
  DELETE FROM pair_stats
  WHERE region = (SELECT region FROM matches WHERE id = OLD.match_id) AND player_id = OLD.player_id AND opponent_id = OLD.opponent_id
    AND rounds = 0 AND kills = 0 AND deaths = 0;
END;

-- Accepted, voided, rejected, unvoided or moved to another region (#47): out of the old totals, into
-- the new. Taking out is an upsert of negative counts: the pairs are the outer loop, each a key lookup.
CREATE TRIGGER matches_pairs_update AFTER UPDATE OF status, region ON matches
WHEN (OLD.status = 'accepted') != (NEW.status = 'accepted') OR (NEW.status = 'accepted' AND NEW.region IS NOT OLD.region)
BEGIN
  INSERT INTO pair_stats (region, player_id, opponent_id, rounds, ahead, kills, deaths)
  SELECT OLD.region, p.player_id, p.opponent_id, -p.rounds, -p.ahead, -p.kills, -p.deaths FROM match_pairs p
  WHERE OLD.status = 'accepted' AND OLD.region IS NOT NULL AND p.match_id = OLD.id
  ON CONFLICT (region, player_id, opponent_id) DO UPDATE SET rounds = rounds + excluded.rounds, ahead = ahead + excluded.ahead,
    kills = kills + excluded.kills, deaths = deaths + excluded.deaths;
  DELETE FROM pair_stats
  WHERE OLD.status = 'accepted' AND region = OLD.region AND rounds = 0 AND kills = 0 AND deaths = 0
    AND (player_id, opponent_id) IN (SELECT player_id, opponent_id FROM match_pairs WHERE match_id = OLD.id);
  INSERT INTO pair_stats (region, player_id, opponent_id, rounds, ahead, kills, deaths)
  SELECT NEW.region, p.player_id, p.opponent_id, p.rounds, p.ahead, p.kills, p.deaths FROM match_pairs p
  WHERE NEW.status = 'accepted' AND NEW.region IS NOT NULL AND p.match_id = NEW.id
  ON CONFLICT (region, player_id, opponent_id) DO UPDATE SET rounds = rounds + excluded.rounds, ahead = ahead + excluded.ahead,
    kills = kills + excluded.kills, deaths = deaths + excluded.deaths;
END;

-- A deleted match: its pairs go first, while match_pairs_delete can still see the match. A cascade
-- would run after the match is gone and leave the totals stale.
CREATE TRIGGER matches_pairs_delete BEFORE DELETE ON matches
BEGIN
  DELETE FROM match_pairs WHERE match_id = OLD.id;
END;

-- What's stored already, from its events.
UPDATE round_players SET deflects = 0
WHERE round_id IN (SELECT r.id FROM rounds r JOIN matches m ON m.id = r.match_id WHERE m.legacy = 0);
UPDATE round_players SET deflects = d.n
FROM (
  SELECT r.id AS round_id, e.actor_id, count(*) AS n
  FROM events e JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
  WHERE e.type = 'DEFLECT' GROUP BY r.id, e.actor_id
) d
WHERE round_players.round_id = d.round_id AND round_players.log_id = d.actor_id AND round_players.deflects IS NOT NULL;
-- Round kills: the KILLs the parser put in a round. Uploads also count a KILL logged after its
-- round's ROUND_END in the same tick in its ELIM's round (src/upload/plan.ts, matchStats), which the
-- events alone can't tell: matches stored before this migration may count one kill fewer in a round.
UPDATE round_players SET kills = k.n
FROM (
  SELECT r.id AS round_id, e.actor_id, count(*) AS n
  FROM events e JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
  WHERE e.type = 'KILL' AND e.actor_id IS NOT NULL AND e.actor_id IS NOT e.target_id GROUP BY r.id, e.actor_id
) k
WHERE round_players.round_id = k.round_id AND round_players.log_id = k.actor_id;
UPDATE match_players SET kills = k.n
FROM (
  SELECT match_id, actor_id, count(*) AS n FROM events
  WHERE type = 'KILL' AND actor_id IS NOT NULL AND actor_id IS NOT target_id GROUP BY match_id, actor_id
) k
WHERE match_players.match_id = k.match_id AND match_players.log_id = k.actor_id;

-- Pairs of every stored match; the insert trigger fills pair_stats from the accepted ones. The same
-- query as the upload's (src/upload/store.ts) and the rebuild's (src/upload/pairs.ts).
INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL'
)
GROUP BY match_id, player_id, opponent_id;
