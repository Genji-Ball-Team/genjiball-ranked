/**
 * Head-to-head pairs (#18): the SQL that derives `match_pairs` from a match's rounds and events. The
 * upload and the rebuild (`npm run rebuild:head-to-head`) both use it; migration 0017 ran the same
 * query once over what was stored. `pair_stats` follows `match_pairs` through triggers
 * (migrations/0017_match_stats.sql, docs/database.md "Match stats and head-to-head").
 */

/**
 * Inserts the pairs of players of the matches `matchIds` (an SQL query of match ids) into
 * `match_pairs`: rated rounds both finished, rounds ahead, and `KILL` lines between them both ways
 * (a self-kill or the kill of a player with no id isn't one). A bot (`players.bot`) has no pairs:
 * kills by and of one aren't counted. Reads each match's rounds and events once, by key.
 */
export function matchPairsInsert(matchIds: string): string {
  return `INSERT INTO match_pairs (match_id, player_id, opponent_id, rounds, ahead, kills, deaths)
    SELECT match_id, player_id, opponent_id, sum(rounds), sum(ahead), sum(kills), sum(deaths) FROM (
      SELECT r.match_id, a.player_id, b.player_id AS opponent_id, 1 AS rounds, a.position < b.position AS ahead, 0 AS kills, 0 AS deaths
      FROM rounds r
      JOIN round_players a ON a.round_id = r.id AND a.position IS NOT NULL
      JOIN round_players b ON b.round_id = r.id AND b.position IS NOT NULL AND b.player_id != a.player_id
      WHERE r.rated = 1 AND r.match_id IN (${matchIds})
      UNION ALL
      SELECT e.match_id, CASE WHEN d.flip THEN v.player_id ELSE k.player_id END, CASE WHEN d.flip THEN k.player_id ELSE v.player_id END,
        0, 0, 1 - d.flip, d.flip
      FROM events e
      JOIN match_players k ON k.match_id = e.match_id AND k.log_id = e.actor_id
      JOIN match_players v ON v.match_id = e.match_id AND v.log_id = e.target_id AND v.player_id != k.player_id
      CROSS JOIN (SELECT 0 AS flip UNION ALL SELECT 1) d
      WHERE e.type = 'KILL' AND e.match_id IN (${matchIds})
    )
    WHERE player_id NOT IN (SELECT id FROM players WHERE bot = 1) AND opponent_id NOT IN (SELECT id FROM players WHERE bot = 1)
    GROUP BY match_id, player_id, opponent_id`;
}

const ids = (from: number, to: number) => {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) throw new Error("from and to must be ids, from <= to");
};

/**
 * Re-derives the pairs of matches `from` to `to` (ids, both included), after a fix to how pairs are
 * counted: deletes them, which takes them out of `pair_stats`, and inserts them again, which adds the
 * accepted ones back. The totals are right after each range. About 280 rows written per 8-player
 * match, so run it in ranges (docs/database.md).
 */
export function rebuildPairsStatements(from: number, to: number): string[] {
  ids(from, to);
  return [
    `DELETE FROM match_pairs WHERE match_id BETWEEN ${from} AND ${to}`,
    matchPairsInsert(`SELECT id FROM matches WHERE id BETWEEN ${from} AND ${to}`),
  ];
}

/**
 * Recomputes `pair_stats` of players `from` to `to` (ids, both included) from `match_pairs`, for
 * totals that went wrong. A player's rows depend only on their own `match_pairs` rows, so each range
 * is right once it ran, whatever the others; run ranges until every player is covered. Writes the
 * range's `pair_stats` rows twice (deleted, inserted), and reads all of `match_pairs` and `pair_stats`
 * whatever the range: neither has an index by player, which would cost writes on every upload.
 */
export function rebuildTotalsStatements(from: number, to: number): string[] {
  ids(from, to);
  return [
    `DELETE FROM pair_stats WHERE player_id BETWEEN ${from} AND ${to}`,
    `INSERT INTO pair_stats (region, player_id, opponent_id, rounds, ahead, kills, deaths)
    SELECT m.region, p.player_id, p.opponent_id, sum(p.rounds), sum(p.ahead), sum(p.kills), sum(p.deaths)
    FROM match_pairs p JOIN matches m ON m.id = p.match_id
    WHERE p.player_id BETWEEN ${from} AND ${to} AND m.status = 'accepted' AND m.region IS NOT NULL
    GROUP BY m.region, p.player_id, p.opponent_id
    HAVING sum(p.rounds) != 0 OR sum(p.kills) != 0 OR sum(p.deaths) != 0`,
  ];
}
