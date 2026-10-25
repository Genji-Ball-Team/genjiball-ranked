import { dayMs, isoSeconds } from "../time";
import {
  distinctHolders,
  monthStart,
  recordMatchIds,
  recordPlayerIds,
  withoutMatches,
  withPlayers,
  type CareerRecord,
  type FeedMatch,
  type MatchCounts,
  type MatchRecord,
  type MatchStatsRow,
  type RecordsBody,
  type RecordsConfig,
  type RecordsInput,
} from "./stats";

/**
 * The records' D1 queries (#19, docs/database.md "Records"). `match_stats` follows the match feed;
 * `records` holds each region's page as served, so a page view reads one row. Everything that reads
 * `match_stats` also checks the match is still accepted in the region, and every write checks it
 * again, so a change between the cron's reads and its write can't leave a private match counted.
 *
 * `readMatchCounts` is the only part that counts from `events`: with per-player counts stored at
 * upload, it's the one to switch.
 */

/** A match counted in the region's records: still accepted, and still there. `m` is the match, `?1` the region. */
const counted = "m.status = 'accepted' AND m.region = ?1";


/** Matches changed in the feed since the cron last read it, oldest change first, at most `limit`. */
export async function readFeedChanges(db: D1Database, limit: number): Promise<{ cursor: number; matches: FeedMatch[] }> {
  // LEFT JOIN: the cursor comes back even with no change after it.
  const { results } = await db
    .prepare(
      `SELECT s.feed_cursor AS cursor, m.id, m.feed_seq AS seq, m.status, m.region, m.host_id AS hostId, m.played_at AS playedAt,
         m.line_count AS lineCount
       FROM records_state s LEFT JOIN matches m ON m.feed_seq > s.feed_cursor
       ORDER BY m.feed_seq LIMIT ?1`,
    )
    .bind(limit)
    .all<{ cursor: number } & { [K in keyof FeedMatch]: FeedMatch[K] | null }>();
  return {
    cursor: results[0]?.cursor ?? 0,
    matches: results.flatMap((m) =>
      m.id === null ? [] : [{ id: m.id, seq: m.seq!, status: m.status!, region: m.region!, hostId: m.hostId!, playedAt: m.playedAt!, lineCount: m.lineCount! }],
    ),
  };
}

/**
 * The oldest matches queued for a recount (`match_stats_recount`: player merges and undos), at
 * most `limit`, with the queue rows read: the sync deletes those.
 */
export async function readRecountQueue(db: D1Database, limit: number): Promise<{ rows: number[]; matches: FeedMatch[] }> {
  if (limit <= 0) return { rows: [], matches: [] };
  const { results } = await db
    .prepare(
      `SELECT q.id AS row, m.id, m.feed_seq AS seq, m.status, m.region, m.host_id AS hostId, m.played_at AS playedAt,
         m.line_count AS lineCount
       FROM (SELECT id, match_id FROM match_stats_recount ORDER BY id LIMIT ?1) q LEFT JOIN matches m ON m.id = q.match_id
       ORDER BY q.id`,
    )
    .bind(limit)
    .all<{ row: number } & { [K in keyof FeedMatch]: FeedMatch[K] | null }>();
  const matches = new Map<number, FeedMatch>();
  for (const m of results) {
    if (m.id !== null) matches.set(m.id, { id: m.id, seq: m.seq ?? 0, status: m.status!, region: m.region!, hostId: m.hostId!, playedAt: m.playedAt!, lineCount: m.lineCount! });
  }
  return { rows: results.map((r) => r.row), matches: [...matches.values()] };
}

/** Queues these matches' stats for a recount: the matches `playerId` is in. For a merge's batch. */
export function queueRecountStatement(db: D1Database, playerId: number): D1PreparedStatement {
  return db
    .prepare("INSERT INTO match_stats_recount (match_id) SELECT DISTINCT match_id FROM match_players WHERE player_id = ?1")
    .bind(playerId);
}

/**
 * Every region's records are urgent: rebuilt at the next cron run, and checked at view time until
 * then. For a merge's batch: a record may name the merged player, or count them apart.
 */
