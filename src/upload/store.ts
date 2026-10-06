import { staleFromMatchesStatement } from "../rating/store";
import { matchPairsInsert } from "./pairs";
import { nameKey, tourneyReasons, type HostTrust, type MatchPlan, type MatchRows, type MatchStatus, type StoredCopy, type UploadLobby } from "./plan";

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
         rejection_code AS rejectionCode, rejection_message AS rejectionMessage, host_afk AS hostAfk,
         (SELECT u.content_hash FROM uploads u WHERE u.id = matches.upload_id) AS uploadHash
       FROM matches WHERE host_id = ?1 AND match_key IN (SELECT value FROM json_each(?2))`,
    )
    .bind(hostId, JSON.stringify(matchKeys))
    .all<
      Omit<StoredCopy, "rejection" | "hostAfk"> & {
        status: MatchStatus;
        rejectionCode: string | null;
        rejectionMessage: string | null;
        hostAfk: string | null;
      }
    >();
  return results.map(({ rejectionCode, rejectionMessage, hostAfk, ...copy }) => ({
    ...copy,
    rejection: rejectionCode === null ? null : { code: rejectionCode, message: rejectionMessage ?? "" },
    hostAfk: hostAfk === null ? [] : (JSON.parse(hostAfk) as number[]),
  }));
}

/** A lobby as `findUploadLobbies` reads it: `roundLimit` is the lobby's own, `null` for `tourneyRoundLimit`. */
export type StoredLobby = Omit<UploadLobby, "roundLimit"> & { roundLimit: number | null };

/**
 * The tourney lobbies with these `lobbyKey`s (the file's `TOURNEY` lines) or linked to these stored
 * matches, with their tourney's region and status: one query, through the unique indexes on
 * `lobby_key` and `match_id`.
 */
export async function findUploadLobbies(db: D1Database, lobbyKeys: readonly string[], matchIds: readonly number[]): Promise<StoredLobby[]> {
  if (!lobbyKeys.length && !matchIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT l.id, l.lobby_key AS lobbyKey, l.host_id AS hostId, l.round_limit AS roundLimit, l.match_id AS matchId,
         t.region, t.status AS tourneyStatus
       FROM tourney_lobbies l JOIN tourneys t ON t.id = l.tourney_id
       WHERE l.lobby_key IN (SELECT value FROM json_each(?1)) OR l.match_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(JSON.stringify(lobbyKeys), JSON.stringify(matchIds))
    .all<StoredLobby>();
  return results;
}

/** The raw log of these uploads, gunzipped, by upload id: for a `refresh` from a stored copy. */
export async function findUploadLogs(db: D1Database, uploadIds: readonly number[]): Promise<Map<number, Uint8Array>> {
  const logs = new Map<number, Uint8Array>();
  if (!uploadIds.length) return logs;
  const { results } = await db
    .prepare("SELECT id, raw_log AS rawLog FROM uploads WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(uploadIds))
    .all<{ id: number; rawLog: ArrayBuffer | number[] }>();
  for (const row of results) {
    // D1 returns a BLOB as an array of byte values (docs/database.md).
    logs.set(row.id, await gunzip(new Uint8Array(row.rawLog)));
  }
  return logs;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
  /** Names of AI bots (`legacyBotNames`): a new player with one is marked `bot`. */
  botNames: readonly string[];
  /** Most bytes of JSON a bulk insert binds (`insertChunkBytes`). */
  chunkBytes: number;
  /** Most statements the batch may have: what's left of `queriesPerRequest`. */
  maxStatements: number;
  /** More statements for the same transaction. */
  extra?: D1PreparedStatement[];
}

/** The upload needs more statements than `maxStatements`: nothing was written. */
export class TooManyStatements extends Error {
  constructor(readonly statements: number) {
    super(`The upload needs ${statements} statements`);
  }
}

/**
 * Writes the upload and its matches in one transaction, including review after resolving aliases.
 * Returns the upload id (`null` when only `refresh`es were written: no file is stored), the matches sent to review, and how many statements (queries) it took;
 * throws `TooManyStatements`, writing nothing, past `maxStatements`.
 */
export async function writeUpload(
  db: D1Database,
  w: UploadWrite,
): Promise<{ uploadId: number | null; statements: number; reviews: { matchKey: string; reviewReasons: string[] }[] }> {
  const json = (value: unknown) => JSON.stringify(value);
  const uploadId = "(SELECT id FROM uploads WHERE content_hash = ?2)";
  // CROSS JOIN keeps json_each the outer loop: SQLite has no row count for it, and with a plain JOIN
  // it may loop over every stored match (and its rounds and players) and scan the JSON for each,
  // which grows with the database until D1 runs out of CPU time.
  const matchJoin = "CROSS JOIN matches m ON m.host_id = ?2 AND m.match_key = e.value ->> 'matchKey'";

  const replacedIds = w.rows.replaced.flatMap((m) => (m.id === null ? [] : [m.id]));
  // A `refresh` (new host AFK rounds) rewrites a stored match's rows from its own copy: the file
  // isn't stored for it, and a refresh alone stores no file at all.
  const refreshIds = w.plans.filter((p) => p.action === "refresh").map((p) => p.storedId);
  const newUpload = w.plans.some((p) => p.action === "insert" || p.action === "replace");
  const repointIds = newUpload ? w.plans.filter((p) => p.action === "repoint").map((p) => p.storedId) : [];
  const longerIds = w.plans.filter((p) => p.action === "replace").map((p) => p.storedId);
  const oldUploadIds = w.plans
    .filter((p) => p.action === "replace" || (newUpload && p.action === "repoint"))
    .map((p) => p.storedUploadId);
  // Tourney matches linked to their lobby (`tourneyCheck` in plan.ts), as an admin's link does.
  const links = w.plans.flatMap((p) => (p.lobbyId === null ? [] : [{ matchKey: p.matchKey, lobbyId: p.lobbyId }]));

  const statements: D1PreparedStatement[] = [
    ...(newUpload
      ? [
          db
            .prepare(
              "INSERT INTO uploads (host_id, content_hash, raw_log, raw_size, file_name, received_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'parsed') RETURNING id",
            )
            .bind(w.hostId, w.contentHash, w.rawLog, w.rawSize, w.fileName, w.now),
        ]
      : []),

    // Players: a name seen for the first time is a new player with that name as their alias. Every
    // player who isn't merged into another (#8) has at least one alias, so the players without one
    // are the ones just inserted. A bot's name makes a `bot` player, left out of head-to-head and records.
    db
      .prepare(
        `INSERT INTO players (name, created_at, bot)
         SELECT e.value ->> 'name', ?2, e.value ->> 'key' IN (SELECT value FROM json_each(?3)) FROM json_each(?1) e
         WHERE NOT EXISTS (SELECT 1 FROM aliases a WHERE a.name_key = e.value ->> 'key')`,
      )
      .bind(json(w.rows.names), w.now, json(w.botNames.map(nameKey))),
    db
      .prepare(
        `INSERT INTO aliases (player_id, name, name_key, first_seen_at, last_seen_at)
         SELECT p.id, p.name, e.value ->> 'key', ?2, ?2
         FROM players p JOIN json_each(?1) e ON e.value ->> 'name' = p.name
         WHERE p.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM aliases a WHERE a.player_id = p.id)`,
      )
      .bind(json(w.rows.names), w.playedAt),
    // Known names: last seen, and the spelling seen most recently becomes the display name, unless
    // an admin set the name (`name_fixed`). Not for a refresh's names: that match was seen before.
    db
      .prepare(
        `UPDATE aliases SET name = e.value ->> 'name', last_seen_at = ?2
         FROM json_each(?1) e WHERE aliases.name_key = e.value ->> 'key' AND aliases.last_seen_at <= ?2 AND e.value ->> 'seen' = 1`,
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
    // Deleting match_pairs takes them out of the head-to-head totals (a trigger, docs/database.md).
    ...["match_pairs", "rounds", "match_players", "events"].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE match_id IN (SELECT value FROM json_each(?1))`).bind(json(replacedIds)),
    ),
    // A longer log changes the standings the screenshot was checked against, at the same match id.
    // Host AFK changes only the rating, not the standings: a refresh keeps the verification.
    db.prepare(
      `UPDATE tourney_lobbies SET verified_by = NULL, verified_at = NULL, version = version + 1
       WHERE match_id IN (SELECT value FROM json_each(?))`,
    ).bind(json(longerIds)),
    db
      .prepare(
        `UPDATE matches SET upload_id = coalesce((SELECT u.id FROM uploads u WHERE u.content_hash = e.value ->> 'uploadHash'), ${uploadId}),
           host_afk = e.value ->> 'hostAfk', line_count = e.value ->> 'lineCount', format = e.value ->> 'format',
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
    // A refresh doesn't go through the match feed, which the records follow: queue its recount.
    db.prepare("INSERT INTO match_stats_recount (match_id) SELECT value FROM json_each(?1)").bind(json(refreshIds)),
    db
      .prepare(`UPDATE matches SET upload_id = ${uploadId} WHERE id IN (SELECT value FROM json_each(?1))`)
      .bind(json(repointIds), w.contentHash),
    db
      .prepare(
        `INSERT INTO matches (upload_id, host_id, match_key, line_count, format, game_version, legacy, status, rejection_code,
           rejection_message, review_reasons, unranked, map, preset, played_at, complete, region, host_afk)
         SELECT ${uploadId.replace("?2", "?3")}, ?2, e.value ->> 'matchKey', e.value ->> 'lineCount', e.value ->> 'format',
           e.value ->> 'gameVersion', e.value ->> 'legacy', e.value ->> 'status', e.value ->> 'rejectionCode', e.value ->> 'rejectionMessage',
           e.value ->> 'reviewReasons', e.value ->> 'unranked', e.value ->> 'map', e.value ->> 'preset',
           e.value ->> 'playedAt', e.value ->> 'complete', ?4, e.value ->> 'hostAfk'
         FROM json_each(?1) e`,
      )
      .bind(json(w.rows.inserted), w.hostId, w.contentHash, w.region),
    ...linkStatements(db, links, w.hostId),

    ...jsonChunks(w.rows.players, w.chunkBytes).map((rows) =>
      db
        .prepare(
          `INSERT INTO match_players (match_id, log_id, player_id, alias_id, name, join_time, leave_time, kills)
           SELECT m.id, e.value ->> 'logId', a.player_id, a.id, e.value ->> 'name', e.value ->> 'joinTime', e.value ->> 'leaveTime', e.value ->> 'kills'
           FROM json_each(?1) e ${matchJoin}
           CROSS JOIN aliases a ON a.name_key = e.value ->> 'key'`,
        )
        .bind(rows, w.hostId),
    ),
    ...jsonChunks(w.rows.rounds, w.chunkBytes).map((rows) =>
      db
        .prepare(
          `INSERT INTO rounds (match_id, number, result, winner_id, start_time, end_time, rated, broken)
           SELECT m.id, e.value ->> 'number', e.value ->> 'result', e.value ->> 'winnerId', e.value ->> 'startTime',
             e.value ->> 'endTime', e.value ->> 'rated', e.value ->> 'broken'
           FROM json_each(?1) e ${matchJoin}`,
        )
        .bind(rows, w.hostId),
    ),
    ...jsonChunks(w.rows.roundPlayers, w.chunkBytes).map((rows) =>
      db
        .prepare(
          `INSERT INTO round_players (round_id, log_id, player_id, position, place, left_round, afk, killer_id, kills, deflects)
           SELECT r.id, e.value ->> 'logId', mp.player_id, e.value ->> 'position', e.value ->> 'place',
             e.value ->> 'leftRound', e.value ->> 'afk', e.value ->> 'killerId', e.value ->> 'kills', e.value ->> 'deflects'
           FROM json_each(?1) e ${matchJoin}
           CROSS JOIN rounds r ON r.match_id = m.id AND r.number = e.value ->> 'round'
           CROSS JOIN match_players mp ON mp.match_id = m.id AND mp.log_id = e.value ->> 'logId'`,
        )
        .bind(rows, w.hostId),
    ),
    ...jsonChunks(w.rows.events, w.chunkBytes).map((rows) =>
      db
        .prepare(
          `INSERT INTO events (match_id, seq, type, round, time, actor_id, target_id, speed)
           SELECT m.id, e.value ->> 'seq', e.value ->> 'type', e.value ->> 'round', e.value ->> 'time',
             e.value ->> 'actor', e.value ->> 'target', e.value ->> 'speed'
           FROM json_each(?1) e ${matchJoin}`,
        )
        .bind(rows, w.hostId),
    ),

    // Head-to-head (#18): the matches' pairs of players, after their rounds and events. The insert
    // trigger adds them to `pair_stats` when the match is accepted (migrations/0017_match_stats.sql).
    db.prepare(matchPairsInsert("SELECT id FROM matches WHERE host_id = ?2 AND match_key IN (SELECT value FROM json_each(?1))"))
      .bind(json([...new Set(w.rows.players.map((p) => p.matchKey))]), w.hostId),

    // The older file of a replaced or repointed match goes once no match is in it any more: a
    // shorter copy is always the start of the longer one, so nothing is lost.
    db
      .prepare(
        `DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?1)) AND id != ${uploadId}
         AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.upload_id = uploads.id)`,
      )
      .bind(json(oldUploadIds), w.contentHash),
    ...(newUpload ? [db.prepare("UPDATE hosts SET last_upload_at = ?2 WHERE id = ?1").bind(w.hostId, w.now)] : []),
    ...(w.extra ?? []),
  ];

  // A link the lobby didn't take (an admin linked another match, reassigned the lobby or cancelled
  // the tourney since the read): the match waits for an admin instead of counting as a ranked one.
  const linkReviewIndex = links.length ? statements.length : null;
  if (links.length) {
    statements.push(
      db.prepare(
        `UPDATE matches SET status = 'review', review_reasons = ${appendReason("?3")}
         WHERE host_id = ?1 AND match_key IN (SELECT e.value ->> 'matchKey' FROM json_each(?2) e) AND status IN ('accepted', 'review')
           AND NOT EXISTS (SELECT 1 FROM tourney_lobbies l WHERE l.match_id = matches.id)
         RETURNING match_key AS matchKey, review_reasons AS reviewReasons`,
      ).bind(w.hostId, json(links), tourneyReasons.lobbyTaken),
    );
  }

  // Check the resolved ids in this transaction: a concurrent merge may have changed the aliases
  // since parsing. Different aliases of one player in a round need review, like duplicate_name.
  const reviewIndex = statements.length;
  statements.push(
    db.prepare(
      `UPDATE matches SET status = 'review', review_reasons = ${appendReason("'merged_names'")}
       WHERE host_id = ?1 AND match_key IN (SELECT value FROM json_each(?2)) AND status IN ('accepted', 'review')
         AND EXISTS (SELECT 1 FROM rounds r JOIN round_players rp ON rp.round_id = r.id
           JOIN match_players mp ON mp.match_id = r.match_id AND mp.log_id = rp.log_id
           WHERE r.match_id = matches.id GROUP BY rp.round_id, rp.player_id HAVING COUNT(DISTINCT mp.alias_id) > 1)
       RETURNING match_key AS matchKey, review_reasons AS reviewReasons`,
    ).bind(w.hostId, json([...w.rows.inserted, ...w.rows.replaced].map((m) => m.matchKey))),
  );
  if (statements.length > w.maxStatements) throw new TooManyStatements(statements.length);
  const results = await db.batch<{ id: number; matchKey: string; reviewReasons: string }>(statements);
  // A match's reasons now are those of the last statement that sent it to review.
  const reviews = new Map<string, string[]>();
  for (const index of [linkReviewIndex, reviewIndex]) {
    if (index !== null) for (const r of results[index]!.results) reviews.set(r.matchKey, r.reviewReasons.split(","));
  }
  return {
    uploadId: newUpload ? results[0]!.results[0]!.id : null,
    statements: statements.length,
    reviews: [...reviews].map(([matchKey, reviewReasons]) => ({ matchKey, reviewReasons })),
  };
}

/** `review_reasons` with `reason` (an SQL expression) added, unless it's there already. */
function appendReason(reason: string): string {
  return `CASE WHEN instr(',' || coalesce(review_reasons, '') || ',', ',' || ${reason} || ',') > 0
    THEN review_reasons ELSE coalesce(review_reasons || ',', '') || ${reason} END`;
}

/**
 * Links tourney matches to their lobbies, as an admin's link does (`POST /api/admin/lobbies/:id`,
 * src/admin/tourneys.ts): the lobby gets the match (its `version` goes up and its verification is
 * cleared), and the match becomes a tournament, which lists it in the match feed again (a trigger).
 * The checks are made again in the transaction: the lobby still has no match and is still the host's,
 * its tourney isn't cancelled and is in the match's region, and the match isn't another lobby's. A
 * link that fails them isn't made, and the review after it catches the match. The ratings need
 * nothing: a newly linked match was never rated (`tourneyCheck` links only a new match or a copy of
 * one in review or rejected), and the rating reads `tournament` when it rates it.
 */
function linkStatements(db: D1Database, links: readonly { matchKey: string; lobbyId: number }[], hostId: number): D1PreparedStatement[] {
  if (!links.length) return [];
  const json = JSON.stringify(links);
  return [
    db
      .prepare(
        `UPDATE tourney_lobbies SET match_id = m.id, version = version + 1, verified_by = NULL, verified_at = NULL
         FROM json_each(?1) e CROSS JOIN matches m ON m.host_id = ?2 AND m.match_key = e.value ->> 'matchKey'
         WHERE tourney_lobbies.id = e.value ->> 'lobbyId' AND tourney_lobbies.match_id IS NULL AND tourney_lobbies.host_id = ?2
           AND NOT EXISTS (SELECT 1 FROM tourney_lobbies o WHERE o.match_id = m.id)
           AND EXISTS (SELECT 1 FROM tourneys t WHERE t.id = tourney_lobbies.tourney_id AND t.status <> 'cancelled' AND t.region = m.region)`,
      )
      .bind(json, hostId),
    db
      .prepare(
        `UPDATE matches SET tournament = 1 WHERE tournament = 0 AND host_id = ?2
           AND id IN (SELECT l.match_id FROM json_each(?1) e CROSS JOIN tourney_lobbies l ON l.id = e.value ->> 'lobbyId')`,
      )
      .bind(json, hostId),
  ];
}

/** A row is bigger than a bulk insert may bind (`insertChunkBytes`): nothing was written. */
export class RowTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`A row is ${bytes} bytes of JSON`);
  }
}

/** The length of `text` in UTF-8, without encoding it: D1's limits are in bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    // A surrogate pair is 4 bytes, 2 per half.
    bytes += unit < 0x80 ? 1 : unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff) ? 2 : 3;
  }
  return bytes;
}

/**
 * The rows as JSON arrays of at most `maxBytes` UTF-8 bytes each, for the bulk inserts. Throws
 * `RowTooLarge` for a row that doesn't fit alone.
 */
export function jsonChunks(rows: readonly unknown[], maxBytes: number): string[] {
  const out: string[] = [];
  let parts: string[] = [];
  let size = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    const bytes = utf8Length(text);
    if (bytes + 2 > maxBytes) throw new RowTooLarge(bytes);
    if (parts.length && size + bytes + 1 > maxBytes) {
      out.push(`[${parts.join(",")}]`);
      parts = [];
      size = 2;
    }
    parts.push(text);
    size += bytes + 1;
  }
  if (parts.length) out.push(`[${parts.join(",")}]`);
  return out;
}
