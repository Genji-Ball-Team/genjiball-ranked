import { leaveBoardStatements, staleFromMatchesStatement } from "../rating/store";
import type { HostTrust, MatchStatus } from "../upload/plan";
import type { MatchState } from "./plan";

/**
 * The admin API's D1 queries. A change and its `admin_actions` row are written in one `db.batch`
 * (a transaction). The change is guarded by the state the handler read: if another admin changed
 * the row in between, the guard fails the batch (`isStale`) and nothing is written.
 */

export interface Admin {
  id: number;
  name: string;
}

export interface HostRow {
  id: number;
  name: string;
  trust: HostTrust;
  /** Home region (#47): where its uploads without `X-Region` were played. Null: they must say. */
  region: string | null;
  createdAt: string;
  lastUploadAt: string | null;
}

export interface MatchRow extends MatchState {
  id: number;
  region: string;
  matchKey: string | null;
  hostId: number;
  hostName: string;
  lineCount: number;
  reviewReasons: string[];
  map: string | null;
  preset: string | null;
  playedAt: string;
  complete: boolean;
  rated: boolean;
  tournament: boolean;
  players: string[];
}

export interface ActionRow {
  id: number;
  admin: string;
  action: string;
  matchId: number | null;
  hostId: number | null;
  detail: unknown;
  at: string;
}

/** What to log about an action. */
export interface ActionLog {
  adminId: number;
  action: string;
  matchId?: number | null;
  hostId?: number | null;
  detail?: unknown;
  at: string;
}

/** `admin_actions.detail`: JSON, or NULL when there is nothing to add. */
const detailJson = (detail: unknown) => (detail === undefined ? null : JSON.stringify(detail));

export async function findAdmin(db: D1Database, tokenHash: string): Promise<Admin | null> {
  return db.prepare("SELECT id, name FROM admins WHERE token_hash = ? AND revoked_at IS NULL").bind(tokenHash).first<Admin>();
}

const hostColumns = "id, name, trust, region, created_at AS createdAt, last_upload_at AS lastUploadAt";

export async function listHosts(db: D1Database, limit: number): Promise<HostRow[]> {
  const { results } = await db.prepare(`SELECT ${hostColumns} FROM hosts ORDER BY id DESC LIMIT ?`).bind(limit).all<HostRow>();
  return results;
}

export async function findHostById(db: D1Database, id: number): Promise<HostRow | null> {
  return db.prepare(`SELECT ${hostColumns} FROM hosts WHERE id = ?`).bind(id).first<HostRow>();
}

/** Adds a host with the token's hash. Returns the new host. */
export async function createHost(
  db: D1Database,
  name: string,
  trust: HostTrust,
  region: string | null,
  tokenHash: string,
  log: ActionLog,
): Promise<HostRow> {
  const [inserted] = await db.batch<HostRow>([
    db
      .prepare(`INSERT INTO hosts (name, token_hash, trust, created_at, region) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING ${hostColumns}`)
      .bind(name, tokenHash, trust, log.at, region),
    db
      .prepare("INSERT INTO admin_actions (admin_id, action, host_id, detail, at) SELECT ?1, ?2, id, ?3, ?4 FROM hosts WHERE token_hash = ?5")
      .bind(log.adminId, log.action, detailJson(log.detail), log.at, tokenHash),
  ]);
  return inserted!.results[0]!;
}

/** Changes a host's trust, if it's still `from`. */
export async function setHostTrust(db: D1Database, hostId: number, from: HostTrust, to: HostTrust, log: ActionLog): Promise<void> {
  await db.batch([
    // NULL when the trust isn't `from` any more: NOT NULL fails the batch (isStale).
    db.prepare("UPDATE hosts SET trust = CASE WHEN trust = ?2 THEN ?3 END WHERE id = ?1").bind(hostId, from, to),
    actionStatement(db, log),
  ]);
}

/** Sets a host's home region (null: none, every upload must send `X-Region`). */
export async function setHostRegion(db: D1Database, hostId: number, region: string | null, log: ActionLog): Promise<void> {
  await db.batch([db.prepare("UPDATE hosts SET region = ?2 WHERE id = ?1").bind(hostId, region), actionStatement(db, log)]);
}

const matchColumns = `m.id, m.region, m.match_key AS matchKey, m.host_id AS hostId, h.name AS hostName, m.line_count AS lineCount,
  m.status, m.rejection_code AS rejectionCode, m.rejection_message AS rejectionMessage, m.review_reasons AS reviewReasons,
  m.map, m.preset, m.played_at AS playedAt, m.complete, m.rated_at IS NOT NULL AS rated, m.tournament,
  (SELECT json_group_array(mp.name) FROM match_players mp WHERE mp.match_id = m.id) AS players`;

interface RawMatch {
  id: number;
  region: string;
  matchKey: string | null;
  hostId: number;
  hostName: string;
  lineCount: number;
  status: MatchStatus;
  rejectionCode: string | null;
  rejectionMessage: string | null;
  reviewReasons: string | null;
  map: string | null;
  preset: string | null;
  playedAt: string;
  complete: number;
  rated: number;
  tournament: number;
  players: string;
}

