import {
  matchRecordNames,
  withoutMatches,
  withPlayers,
  type CareerRecord,
  type FeedMatch,
  type MatchCounts,
  type MatchRecord,
  type MatchStatsRow,
  type Records,
  type RecordsBody,
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

const json = (value: unknown) => JSON.stringify(value);

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
      .bind(json(matchIds)),
    db
      .prepare(
        `SELECT e.match_id AS matchId, e.actor_id AS logId, COUNT(*) AS count FROM events e
         WHERE e.match_id IN (${ids}) AND e.type = 'KILL' AND e.actor_id IS NOT NULL AND e.actor_id IS NOT e.target_id
           AND NOT EXISTS (SELECT 1 FROM match_players mp JOIN players p ON p.id = mp.player_id
             WHERE mp.match_id = e.match_id AND mp.log_id IN (e.actor_id, e.target_id) AND p.bot = 1)
         GROUP BY e.match_id, e.actor_id`,
      )
      .bind(json(matchIds)),
    db
      .prepare(
        `SELECT match_id AS matchId, winner_id AS logId, COUNT(*) AS count FROM rounds
         WHERE match_id IN (${ids}) AND rated = 1 GROUP BY match_id, winner_id`,
      )
      .bind(json(matchIds)),
    db.prepare(`SELECT match_id AS matchId, log_id AS logId, player_id AS playerId FROM match_players WHERE match_id IN (${ids})`).bind(json(matchIds)),
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
    db.prepare("DELETE FROM match_stats_recount WHERE id IN (SELECT value FROM json_each(?1))").bind(json(queueRows)),
    db
      .prepare(
        `DELETE FROM match_stats WHERE match_id IN (SELECT value FROM json_each(?1))
         AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = match_stats.match_id AND m.status = 'accepted')`,
      )
      .bind(json(changed)),
  ];
  if (stats.length) {
    const columns: [string, keyof MatchStatsRow][] = [
      ["rated_rounds", "ratedRounds"],
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
        .bind(json(stats)),
    );
  }
  // The regions read, and where the changed matches are now.
  const touched = "SELECT value FROM json_each(?1) UNION SELECT region FROM matches WHERE id IN (SELECT value FROM json_each(?2))";
  statements.push(
    db.prepare(`INSERT OR IGNORE INTO records_revisions (region) ${touched}`).bind(json(regions), json(changed)),
    db.prepare(`UPDATE records_revisions SET revision = revision + 1 WHERE region IN (${touched})`).bind(json(regions), json(changed)),
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
    .bind(json(regions))
    .all<RecordsState>();
  return results;
}

/** A match record: the top of its `match_stats` index, its player looked up by log id. */
function matchRecord(column: string, round: string | null): string {
  return `(SELECT json_object('value', s.${column}, 'round', ${round ? `s.${round}` : "NULL"}, 'matchId', s.match_id,
      'playedAt', s.played_at, 'playerId', mp.player_id, 'name', p.name)
    FROM match_stats s JOIN matches m ON m.id = s.match_id
      JOIN match_players mp ON mp.match_id = s.match_id AND mp.log_id = s.${column}_by JOIN players p ON p.id = mp.player_id
    WHERE s.region = ?1 AND ${counted} AND s.${column} IS NOT NULL ORDER BY s.${column} DESC, s.played_at, s.match_id LIMIT 1)`;
}

/** A career record: the region's best `ratings` row for the column (one read per rated player). */
function careerRecord(column: string): string {
  return `(SELECT json_object('value', r.${column}, 'playerId', r.player_id, 'name', p.name)
    FROM ratings r JOIN players p ON p.id = r.player_id
    WHERE r.board = ?1 AND r.${column} > 0 ORDER BY r.${column} DESC, r.player_id LIMIT 1)`;
}

type RawRecord = { value: number; round: number | null; matchId: number; playedAt: string; playerId: number; name: string };

const toMatchRecord = (raw: string | null, withRound: boolean): MatchRecord | null => {
  if (raw === null) return null;
  const r = JSON.parse(raw) as RawRecord;
  return { value: r.value, player: { id: r.playerId, name: r.name }, matchId: r.matchId, playedAt: r.playedAt, ...(withRound ? { round: r.round } : {}) };
};