export function recordsUrgentStatement(db: D1Database): D1PreparedStatement {
  return db.prepare("UPDATE records_revisions SET revision = revision + 1, urgent = revision + 1");
}

/**
 * What `matchStats` needs of these matches, counted by D1: about one row read per event and round.
 * A bot (`players.bot`) holds no record: its deflects and kills, and kills of it, aren't counted.
 */
export async function readMatchCounts(db: D1Database, matchIds: readonly number[]): Promise<MatchCounts> {
  if (!matchIds.length) return { deflects: [], kills: [], wins: [], ratedRounds: [], players: [] };
  const ids = "SELECT value FROM json_each(?1)";
  const [deflects, kills, wins, players] = await db.batch([
    db
      .prepare(
        `SELECT e.match_id AS matchId, e.round, e.actor_id AS logId, COUNT(*) AS count, max(e.speed) AS fastest FROM events e
         WHERE e.match_id IN (${ids}) AND e.type = 'DEFLECT' AND e.actor_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM match_players mp JOIN players p ON p.id = mp.player_id
             WHERE mp.match_id = e.match_id AND mp.log_id = e.actor_id AND p.bot = 1)
         GROUP BY e.match_id, e.round, e.actor_id`,
      )
      .bind(JSON.stringify(matchIds)),
    db
      .prepare(
        `SELECT e.match_id AS matchId, e.actor_id AS logId, COUNT(*) AS count FROM events e
         WHERE e.match_id IN (${ids}) AND e.type = 'KILL' AND e.actor_id IS NOT NULL AND e.actor_id IS NOT e.target_id
           AND NOT EXISTS (SELECT 1 FROM match_players mp JOIN players p ON p.id = mp.player_id
             WHERE mp.match_id = e.match_id AND mp.log_id IN (e.actor_id, e.target_id) AND p.bot = 1)
         GROUP BY e.match_id, e.actor_id`,
      )
      .bind(JSON.stringify(matchIds)),
    db
      .prepare(
        `SELECT match_id AS matchId, winner_id AS logId, COUNT(*) AS count FROM rounds
         WHERE match_id IN (${ids}) AND rated = 1 GROUP BY match_id, winner_id`,
      )
      .bind(JSON.stringify(matchIds)),
    db
      .prepare(
        `SELECT mp.match_id AS matchId, mp.log_id AS logId, mp.player_id AS playerId, p.bot FROM match_players mp
         JOIN players p ON p.id = mp.player_id WHERE mp.match_id IN (${ids})`,
      )
      .bind(JSON.stringify(matchIds)),
  ]);
  const winRows = wins!.results as { matchId: number; logId: number | null; count: number }[];
  const rated = new Map<number, number>();
  for (const w of winRows) rated.set(w.matchId, (rated.get(w.matchId) ?? 0) + w.count);
  return {
    deflects: deflects!.results as MatchCounts["deflects"],
    kills: kills!.results as MatchCounts["kills"],
    wins: winRows.filter((w): w is MatchCounts["wins"][number] => w.logId !== null),
    ratedRounds: [...rated].map(([matchId, count]) => ({ matchId, count })),
    players: players!.results as MatchCounts["players"],
  };
}

/**
 * Writes what the cron read from the feed, in one batch (a transaction). The first statement moves
 * the cursor from where it was read, and fails the whole batch (NOT NULL) if another run moved it
 * meanwhile: nothing of this run is written. Stats are written only for matches that are still
 * accepted with the same copy, in their region now; any other changed match loses its row; the
 * regions touched get a new revision.
 */
