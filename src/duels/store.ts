import { displayRating, newRating, type DisplayConfig, type NewRatingConfig } from "../rating/engine";
import type { Config } from "../config";
import { nameKey } from "../upload/plan";
import type { DuelPlayer, PlannedDuel, PlayerDuelRow } from "./plan";

/** The name of the host every duel has: shown on nothing public. */
const duelHostName = "Duels (entered by admins)";

/**
 * The D1 queries of duels (docs/database.md, "Duels"). A duel is a `matches` row with `duel` = 1 in
 * its region, from the duels host and upload (migration 0032), with two `match_players` rows (log id
 * 1 the winner, 2 the loser) and its `duels` row. The ratings rate it like any match.
 */

/** The known players with these names (ignoring case), by `nameKey`: the aliases' players. */
export async function findPlayersByName(db: D1Database, keys: readonly string[]): Promise<Map<string, DuelPlayer & { id: number }>> {
  if (!keys.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT a.name_key AS key, p.id, p.name FROM json_each(?1) k CROSS JOIN aliases a ON a.name_key = k.value
       JOIN players p ON p.id = a.player_id`,
    )
    .bind(JSON.stringify([...new Set(keys)]))
    .all<{ key: string; id: number; name: string }>();
  return new Map(results.map((r) => [r.key, { id: r.id, name: r.name }]));
}

/** Each pair's rated duels in the region since `since` (the start of the day), by `pairKey`. */
export async function countRatedToday(db: D1Database, region: string, since: string): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT min(w.player_id, l.player_id) || ':' || max(w.player_id, l.player_id) AS pair, COUNT(*) AS n
       FROM matches m INDEXED BY matches_duels
         JOIN duels d ON d.match_id = m.id
         JOIN match_players w ON w.match_id = m.id AND w.log_id = 1
         JOIN match_players l ON l.match_id = m.id AND l.log_id = 2
       WHERE m.region = ?1 AND m.duel = 1 AND m.status = 'accepted' AND m.played_at >= ?2 AND d.rated = 1
       GROUP BY pair`,
    )
    .bind(region, since)
    .all<{ pair: string; n: number }>();
  return new Map(results.map((r) => [r.pair, r.n]));
}

export interface DuelWrite {
  region: string;
  /** One second apart from the first, in the entry's order. */
  playedAt: string[];
  duels: PlannedDuel[];
  /** A stamp for the entry's match keys: unique to it. */
  stamp: string;
  adminId: number;
  at: string;
}

/**
 * Stores an entry's duels in one transaction: new players (and their alias, with no seen time, like a
 * name an admin gave), the matches, their players and scores, and the `admin_actions` row. Returns
 * the new match ids, in order. The ratings rate them like any new match (`rateNewMatches`).
 */