const toCareerRecord = (raw: string | null): CareerRecord | null => {
  if (raw === null) return null;
  const r = JSON.parse(raw) as RawRecord;
  return { value: r.value, player: { id: r.playerId, name: r.name } };
};

/**
 * Everything the records page shows, for one region: the records, the activity since `since` (a
 * UTC date; bots aren't players) and the top hosts. Three queries, in one batch. Only matches accepted in the region now count.
 */
export async function readRecordsInput(db: D1Database, region: string, since: string, topHosts: number): Promise<RecordsInput> {
  const [records, days, hosts] = await db.batch([
    db
      .prepare(
        `SELECT ${matchRecord("round_deflects", "round_deflects_round")} AS roundDeflects,
           ${matchRecord("fastest_deflect", "fastest_deflect_round")} AS fastestDeflect,
           ${matchRecord("match_kills", null)} AS matchKills,
           ${matchRecord("match_wins", null)} AS matchWins,
           (SELECT json_object('value', h.display, 'matchId', h.match_id, 'playedAt', h.played_at, 'playerId', h.player_id, 'name', p.name)
            FROM rating_history h JOIN matches m ON m.id = h.match_id JOIN players p ON p.id = h.player_id
            WHERE h.board = ?1 AND m.status = 'accepted' AND m.region = ?1
            ORDER BY h.display DESC, h.played_at, h.match_id LIMIT 1) AS highestRating,
           ${careerRecord("best_streak")} AS winStreak,
           ${careerRecord("rounds")} AS mostRounds,
           ${careerRecord("wins")} AS mostWins,
           (SELECT COUNT(DISTINCT mp.player_id) FROM match_stats s JOIN matches m ON m.id = s.match_id
              JOIN match_players mp ON mp.match_id = s.match_id JOIN players p ON p.id = mp.player_id
            WHERE s.region = ?1 AND ${counted} AND s.played_at >= ?2 AND p.bot = 0) AS players`,
      )
      .bind(region, since),
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
      .bind(region, topHosts),
  ]);
  const row = records!.results[0] as Record<keyof Records, string | null> & { players: number };
  return {
    records: {
      roundDeflects: toMatchRecord(row.roundDeflects, true),
      fastestDeflect: toMatchRecord(row.fastestDeflect, true),
      matchKills: toMatchRecord(row.matchKills, false),
      matchWins: toMatchRecord(row.matchWins, false),
      highestRating: toMatchRecord(row.highestRating, false),
      winStreak: toCareerRecord(row.winStreak),
      mostRounds: toCareerRecord(row.mostRounds),
      mostWins: toCareerRecord(row.mostWins),
    },
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
    .bind(region, json(body), refreshedAt, revision, ratingVersion);
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
  if (row.outdated !== 1) return { body, refreshedAt: row.refreshedAt };
  const ids = matchRecordNames.map((name) => body.records[name]?.matchId).filter((id): id is number => id !== undefined);
  const holders = Object.values(body.records).flatMap((record) => (record ? [record.player.id] : []));
  const [publicMatches, players] = await db.batch([
    db.prepare(`SELECT m.id FROM matches m WHERE m.id IN (SELECT value FROM json_each(?2)) AND ${counted}`).bind(region, json(ids)),
    // Each holder's player now: the end of their merge chain (#8).
    db
      .prepare(
        `WITH RECURSIVE chain(start, id, merged_into) AS (
           SELECT id, id, merged_into FROM players WHERE id IN (SELECT value FROM json_each(?1))
           UNION
           SELECT c.start, p.id, p.merged_into FROM players p JOIN chain c ON p.id = c.merged_into
         ) SELECT c.start, c.id, p.name FROM chain c JOIN players p ON p.id = c.id WHERE c.merged_into IS NULL`,
      )
      .bind(json([...new Set(holders)])),
  ]);
  const current = new Map((players!.results as { start: number; id: number; name: string }[]).map((p) => [p.start, { id: p.id, name: p.name }]));
  const shown = withoutMatches(body, new Set((publicMatches!.results as { id: number }[]).map((r) => r.id)));
  return { body: withPlayers(shown, current), refreshedAt: row.refreshedAt };
}
