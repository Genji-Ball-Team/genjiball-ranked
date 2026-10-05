import { staleFromMatchesStatement } from "../rating/store";
import type { HostTrust, MatchPlan, MatchRows, MatchStatus, StoredCopy } from "./plan";

/**
 * The upload endpoint's D1 queries. Writes go in one `db.batch` (a transaction) with a fixed number
 * of statements, each table's rows inserted from a JSON parameter (docs/database.md).
 */

export interface Host {
  id: number;
  name: string;
  trust: HostTrust;
  /** The home region an admin set (#47): uploads without `X-Region` are played there. */
  region: string | null;
}

export async function findHost(db: D1Database, tokenHash: string): Promise<Host | null> {
  return db.prepare("SELECT id, name, trust, region FROM hosts WHERE token_hash = ?").bind(tokenHash).first<Host>();
}

/** Uploads stored for the host since `since` (ISO), for the rate limit. */
export async function countRecentUploads(db: D1Database, hostId: number, since: string): Promise<number> {
  const row = await db
    .prepare("SELECT count(*) AS n FROM uploads WHERE host_id = ? AND received_at > ?")
    .bind(hostId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function findUploadByHash(db: D1Database, contentHash: string): Promise<{ id: number } | null> {
  return db.prepare("SELECT id FROM uploads WHERE content_hash = ?").bind(contentHash).first<{ id: number }>();
}

/** The stored copies of these matches, for the host. */
export async function findStoredCopies(db: D1Database, hostId: number, matchKeys: string[]): Promise<StoredCopy[]> {
  if (!matchKeys.length) return [];
  const { results } = await db
    .prepare(
      `SELECT id, match_key AS matchKey, line_count AS lineCount, status, upload_id AS uploadId, region,
         rejection_code AS rejectionCode, rejection_message AS rejectionMessage
       FROM matches WHERE host_id = ?1 AND match_key IN (SELECT value FROM json_each(?2))`,
    )
    .bind(hostId, JSON.stringify(matchKeys))
    .all<Omit<StoredCopy, "rejection"> & { status: MatchStatus; rejectionCode: string | null; rejectionMessage: string | null }>();
  return results.map(({ rejectionCode, rejectionMessage, ...copy }) => ({
    ...copy,
    rejection: rejectionCode === null ? null : { code: rejectionCode, message: rejectionMessage ?? "" },
  }));
}

export interface MatchState {
  matchKey: string;
  /** The match page is `/match?id=<matchId>`. A longer copy keeps the id. */
  matchId: number;
  status: MatchStatus;
  rejection: { code: string; message: string } | null;
  reviewReasons: string[];
}

/** The status now of the host's matches with these keys. Unknown keys are left out. */
export async function findMatchStates(db: D1Database, hostId: number, matchKeys: string[]): Promise<MatchState[]> {
  if (!matchKeys.length) return [];
  const { results } = await db
    .prepare(
      `SELECT match_key AS matchKey, id AS matchId, status, rejection_code AS rejectionCode,
         rejection_message AS rejectionMessage, review_reasons AS reviewReasons
       FROM matches WHERE host_id = ?1 AND match_key IN (SELECT value FROM json_each(?2))`,
    )
    .bind(hostId, JSON.stringify(matchKeys))
    .all<{ matchKey: string; matchId: number; status: MatchStatus; rejectionCode: string | null; rejectionMessage: string | null; reviewReasons: string | null }>();
  return results.map(({ rejectionCode, rejectionMessage, reviewReasons, ...state }) => ({
    ...state,
    rejection: rejectionCode === null ? null : { code: rejectionCode, message: rejectionMessage ?? "" },
    reviewReasons: reviewReasons ? reviewReasons.split(",") : [],
  }));
}

export interface UploadWrite {
  hostId: number;
  /** The region new matches are stored in. A longer copy keeps the stored match's. */
  region: string;
  contentHash: string;
  /** gzip of the raw text. */
  rawLog: Uint8Array;
  rawSize: number;
  fileName: string | null;
  playedAt: string;
  now: string;
  plans: MatchPlan[];
  rows: MatchRows;
  chunkRows: number;
  /** More statements for the same transaction. */
  extra?: D1PreparedStatement[];
}

/** Writes the upload and its matches in one transaction, including review after resolving aliases. */
export async function writeUpload(db: D1Database, w: UploadWrite): Promise<{ uploadId: number; reviews: { matchKey: string; reviewReasons: string[] }[] }> {
  const json = (value: unknown) => JSON.stringify(value);
  const uploadId = "(SELECT id FROM uploads WHERE content_hash = ?2)";
  // CROSS JOIN keeps json_each the outer loop: SQLite has no row count for it, and with a plain JOIN
  // it may loop over every stored match (and its rounds and players) and scan the JSON for each,
  // which grows with the database until D1 runs out of CPU time.
  const matchJoin = "CROSS JOIN matches m ON m.host_id = ?2 AND m.match_key = e.value ->> 'matchKey'";

  const replacedIds = w.rows.replaced.flatMap((m) => (m.id === null ? [] : [m.id]));
  const repointIds = w.plans.filter((p) => p.action === "repoint").map((p) => p.storedId);
  const oldUploadIds = w.plans
    .filter((p) => p.action === "replace" || p.action === "repoint")
    .map((p) => p.storedUploadId);

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO uploads (host_id, content_hash, raw_log, raw_size, file_name, received_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'parsed') RETURNING id",
      )
      .bind(w.hostId, w.contentHash, w.rawLog, w.rawSize, w.fileName, w.now),

    // Players: a name seen for the first time is a new player with that name as their alias. Every
    // player who isn't merged into another (#8) has at least one alias, so the players without one
    // are the ones just inserted.
    db
      .prepare(
        `INSERT INTO players (name, created_at)
         SELECT e.value ->> 'name', ?2 FROM json_each(?1) e
         WHERE NOT EXISTS (SELECT 1 FROM aliases a WHERE a.name_key = e.value ->> 'key')`,
      )
      .bind(json(w.rows.names), w.now),
    db
      .prepare(
        `INSERT INTO aliases (player_id, name, name_key, first_seen_at, last_seen_at)
         SELECT p.id, p.name, e.value ->> 'key', ?2, ?2
         FROM players p JOIN json_each(?1) e ON e.value ->> 'name' = p.name
         WHERE p.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM aliases a WHERE a.player_id = p.id)`,
      )
      .bind(json(w.rows.names), w.playedAt),
    // Known names: last seen, and the spelling seen most recently becomes the display name, unless
    // an admin set the name (`name_fixed`).
    db
      .prepare(
        `UPDATE aliases SET name = e.value ->> 'name', last_seen_at = ?2
         FROM json_each(?1) e WHERE aliases.name_key = e.value ->> 'key' AND aliases.last_seen_at <= ?2`,
      )
      .bind(json(w.rows.names), w.playedAt),
    db
      .prepare(
        `UPDATE players SET name = (SELECT a.name FROM aliases a WHERE a.player_id = players.id
           ORDER BY a.last_seen_at DESC, a.id DESC LIMIT 1)
         WHERE players.name_fixed = 0 AND players.id IN
           (SELECT a.player_id FROM json_each(?1) e CROSS JOIN aliases a ON a.name_key = e.value ->> 'key')`,
      )
      .bind(json(w.rows.names)),

    // A longer copy replaces a match's rows under the same match id.
    db
      .prepare(
        `DELETE FROM round_players WHERE round_id IN
         (SELECT id FROM rounds WHERE match_id IN (SELECT value FROM json_each(?1)))`,
      )
      .bind(json(replacedIds)),
    ...["rounds", "match_players", "events"].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE match_id IN (SELECT value FROM json_each(?1))`).bind(json(replacedIds)),
    ),
    // A longer log changes the standings the screenshot was checked against, at the same match id.
    db.prepare(
      `UPDATE tourney_lobbies SET verified_by = NULL, verified_at = NULL, version = version + 1
       WHERE match_id IN (SELECT value FROM json_each(?))`,
    ).bind(json(replacedIds)),
    db
      .prepare(
        `UPDATE matches SET upload_id = ${uploadId}, line_count = e.value ->> 'lineCount', format = e.value ->> 'format',
           game_version = e.value ->> 'gameVersion', status = e.value ->> 'status',
           rejection_code = e.value ->> 'rejectionCode', rejection_message = e.value ->> 'rejectionMessage',
           review_reasons = e.value ->> 'reviewReasons', unranked = e.value ->> 'unranked',
           map = e.value ->> 'map', preset = e.value ->> 'preset',
           played_at = min(matches.played_at, e.value ->> 'playedAt'), complete = e.value ->> 'complete'
         FROM json_each(?1) e WHERE matches.id = e.value ->> 'id'`,
      )
      .bind(json(w.rows.replaced), w.contentHash),
    // A rated match whose rounds just changed: the ratings are stale from it (docs/rating.md).
    staleFromMatchesStatement(db, replacedIds, w.now, true),
    db
      .prepare(`UPDATE matches SET upload_id = ${uploadId} WHERE id IN (SELECT value FROM json_each(?1))`)
      .bind(json(repointIds), w.contentHash),
    db
      .prepare(
        `INSERT INTO matches (upload_id, host_id, match_key, line_count, format, game_version, legacy, status, rejection_code,
           rejection_message, review_reasons, unranked, map, preset, played_at, complete, region)
         SELECT ${uploadId.replace("?2", "?3")}, ?2, e.value ->> 'matchKey', e.value ->> 'lineCount', e.value ->> 'format',
           e.value ->> 'gameVersion', e.value ->> 'legacy', e.value ->> 'status', e.value ->> 'rejectionCode', e.value ->> 'rejectionMessage',
           e.value ->> 'reviewReasons', e.value ->> 'unranked', e.value ->> 'map', e.value ->> 'preset',
           e.value ->> 'playedAt', e.value ->> 'complete', ?4
         FROM json_each(?1) e`,
      )
      .bind(json(w.rows.inserted), w.hostId, w.contentHash, w.region),

    ...chunks(w.rows.players, w.chunkRows).map((rows) =>
      db
        .prepare(
          `INSERT INTO match_players (match_id, log_id, player_id, alias_id, name, join_time, leave_time)
           SELECT m.id, e.value ->> 'logId', a.player_id, a.id, e.value ->> 'name', e.value ->> 'joinTime', e.value ->> 'leaveTime'
           FROM json_each(?1) e ${matchJoin}
           CROSS JOIN aliases a ON a.name_key = e.value ->> 'key'`,
        )
        .bind(json(rows), w.hostId),
    ),
    ...chunks(w.rows.rounds, w.chunkRows).map((rows) =>
      db
        .prepare(
          `INSERT INTO rounds (match_id, number, result, winner_id, start_time, end_time, rated, broken)
           SELECT m.id, e.value ->> 'number', e.value ->> 'result', e.value ->> 'winnerId', e.value ->> 'startTime',
             e.value ->> 'endTime', e.value ->> 'rated', e.value ->> 'broken'
           FROM json_each(?1) e ${matchJoin}`,
        )
        .bind(json(rows), w.hostId),
    ),
    ...chunks(w.rows.roundPlayers, w.chunkRows).map((rows) =>
      db
        .prepare(
          `INSERT INTO round_players (round_id, log_id, player_id, position, place, left_round, killer_id)
           SELECT r.id, e.value ->> 'logId', mp.player_id, e.value ->> 'position', e.value ->> 'place',
             e.value ->> 'leftRound', e.value ->> 'killerId'
           FROM json_each(?1) e ${matchJoin}
           CROSS JOIN rounds r ON r.match_id = m.id AND r.number = e.value ->> 'round'
           CROSS JOIN match_players mp ON mp.match_id = m.id AND mp.log_id = e.value ->> 'logId'`,
        )
        .bind(json(rows), w.hostId),
    ),
    ...chunks(w.rows.events, w.chunkRows).map((rows) =>
      db
        .prepare(
          `INSERT INTO events (match_id, seq, type, round, time, actor_id, target_id, speed)
           SELECT m.id, e.value ->> 'seq', e.value ->> 'type', e.value ->> 'round', e.value ->> 'time',
             e.value ->> 'actor', e.value ->> 'target', e.value ->> 'speed'
           FROM json_each(?1) e ${matchJoin}`,
        )
        .bind(json(rows), w.hostId),
    ),

    // The older file of a replaced or repointed match goes once no match is in it any more: a
    // shorter copy is always the start of the longer one, so nothing is lost.
    db
      .prepare(
        `DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?1)) AND id != ${uploadId}
         AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.upload_id = uploads.id)`,
      )
      .bind(json(oldUploadIds), w.contentHash),
    db.prepare("UPDATE hosts SET last_upload_at = ?2 WHERE id = ?1").bind(w.hostId, w.now),
    ...(w.extra ?? []),
  ];

  // Check the resolved ids in this transaction: a concurrent merge may have changed the aliases
  // since parsing. Different aliases of one player in a round need review, like duplicate_name.
  const reviewIndex = statements.length;
  statements.push(
    db.prepare(
      `UPDATE matches SET status = 'review',
         review_reasons = CASE WHEN instr(',' || coalesce(review_reasons, '') || ',', ',merged_names,') > 0
           THEN review_reasons ELSE coalesce(review_reasons || ',', '') || 'merged_names' END
       WHERE host_id = ?1 AND match_key IN (SELECT value FROM json_each(?2)) AND status IN ('accepted', 'review')
         AND EXISTS (SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
           JOIN match_players mp ON mp.match_id = r.match_id AND mp.log_id = rp.log_id
           WHERE r.match_id = matches.id GROUP BY rp.round_id, rp.player_id HAVING COUNT(DISTINCT mp.alias_id) > 1)
       RETURNING match_key AS matchKey, review_reasons AS reviewReasons`,
    ).bind(w.hostId, json([...w.rows.inserted, ...w.rows.replaced].map((m) => m.matchKey))),
  );
  const results = await db.batch<{ id: number; matchKey: string; reviewReasons: string }>(statements);
  return {
    uploadId: results[0]!.results[0]!.id,
    reviews: results[reviewIndex]!.results.map((r) => ({ matchKey: r.matchKey, reviewReasons: r.reviewReasons.split(",") })),
  };
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