export function syncStatements(
  db: D1Database,
  from: number,
  to: number,
  changed: readonly number[],
  stats: readonly MatchStatsRow[],
  regions: readonly string[],
  queueRows: readonly number[] = [],
): D1PreparedStatement[] {
  const statements = [
    db.prepare("UPDATE records_state SET feed_cursor = CASE WHEN feed_cursor = ?1 THEN ?2 END WHERE id = 1").bind(from, to),
    db.prepare("DELETE FROM match_stats_recount WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(queueRows)),
    db
      .prepare(
        `DELETE FROM match_stats WHERE match_id IN (SELECT value FROM json_each(?1))
         AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = match_stats.match_id AND m.status = 'accepted')`,
      )
      .bind(JSON.stringify(changed)),
  ];
  if (stats.length) {
    const columns: [string, keyof MatchStatsRow][] = [
      ["rated_rounds", "ratedRounds"],
      ["players", "players"],
      ["round_deflects", "roundDeflects"],
      ["round_deflects_by", "roundDeflectsBy"],
      ["round_deflects_round", "roundDeflectsRound"],
      ["fastest_deflect", "fastestDeflect"],
      ["fastest_deflect_by", "fastestDeflectBy"],
      ["fastest_deflect_round", "fastestDeflectRound"],
      ["match_kills", "matchKills"],
      ["match_kills_by", "matchKillsBy"],
      ["match_wins", "matchWins"],
      ["match_wins_by", "matchWinsBy"],
    ];
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO match_stats (match_id, region, line_count, host_id, played_at, ${columns.map(([c]) => c).join(", ")})
           SELECT m.id, m.region, m.line_count, m.host_id, m.played_at, ${columns.map(([, k]) => `e.value ->> '${k}'`).join(", ")}
           FROM json_each(?1) e JOIN matches m ON m.id = e.value ->> 'matchId'
           WHERE m.status = 'accepted' AND m.line_count = e.value ->> 'lineCount'`,
        )
        .bind(JSON.stringify(stats)),
    );
  }
  // The regions read, and where the changed matches are now.
  const touched = "SELECT value FROM json_each(?1) UNION SELECT region FROM matches WHERE id IN (SELECT value FROM json_each(?2))";
  statements.push(
    db.prepare(`INSERT OR IGNORE INTO records_revisions (region) ${touched}`).bind(JSON.stringify(regions), JSON.stringify(changed)),
    db.prepare(`UPDATE records_revisions SET revision = revision + 1 WHERE region IN (${touched})`).bind(JSON.stringify(regions), JSON.stringify(changed)),
  );
  return statements;
}

/** The error a sync batch fails with when another run moved the cursor first. */
export function isCursorConflict(error: unknown): boolean {
  return String(error).includes("NOT NULL constraint failed: records_state.feed_cursor");
}

export interface RecordsState {
  region: string;
  /** The region's `rating_state.version` now. */
  version: number;
  /** The region's records revision now, and the one at which a match last left its records. */
  revision: number;
  urgent: number;
  refreshedAt: string | null;
  /** The revision and rating version the stored records were made from. */
  builtRevision: number | null;
  ratingVersion: number | null;
}

/** Each region's stored records and rating version, in one query. */
export async function readRecordsState(db: D1Database, regions: readonly string[]): Promise<RecordsState[]> {
  const { results } = await db
    .prepare(
      `SELECT j.value AS region, coalesce((SELECT version FROM rating_state WHERE board = j.value), 0) AS version,
         coalesce(v.revision, 0) AS revision, coalesce(v.urgent, 0) AS urgent,
         r.refreshed_at AS refreshedAt, r.revision AS builtRevision, r.rating_version AS ratingVersion
       FROM json_each(?1) j LEFT JOIN records_revisions v ON v.region = j.value LEFT JOIN records r ON r.region = j.value
       ORDER BY j.key`,
    )
    .bind(JSON.stringify(regions))
    .all<RecordsState>();
  return results;
}

/** The rows of an ordered subquery selecting `x` (a JSON object) as one JSON array. */
const jsonRows = (subquery: string) => `(SELECT json_group_array(json(x)) FROM (${subquery}))`;

/**
 * A match record's best matches: the top `?6` (`recordsTopScan`) of its `match_stats` index, each
 * player looked up by log id. Only a match with `?3` players and `?4` rated rounds
 * (`recordsMinPlayers`, `recordsMinRatedRounds`) sets one. `month`: only matches since `?5`, read
 * by date (this month's matches) rather than down the record's index.
 */
function matchRecords(column: string, round: string | null, month: boolean): string {
  return jsonRows(`SELECT json_object('value', s.${column}, 'round', ${round ? `s.${round}` : "NULL"}, 'matchId', s.match_id,
      'playedAt', s.played_at, 'playerId', mp.player_id, 'name', p.name) AS x
    FROM match_stats s ${month ? "INDEXED BY match_stats_played" : ""} JOIN matches m ON m.id = s.match_id
      JOIN match_players mp ON mp.match_id = s.match_id AND mp.log_id = s.${column}_by JOIN players p ON p.id = mp.player_id
    WHERE s.region = ?1 AND ${counted} AND s.${column} IS NOT NULL AND s.players >= ?3 AND s.rated_rounds >= ?4
      ${month ? "AND s.played_at >= ?5" : ""}
    ORDER BY s.${column} DESC, s.played_at, s.match_id LIMIT ?6`);
}

/**
 * The highest ratings reached in matches since `since` ('' for all time): `rating_history` rows from
 * the top down to the `?7`-th (`recordsTop`) best current rating of the players who played since
 * then, at most `?8` (`recordsRatingScan`). Each of those players has a row at least that high.
 */
function ratingRecords(since: string): string {
  return jsonRows(`SELECT json_object('value', h.display, 'matchId', h.match_id, 'playedAt', h.played_at, 'playerId', h.player_id, 'name', p.name) AS x
    FROM rating_history h JOIN matches m ON m.id = h.match_id JOIN players p ON p.id = h.player_id
    WHERE h.board = ?1 AND m.status = 'accepted' AND m.region = ?1 AND h.played_at >= ${since}
      AND h.display >= coalesce((SELECT display FROM ratings WHERE board = ?1 AND last_played_at >= ${since}
        ORDER BY display DESC LIMIT 1 OFFSET ?7 - 1), -1e308)
    ORDER BY h.display DESC, h.played_at, h.match_id LIMIT ?8`);
}

/** A career record: the region's best `?7` (`recordsTop`) `ratings` rows for the column (one read per rated player). */
function careerRecords(column: string): string {
  return jsonRows(`SELECT json_object('value', r.${column}, 'playerId', r.player_id, 'name', p.name) AS x
    FROM ratings r JOIN players p ON p.id = r.player_id
    WHERE r.board = ?1 AND r.${column} > 0 ORDER BY r.${column} DESC, r.player_id LIMIT ?7`);
}

type RawRecord = { value: number; round: number | null; matchId: number; playedAt: string; playerId: number; name: string };

/** A JSON array of raw records, in the query's order (best first; sorted again, as the aggregate's order isn't promised). */
function rawRecords(json: string | null | undefined, order: (a: RawRecord, b: RawRecord) => number): RawRecord[] {
  return (JSON.parse(json ?? "[]") as RawRecord[]).sort(order);
}

const byMatch = (a: RawRecord, b: RawRecord) => b.value - a.value || a.playedAt.localeCompare(b.playedAt) || a.matchId - b.matchId;

function toMatchRecords(json: string | null | undefined, withRound: boolean, top: number): MatchRecord[] {
  const records = rawRecords(json, byMatch).map((r) => ({
    value: r.value,
    player: { id: r.playerId, name: r.name },
    matchId: r.matchId,
    playedAt: r.playedAt,
    ...(withRound ? { round: r.round } : {}),
  }));
  return distinctHolders(records, top);
}

function toCareerRecords(json: string | null | undefined, top: number): CareerRecord[] {
  const records = rawRecords(json, (a, b) => b.value - a.value || a.playerId - b.playerId);
  return records.slice(0, top).map((r) => ({ value: r.value, player: { id: r.playerId, name: r.name } }));
}

/**
 * Everything the records page shows, for one region: the records (all time and since the month
 * started), the climbers, the activity since `since` (a UTC date; bots aren't players) and the top
 * hosts. Four queries, in one batch. Only matches accepted in the region now count.
 */
export async function readRecordsInput(
  db: D1Database,
  region: string,
  since: string,
  now: Date,
  config: Pick<
    RecordsConfig,
    | "recordsTopHosts"
    | "recordsMinPlayers"
    | "recordsMinRatedRounds"
    | "recordsTop"
    | "recordsTopScan"
    | "recordsRatingScan"
    | "recordsClimbers"
    | "leaderboardChangeDays"
    | "minRankedRounds"
  >,
): Promise<RecordsInput> {
  const changeSince = isoSeconds(new Date(now.getTime() - config.leaderboardChangeDays * dayMs));
  const [records, days, hosts, climbers] = await db.batch([
    db
      .prepare(
        `SELECT ${matchRecords("round_deflects", "round_deflects_round", false)} AS roundDeflects,
           ${matchRecords("fastest_deflect", "fastest_deflect_round", false)} AS fastestDeflect,
           ${matchRecords("match_kills", null, false)} AS matchKills,
           ${matchRecords("match_wins", null, false)} AS matchWins,
           ${ratingRecords("''")} AS highestRating,
           ${careerRecords("best_streak")} AS winStreak,
           ${careerRecords("rounds")} AS mostRounds,
           ${careerRecords("wins")} AS mostWins,
           ${matchRecords("round_deflects", "round_deflects_round", true)} AS monthRoundDeflects,
           ${matchRecords("fastest_deflect", "fastest_deflect_round", true)} AS monthFastestDeflect,
           ${matchRecords("match_kills", null, true)} AS monthMatchKills,
           ${matchRecords("match_wins", null, true)} AS monthMatchWins,
           ${ratingRecords("?5")} AS monthHighestRating,
           (SELECT COUNT(DISTINCT mp.player_id) FROM match_stats s JOIN matches m ON m.id = s.match_id
              JOIN match_players mp ON mp.match_id = s.match_id JOIN players p ON p.id = mp.player_id
            WHERE s.region = ?1 AND ${counted} AND s.played_at >= ?2 AND p.bot = 0) AS players`,
      )
      .bind(
        region,
        since,
        config.recordsMinPlayers,
        config.recordsMinRatedRounds,
        monthStart(now),
        config.recordsTopScan,
        config.recordsTop,
        config.recordsRatingScan,
      ),
    db
      .prepare(
        `WITH days AS (
           SELECT substr(s.played_at, 1, 10) AS date, COUNT(*) AS matches, SUM(s.rated_rounds) AS rounds
           FROM match_stats s JOIN matches m ON m.id = s.match_id
           WHERE s.region = ?1 AND ${counted} AND s.played_at >= ?2 GROUP BY 1)
         SELECT d.date, d.matches, d.rounds,
           (SELECT COUNT(DISTINCT mp.player_id) FROM match_stats s JOIN matches m ON m.id = s.match_id
              JOIN match_players mp ON mp.match_id = s.match_id JOIN players p ON p.id = mp.player_id
            WHERE s.region = ?1 AND ${counted} AND s.played_at >= d.date AND s.played_at < date(d.date, '+1 day') AND p.bot = 0) AS players
         FROM days d`,
      )
      .bind(region, since),
    // Counted first, then only the top hosts' names are read.
    db
      .prepare(
        `SELECT h.name, c.matches FROM (
           SELECT s.host_id, COUNT(*) AS matches FROM match_stats s JOIN matches m ON m.id = s.match_id
           WHERE s.region = ?1 AND ${counted}
           GROUP BY s.host_id ORDER BY matches DESC, s.host_id LIMIT ?2) c
         JOIN hosts h ON h.id = c.host_id ORDER BY c.matches DESC, c.host_id`,
      )
      .bind(region, config.recordsTopHosts),
    // Who gained most since `changeSince`, as the leaderboard counts it: a player new since then has no change.
    db
      .prepare(
        `SELECT c.playerId, p.name, c.rating, c.rating - c.before AS change FROM (
           SELECT r.player_id AS playerId, r.display AS rating,
             (SELECT h.display FROM rating_history h WHERE h.board = r.board AND h.player_id = r.player_id AND h.played_at < ?2
              ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS before
           FROM ratings r WHERE r.board = ?1 AND r.last_played_at >= ?2 AND r.rounds >= ?3) c
         JOIN players p ON p.id = c.playerId
         WHERE p.alt = 0 AND c.rating - c.before >= 0.5 ORDER BY change DESC, c.playerId LIMIT ?4`,
      )
      .bind(region, changeSince, config.minRankedRounds, config.recordsClimbers),
  ]);
  const row = records!.results[0] as Record<string, string | null> & { players: number };
  const top = config.recordsTop;
  return {
    records: {
      roundDeflects: toMatchRecords(row.roundDeflects, true, top),
      fastestDeflect: toMatchRecords(row.fastestDeflect, true, top),
      matchKills: toMatchRecords(row.matchKills, false, top),
      matchWins: toMatchRecords(row.matchWins, false, top),
      highestRating: toMatchRecords(row.highestRating, false, top),
      winStreak: toCareerRecords(row.winStreak, top),
      mostRounds: toCareerRecords(row.mostRounds, top),
      mostWins: toCareerRecords(row.mostWins, top),
    },
    month: {
      roundDeflects: toMatchRecords(row.monthRoundDeflects, true, top),
      fastestDeflect: toMatchRecords(row.monthFastestDeflect, true, top),
      matchKills: toMatchRecords(row.monthMatchKills, false, top),
      matchWins: toMatchRecords(row.monthMatchWins, false, top),
      highestRating: toMatchRecords(row.monthHighestRating, false, top),
    },
    climbers: (climbers!.results as { playerId: number; name: string; rating: number; change: number }[]).map((c) => ({
      player: { id: c.playerId, name: c.name },
      rating: Math.round(c.rating),
      change: Math.round(c.change),
    })),
    days: days!.results as RecordsInput["days"],
    players: row.players,
    topHosts: hosts!.results as RecordsInput["topHosts"],
  };
}

/**
 * Stores a region's rebuilt page, made from `revision`. A run that read an older revision than the
 * stored page's (two runs at once) writes nothing.
 */
export function writeRecordsStatement(
  db: D1Database,
  region: string,
  body: RecordsBody,
  refreshedAt: string,
  revision: number,
  ratingVersion: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO records (region, body, refreshed_at, revision, rating_version) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (region) DO UPDATE SET body = excluded.body, refreshed_at = excluded.refreshed_at,
         revision = excluded.revision, rating_version = excluded.rating_version
       WHERE excluded.revision >= records.revision`,
    )
    .bind(region, JSON.stringify(body), refreshedAt, revision, ratingVersion);
}

/**
 * The region's stored records page, or null before the cron first made it. When a match left the
 * region's records since it was made, the match records are checked against the matches now (one
 * more query, at most 5 rows), so a match that isn't public there any more is never named.
 */
export async function readRecords(db: D1Database, region: string): Promise<{ body: RecordsBody; refreshedAt: string } | null> {
  const row = await db
    .prepare(
      `SELECT r.body, r.refreshed_at AS refreshedAt, r.revision < coalesce(v.urgent, 0) AS outdated
       FROM records r LEFT JOIN records_revisions v ON v.region = r.region WHERE r.region = ?`,
    )
    .bind(region)
    .first<{ body: string; refreshedAt: string; outdated: number }>();
  if (!row) return null;
  const body = JSON.parse(row.body) as RecordsBody;
  // A page stored before the records had top lists (no `month`) waits for its rebuild (migration 0027).
  if (!("month" in body)) return null;
  if (row.outdated !== 1) return { body, refreshedAt: row.refreshedAt };
  const ids = recordMatchIds(body);
  const holders = recordPlayerIds(body);
  const [publicMatches, players] = await db.batch([
    db.prepare(`SELECT m.id FROM matches m WHERE m.id IN (SELECT value FROM json_each(?2)) AND ${counted}`).bind(region, JSON.stringify(ids)),
    // Each holder's player now: the end of their merge chain (#8).
    db
      .prepare(
        `WITH RECURSIVE chain(start, id, merged_into) AS (
           SELECT id, id, merged_into FROM players WHERE id IN (SELECT value FROM json_each(?1))
           UNION
           SELECT c.start, p.id, p.merged_into FROM players p JOIN chain c ON p.id = c.merged_into
         ) SELECT c.start, c.id, p.name FROM chain c JOIN players p ON p.id = c.id WHERE c.merged_into IS NULL`,
      )
      .bind(JSON.stringify(holders)),
  ]);
  const current = new Map((players!.results as { start: number; id: number; name: string }[]).map((p) => [p.start, { id: p.id, name: p.name }]));
  const shown = withoutMatches(body, new Set((publicMatches!.results as { id: number }[]).map((r) => r.id)));
  return { body: withPlayers(shown, current), refreshedAt: row.refreshedAt };
}