export async function writeDuels(db: D1Database, w: DuelWrite): Promise<number[]> {
  const keyOf = (i: number) => `duel:${w.stamp}:${i}`;
  const newNames = [...new Map(
    w.duels.flatMap((d) => [d.winner, d.loser]).filter((p) => p.id === null).map((p) => [nameKey(p.name), p.name]),
  )].map(([key, name]) => ({ key, name }));
  const rows = w.duels.map((d, i) => ({
    key: keyOf(i),
    playedAt: w.playedAt[i],
    winnerKey: nameKey(d.winner.name),
    winnerName: d.winner.name,
    loserKey: nameKey(d.loser.name),
    loserName: d.loser.name,
    winnerScore: d.winnerScore,
    loserScore: d.loserScore,
    rated: d.rated ? 1 : 0,
  }));
  const json = JSON.stringify(rows);
  const results = await db.batch<{ id: number }>([
    // The host and upload every duel has (migrations/0032_duels.sql), made the first time.
    db.prepare(
      `INSERT INTO hosts (name, token_hash, trust) SELECT '${duelHostName}', 'duels', 'revoked'
       WHERE NOT EXISTS (SELECT 1 FROM hosts WHERE token_hash = 'duels')`,
    ),
    db.prepare(
      `INSERT INTO uploads (host_id, content_hash, raw_log, raw_size, file_name, status)
       SELECT id, 'duels', X'', 0, NULL, 'parsed' FROM hosts WHERE token_hash = 'duels'
         AND NOT EXISTS (SELECT 1 FROM uploads WHERE content_hash = 'duels')`,
    ),
    db
      .prepare(
        `INSERT INTO players (name, created_at)
         SELECT e.value ->> 'name', ?2 FROM json_each(?1) e
         WHERE NOT EXISTS (SELECT 1 FROM aliases a WHERE a.name_key = e.value ->> 'key')`,
      )
      .bind(JSON.stringify(newNames), w.at),
    db
      .prepare(
        `INSERT INTO aliases (player_id, name, name_key, first_seen_at, last_seen_at)
         SELECT p.id, p.name, e.value ->> 'key', '', ''
         FROM players p JOIN json_each(?1) e ON e.value ->> 'name' = p.name
         WHERE p.id > (SELECT coalesce(max(player_id), 0) FROM aliases)
           AND p.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM aliases a WHERE a.player_id = p.id)`,
      )
      .bind(JSON.stringify(newNames)),
    db
      .prepare(
        `INSERT INTO matches (upload_id, host_id, match_key, line_count, format, game_version, legacy, status, played_at, complete, region, duel)
         SELECT (SELECT id FROM uploads WHERE content_hash = 'duels'), (SELECT id FROM hosts WHERE token_hash = 'duels'),
           e.value ->> 'key', 0, 0, 'duel', 0, 'accepted', e.value ->> 'playedAt', 1, ?2, 1
         FROM json_each(?1) e`,
      )
      .bind(json, w.region),
    db
      .prepare(
        `INSERT INTO match_players (match_id, log_id, player_id, name, join_time, alias_id)
         SELECT m.id, s.log, a.player_id, a.name, 0, a.id
         FROM json_each(?1) e
           CROSS JOIN (SELECT 1 AS log UNION ALL SELECT 2) s
           JOIN matches m ON m.match_key = e.value ->> 'key'
             AND m.host_id = (SELECT id FROM hosts WHERE token_hash = 'duels')
           JOIN aliases a ON a.name_key = CASE s.log WHEN 1 THEN e.value ->> 'winnerKey' ELSE e.value ->> 'loserKey' END`,
      )
      .bind(json),
    db
      .prepare(
        `INSERT INTO duels (match_id, winner_score, loser_score, rated, admin_id)
         SELECT m.id, e.value ->> 'winnerScore', e.value ->> 'loserScore', e.value ->> 'rated', ?2
         FROM json_each(?1) e JOIN matches m ON m.match_key = e.value ->> 'key'
           AND m.host_id = (SELECT id FROM hosts WHERE token_hash = 'duels')`,
      )
      .bind(json, w.adminId),
    db
      .prepare(`INSERT INTO admin_actions (admin_id, action, detail, at) VALUES (?1, 'duels_add', ?2, ?3)`)
      .bind(
        w.adminId,
        JSON.stringify({
          region: w.region,
          duels: w.duels.map((d) => ({ winner: d.winner.name, loser: d.loser.name, score: `${d.winnerScore}-${d.loserScore}`, rated: d.rated })),
        }),
        w.at,
      ),
    db
      .prepare(
        `SELECT m.id FROM json_each(?1) e JOIN matches m ON m.match_key = e.value ->> 'key'
           AND m.host_id = (SELECT id FROM hosts WHERE token_hash = 'duels') ORDER BY e.key`,
      )
      .bind(json),
  ]);
  return results.at(-1)!.results.map((r) => r.id);
}

/** A duel as listed: both players, the score, and what it did to their ratings. */
export interface DuelRow {
  id: number;
  playedAt: string;
  winnerScore: number;
  loserScore: number;
  rated: boolean;
  winner: DuelSide;
  loser: DuelSide;
}

export interface DuelSide {
  id: number;
  name: string;
  /** Display rating before and after; null when the duel changed no rating. */
  ratingBefore: number | null;
  ratingAfter: number | null;
}

