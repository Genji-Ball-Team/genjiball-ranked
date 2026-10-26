-- Head-to-head and K/D without AFK rounds. A `KILL` in a round where the killer or the victim was AFK
-- (`round_players.afk`, the host's AFK rounds), or between rounds after such a round, no longer
-- counts in `match_pairs` (src/upload/pairs.ts).
--
-- Fealthy (player 1) hosted AFK in every EU match before 522: their rated rounds there were marked
-- AFK by hand on 2026-10-21 (for the rating). Their rounds left in those matches, the unrated legacy
-- ones, are marked AFK here too. AFK rows only change unrated rounds' stats, never a rating.
UPDATE round_players SET afk = 1
WHERE player_id = 1 AND afk = 0 AND position IS NULL AND left_round = 0
  AND round_id IN (SELECT r.id FROM rounds r JOIN matches m ON m.id = r.match_id WHERE m.id < 522 AND m.region = 'eu');

-- Then the pairs of every match with an AFK round are derived again with the new count: deleted (the
-- triggers take them out of `pair_stats`) and inserted (they add the accepted ones back). This also
-- picks up the rows marked AFK after the upload, whose pairs still counted those rounds as played. In
-- ranges of 100 match ids, so no statement is long; the same query as the upload's. About 60,000
-- pairs each way, a few hundred thousand rows written with the totals.

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 1 AND 100);

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 1 AND 100)
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 1 AND 100)
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 101 AND 200);

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 101 AND 200)
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 101 AND 200)
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 201 AND 300);

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 201 AND 300)
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 201 AND 300)
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 301 AND 400);

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 301 AND 400)
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 301 AND 400)
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 401 AND 500);

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 401 AND 500)
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 401 AND 500)
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 501 AND 600);

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 501 AND 600)
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 501 AND 600)
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 601 AND 700);

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 601 AND 700)
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 601 AND 700)
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 701 AND 800);

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 701 AND 800)
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 701 AND 800)
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;

DELETE FROM match_pairs WHERE match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 801 AND (SELECT max(id) FROM matches));

INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths, finals, final_wins)
SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths), sum(finals), sum(final_wins) FROM (
  SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths,
    a.position <= 2 AND b.position <= 2 AS finals, a.position = 1 AND b.position = 2 AS final_wins
  FROM rounds r
  JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
  JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
  WHERE r.rated = 1 AND r.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 801 AND (SELECT max(id) FROM matches))
  UNION ALL
  SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
    0, 0, 1 - d.flip, d.flip, 0, 0
  FROM events e
  JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
  JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
  CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
  WHERE e.type = 'KILL' AND e.match_id IN (SELECT DISTINCT r.match_id FROM rounds r JOIN round_players rp ON rp.round_id = r.id WHERE rp.afk = 1 AND r.match_id BETWEEN 801 AND (SELECT max(id) FROM matches))
    AND NOT EXISTS (
      SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
      WHERE r.match_id = e.match_id AND rp.afk = 1 AND rp.log_id IN (e.actor_id, e.target_id)
        AND r.number = coalesce(e.round, (SELECT max(p.number) FROM rounds p WHERE p.match_id = e.match_id AND p.start_time <= e.time))
    )
)
WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
GROUP BY match_id, player_id, opponent_id;