function toMatch({ rejectionCode, rejectionMessage, reviewReasons, complete, rated, tournament, players, ...m }: RawMatch): MatchRow {
  return {
    ...m,
    rejection: rejectionCode === null ? null : { code: rejectionCode, message: rejectionMessage ?? "" },
    reviewReasons: reviewReasons ? reviewReasons.split(",") : [],
    complete: complete === 1,
    rated: rated === 1,
    tournament: tournament === 1,
    players: JSON.parse(players) as string[],
  };
}

/**
 * Matches with this status, newest first, in one region or all (indexes `matches_region_status_played`,
 * `matches_status_played`).
 */
export async function listMatches(db: D1Database, status: MatchStatus, region: string | null, limit: number): Promise<MatchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${matchColumns} FROM matches m JOIN hosts h ON h.id = m.host_id
       WHERE m.status = ?1 AND (?3 IS NULL OR m.region = ?3) ORDER BY m.played_at DESC, m.id DESC LIMIT ?2`,
    )
    .bind(status, limit, region)
    .all<RawMatch>();
  return results.map(toMatch);
}

export async function findMatch(db: D1Database, id: number): Promise<MatchRow | null> {
  const row = await db
    .prepare(`SELECT ${matchColumns} FROM matches m JOIN hosts h ON h.id = m.host_id WHERE m.id = ?`)
    .bind(id)
    .first<RawMatch>();
  return row ? toMatch(row) : null;
}

/**
 * Sets a match's status and rejection, if its status is still `from`. Also runs `extra` (marking the
 * ratings stale) in the same transaction.
 */
export async function setMatchState(
  db: D1Database,
  matchId: number,
  from: MatchStatus,
  to: MatchState,
  log: ActionLog,
  extra: D1PreparedStatement[] = [],
): Promise<void> {
  await db.batch([
    // NULL when the status isn't `from` any more: NOT NULL fails the batch (isStale).
    db
      .prepare("UPDATE matches SET status = CASE WHEN status = ?2 THEN ?3 END, rejection_code = ?4, rejection_message = ?5 WHERE id = ?1")
      .bind(matchId, from, to.status, to.rejection?.code ?? null, to.rejection?.message ?? null),
    ...extra,
    actionStatement(db, log),
  ]);
}

/**
 * Moves a match to another region, if it's still in `from` (#47): a host uploaded under the wrong
 * one. In one transaction: the old region's ratings go stale from the match (if it was rated) and
 * lose it (`leaveBoardStatements`), the match becomes unrated in `to`, where it's rated like a late
 * upload, and both regions' rating versions move on so a rating run that read the old state fails.
 */
export async function moveMatch(db: D1Database, matchId: number, from: string, to: string, log: ActionLog): Promise<void> {
  await db.batch([
    staleFromMatchesStatement(db, [matchId], log.at, true),
    // NULL when the region isn't `from` any more, or a lobby linked it meanwhile: NOT NULL fails the batch (isStale).
    db
      .prepare(
        `UPDATE matches SET status = CASE WHEN region = ?2 AND NOT EXISTS (SELECT 1 FROM tourney_lobbies WHERE match_id = ?1)
           THEN status END, region = ?3, rated_at = NULL WHERE id = ?1`,
      )
      .bind(matchId, from, to),
    ...leaveBoardStatements(db, from, matchId),
    db.prepare("UPDATE rating_state SET version = version + 1 WHERE board IN (?1, ?2)").bind(from, to),
    actionStatement(db, log),
  ]);
}

/**
 * Marks a match as a tournament (or not), if it still isn't. Also runs `extra` (marking the ratings
 * stale) in the same transaction.
 */
export async function setTournament(
  db: D1Database,
  matchId: number,
  tournament: boolean,
  log: ActionLog,
  extra: D1PreparedStatement[] = [],
): Promise<void> {
  await db.batch([
    // NULL when another admin set it meanwhile: NOT NULL fails the batch (isStale).
    db
      .prepare(`UPDATE matches SET tournament = CASE WHEN tournament = ?3
        AND (?2 = 1 OR NOT EXISTS (SELECT 1 FROM tourney_lobbies WHERE match_id = ?1)) THEN ?2 END WHERE id = ?1`)
      .bind(matchId, tournament ? 1 : 0, tournament ? 0 : 1),
    ...extra,
    actionStatement(db, log),
  ]);
}

/** Whether a batch failed because the row changed after the handler read it. */
export function isStale(error: unknown): boolean {
  return /NOT NULL constraint failed: (hosts\.trust|matches\.status|matches\.tournament)/.test(String(error));
}

export function actionStatement(db: D1Database, log: ActionLog): D1PreparedStatement {
  return db
    .prepare("INSERT INTO admin_actions (admin_id, action, match_id, host_id, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(log.adminId, log.action, log.matchId ?? null, log.hostId ?? null, detailJson(log.detail), log.at);
}

/** The newest admin actions first. */
export async function listActions(db: D1Database, limit: number): Promise<ActionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT x.id, a.name AS admin, x.action, x.match_id AS matchId, x.host_id AS hostId, x.detail, x.at
       FROM admin_actions x JOIN admins a ON a.id = x.admin_id ORDER BY x.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Omit<ActionRow, "detail"> & { detail: string | null }>();
  return results.map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
}