/** Each side's player and display ratings: `?1` is the region, `m` the duel's match. */
const sides = `(SELECT json_group_array(json_object('log', mp.log_id, 'id', mp.player_id, 'name', p.name,
    'after', (SELECT h.display FROM rating_history h
      WHERE h.board = m.region AND h.player_id = mp.player_id AND h.played_at = m.played_at AND h.match_id = m.id),
    'before', (SELECT h.display FROM rating_history h
      WHERE h.board = m.region AND h.player_id = mp.player_id AND (h.played_at, h.match_id) < (m.played_at, m.id)
      ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1)))
  FROM match_players mp JOIN players p ON p.id = mp.player_id WHERE mp.match_id = m.id)`;

interface RawDuel {
  id: number;
  playedAt: string;
  winnerScore: number;
  loserScore: number;
  rated: number;
  sides: string;
}

/** What listing duels reads: each region's new-player start, for a side's first rating. */
export type DuelListConfig = NewRatingConfig & DisplayConfig & Pick<Config, "ratingNewPlayerStartByRegion">;

/**
 * A duel's row. A side the duel rated with no earlier rating in the region (their first rating
 * there) gets the rating they started from as `ratingBefore`, so it shows a change, not "not rated".
 */
function toDuel(r: RawDuel, region: string, config: DuelListConfig): DuelRow | null {
  const all = JSON.parse(r.sides) as { log: number; id: number; name: string; after: number | null; before: number | null }[];
  const start = (): number => {
    const own = Object.hasOwn(config.ratingNewPlayerStartByRegion, region) ? config.ratingNewPlayerStartByRegion[region] : undefined;
    return displayRating(newRating({ ...config, ratingNewPlayerStart: own ?? config.ratingNewPlayerStart }, r.playedAt), config);
  };
  const side = (log: number): DuelSide | null => {
    const s = all.find((x) => x.log === log);
    if (!s) return null;
    return { id: s.id, name: s.name, ratingAfter: s.after, ratingBefore: s.after === null ? null : (s.before ?? start()) };
  };
  const winner = side(1);
  const loser = side(2);
  if (!winner || !loser) return null;
  return { id: r.id, playedAt: r.playedAt, winnerScore: r.winnerScore, loserScore: r.loserScore, rated: r.rated === 1, winner, loser };
}

const duelColumns = `m.id, m.played_at AS playedAt, d.winner_score AS winnerScore, d.loser_score AS loserScore, d.rated, ${sides} AS sides`;

/** The region's newest duels, older than duel `before` when given (index `matches_duels`). */
export async function listDuels(db: D1Database, config: DuelListConfig, region: string, limit: number, before: number | null): Promise<DuelRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${duelColumns}
       FROM matches m INDEXED BY matches_duels JOIN duels d ON d.match_id = m.id
       WHERE m.region = ?1 AND m.duel = 1 AND m.status = 'accepted'
         AND (?3 IS NULL OR (m.played_at, m.id) < (SELECT played_at, id FROM matches WHERE id = ?3))
       ORDER BY m.played_at DESC, m.id DESC LIMIT ?2`,
    )
    .bind(region, limit, before)
    .all<RawDuel>();
  return results.flatMap((r) => toDuel(r, region, config) ?? []);
}

/** The player's duels in the region, newest first, at most `limit`, from their side. */
export async function listPlayerDuels(db: D1Database, config: DuelListConfig, region: string, playerId: number, limit: number): Promise<PlayerDuelRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${duelColumns}
       FROM match_players me JOIN matches m ON m.id = me.match_id JOIN duels d ON d.match_id = m.id
       WHERE me.player_id = ?2 AND m.region = ?1 AND m.duel = 1 AND m.status = 'accepted'
       ORDER BY m.played_at DESC, m.id DESC LIMIT ?3`,
    )
    .bind(region, playerId, limit)
    .all<RawDuel>();
  return results.flatMap((r) => {
    const duel = toDuel(r, region, config);
    if (!duel) return [];
    const won = duel.winner.id === playerId;
    const [mine, theirs] = won ? [duel.winner, duel.loser] : [duel.loser, duel.winner];
    return [
      {
        id: duel.id,
        playedAt: duel.playedAt,
        won,
        score: won ? duel.winnerScore : duel.loserScore,
        opponentScore: won ? duel.loserScore : duel.winnerScore,
        opponent: { id: theirs.id, name: theirs.name },
        ratingBefore: mine.ratingBefore,
        ratingAfter: mine.ratingAfter,
      },
    ];
  });
}
