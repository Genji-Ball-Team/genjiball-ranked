import { actionStatement, type ActionLog } from "../admin/store";
import type { Config } from "../config";
import { isoSeconds } from "../time";
import { standings, type LogIdCount, type Standing, type StandingPlayerRow } from "./standings";

/**
 * Tourneys' D1 queries (#22, #24, #28, #31): the schedule, the lobbies and their standings. A
 * change and its `admin_actions` row are written in one `db.batch`.
 */

export type TourneyStatus = "scheduled" | "live" | "done" | "cancelled";
export const tourneyStatuses: readonly TourneyStatus[] = ["scheduled", "live", "done", "cancelled"];
/** Still to come, or being played: the top of the Tourneys page. */
const upcomingStatuses = "('scheduled', 'live')";
const pastStatuses = "('done', 'cancelled')";

export interface TourneyRow {
  id: number;
  name: string;
  /** The region it's played in (#47): its lobbies' matches are from there. */
  region: string;
  startsAt: string;
  status: TourneyStatus;
  notes: string | null;
}

export interface LobbyRow {
  id: number;
  /** Guards edits against changes since the admin read the lobby. */
  version: number;
  tourneyId: number;
  label: string;
  matchId: number | null;
  /** The match is public (accepted or void): the site shows it and its standings. */
  matchPublic: boolean;
  matchVoid: boolean;
  screenshotKey: string | null;
  screenshotAt: string | null;
  /** When the screenshot was deleted to stay inside the storage caps (`./expiry.ts`). */
  screenshotExpiredAt: string | null;
  verifiedAt: string | null;
  /** The admin who verified it. */
  verifiedBy: string | null;
}

const tourneyColumns = "id, name, region, starts_at AS startsAt, status, notes";

/** The region's tourneys still to come or being played, soonest first (index `tourneys_region_status_starts`). */
export async function listUpcoming(db: D1Database, region: string): Promise<TourneyRow[]> {
  const { results } = await db
    .prepare(`SELECT ${tourneyColumns} FROM tourneys WHERE region = ? AND status IN ${upcomingStatuses} ORDER BY starts_at, id`)
    .bind(region)
    .all<TourneyRow>();
  return results;
}

/** The region's played and cancelled tourneys, newest first. */
export async function listPast(db: D1Database, region: string, limit: number, offset: number): Promise<TourneyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${tourneyColumns} FROM tourneys WHERE region = ?3 AND status IN ${pastStatuses}
       ORDER BY starts_at DESC, id DESC LIMIT ?1 OFFSET ?2`,
    )
    .bind(limit, offset, region)
    .all<TourneyRow>();
  return results;
}

/** Every tourney for the admin page, latest start first. */
export async function listAllTourneys(db: D1Database, limit: number): Promise<TourneyRow[]> {
  const { results } = await db.prepare(`SELECT ${tourneyColumns} FROM tourneys ORDER BY starts_at DESC, id DESC LIMIT ?`).bind(limit).all<TourneyRow>();
  return results;
}

export async function findTourney(db: D1Database, id: number): Promise<TourneyRow | null> {
  return db.prepare(`SELECT ${tourneyColumns} FROM tourneys WHERE id = ?`).bind(id).first<TourneyRow>();
}

const lobbyColumns = `l.id, l.version, l.tourney_id AS tourneyId, l.label, l.match_id AS matchId,
  coalesce(m.status IN ('accepted', 'void'), 0) AS matchPublic, coalesce(m.status = 'void', 0) AS matchVoid,
  l.screenshot_key AS screenshotKey, l.screenshot_at AS screenshotAt, l.screenshot_expired_at AS screenshotExpiredAt, l.verified_at AS verifiedAt, a.name AS verifiedBy`;
const lobbyFrom = `tourney_lobbies l LEFT JOIN matches m ON m.id = l.match_id LEFT JOIN admins a ON a.id = l.verified_by`;

type RawLobby = Omit<LobbyRow, "matchPublic" | "matchVoid"> & { matchPublic: number; matchVoid: number };
const toLobby = ({ matchPublic, matchVoid, ...l }: RawLobby): LobbyRow => ({ ...l, matchPublic: matchPublic === 1, matchVoid: matchVoid === 1 });

/** The lobbies of these tourneys, in the order they were added (index `tourney_lobbies_tourney`). */
export async function listLobbies(db: D1Database, tourneyIds: readonly number[]): Promise<LobbyRow[]> {
  if (!tourneyIds.length) return [];
  const { results } = await db
    .prepare(`SELECT ${lobbyColumns} FROM ${lobbyFrom} WHERE l.tourney_id IN (SELECT value FROM json_each(?)) ORDER BY l.tourney_id, l.id`)
    .bind(JSON.stringify(tourneyIds))
    .all<RawLobby>();
  return results.map(toLobby);
}

export async function findLobby(db: D1Database, id: number): Promise<LobbyRow | null> {
  const row = await db.prepare(`SELECT ${lobbyColumns} FROM ${lobbyFrom} WHERE l.id = ?`).bind(id).first<RawLobby>();
  return row && toLobby(row);
}

/**
 * The standings of these matches, in one batch of three reads: the players with their rating before
 * and after (as on the match page), round wins per log id, and kills per log id. Reads each match's
 * rounds and events, about 600 rows a match.
 */
export async function readStandings(db: D1Database, matchIds: readonly number[]): Promise<Map<number, Standing[]>> {
  const result = new Map<number, Standing[]>();
  if (!matchIds.length) return result;
  const ids = JSON.stringify(matchIds);
  const [players, wins, kills] = await db.batch([
    db
      .prepare(
        `SELECT mp.match_id AS matchId, mp.log_id AS logId, mp.player_id AS playerId, p.name,
           (SELECT h.display FROM rating_history h
            WHERE h.board = m.region AND h.player_id = mp.player_id AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
           (SELECT h.display FROM rating_history h
            WHERE h.board = m.region AND h.player_id = mp.player_id AND (h.played_at, h.match_id) < (m.played_at, m.id)
            ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
         FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN players p ON p.id = mp.player_id
         WHERE mp.match_id IN (SELECT value FROM json_each(?1)) ORDER BY mp.match_id, mp.log_id`,
      )
      .bind(ids),
    db
      .prepare(
        `SELECT match_id AS matchId, winner_id AS logId, COUNT(*) AS n FROM rounds
         WHERE match_id IN (SELECT value FROM json_each(?1)) AND result = 'WIN' AND winner_id IS NOT NULL
         GROUP BY match_id, winner_id`,
      )
      .bind(ids),
    db
      .prepare(
        `SELECT match_id AS matchId, actor_id AS logId, COUNT(*) AS n FROM events
         WHERE match_id IN (SELECT value FROM json_each(?1)) AND type = 'KILL' AND actor_id IS NOT NULL AND actor_id IS NOT target_id
         GROUP BY match_id, actor_id`,
      )
      .bind(ids),
  ]);
  type Counted = LogIdCount & { matchId: number };
  const of = <T extends { matchId: number }>(rows: T[], id: number) => rows.filter((r) => r.matchId === id);
  const playerRows = (players!.results as (StandingPlayerRow & { matchId: number })[]).map((p) => ({
    ...p,
    ratingBefore: p.ratingAfter === null ? null : p.ratingBefore,
  }));
  for (const id of matchIds) {
    result.set(id, standings(of(playerRows, id), of(wins!.results as Counted[], id), of(kills!.results as Counted[], id)));
  }
  return result;
}

// Admin writes

export interface TourneyFields {
  name: string;
  region: string;
  startsAt: string;
  status: TourneyStatus;
  notes: string | null;
}

export async function createTourney(db: D1Database, t: TourneyFields, log: ActionLog): Promise<TourneyRow> {
  const [inserted] = await db.batch<TourneyRow>([
    db
      .prepare(
        `INSERT INTO tourneys (name, starts_at, status, notes, created_at, region) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING ${tourneyColumns}`,
      )
      .bind(t.name, t.startsAt, t.status, t.notes, log.at, t.region),
    newRowActionStatement(db, log, "tourney"),
  ]);
  return inserted!.results[0]!;
}

export async function updateTourney(db: D1Database, id: number, t: TourneyFields, log: ActionLog): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE tourneys SET name = ?2, starts_at = ?3, status = ?4, notes = ?5, region = ?6 WHERE id = ?1")
      .bind(id, t.name, t.startsAt, t.status, t.notes, t.region),
    actionStatement(db, log),
  ]);
}

export async function createLobby(db: D1Database, tourneyId: number, label: string, log: ActionLog): Promise<number> {
  const [inserted] = await db.batch<{ id: number }>([
    db.prepare("INSERT INTO tourney_lobbies (tourney_id, label) VALUES (?1, ?2) RETURNING id").bind(tourneyId, label),
    newRowActionStatement(db, log, "lobby"),
  ]);
  return inserted!.results[0]!.id;
}

/**
 * Renames a lobby and sets its match. A new match clears the verification: the screenshot was
 * checked against the old one. `extra` (the tournament flags and marking the ratings stale) runs in
 * the same transaction.
 */
export async function updateLobby(
  db: D1Database,
  lobby: LobbyRow,
  label: string,
  matchId: number | null,
  log: ActionLog,
  extra: D1PreparedStatement[],
): Promise<void> {
  await db.batch([
    lobbyActionStatement(db, lobby, log),
    db
      .prepare(
        `UPDATE tourney_lobbies SET label = ?2, match_id = ?3, version = version + 1,
           verified_by = CASE WHEN match_id IS ?3 THEN verified_by END, verified_at = CASE WHEN match_id IS ?3 THEN verified_at END
         WHERE id = ?1`,
      )
      .bind(lobby.id, label, matchId),
    ...extra,
  ]);
}

export async function deleteLobby(db: D1Database, lobby: LobbyRow, log: ActionLog, extra: D1PreparedStatement[]): Promise<void> {
  await db.batch([
    lobbyActionStatement(db, lobby, log),
    queueScreenshotStatement(db, [lobby.id], log.at),
    db.prepare("DELETE FROM tourney_lobbies WHERE id = ?").bind(lobby.id),
    ...extra,
  ]);
}

/** Sets (or clears) the lobby's screenshot, `bytes` long. A new screenshot isn't verified yet. */
export async function setScreenshot(db: D1Database, lobby: LobbyRow, key: string | null, bytes: number | null, log: ActionLog): Promise<void> {
  await db.batch([
    // A cleanup run may already have selected an expired upload reservation. Such a key cannot attach.
    lobbyActionStatement(db, lobby, log, key),
    queueScreenshotStatement(db, [lobby.id], log.at),
    db
      .prepare(
        `UPDATE tourney_lobbies SET screenshot_key = ?2, screenshot_at = ?3, screenshot_bytes = ?4, screenshot_expired_at = NULL,
           verified_by = NULL, verified_at = NULL, version = version + 1 WHERE id = ?1`,
      )
      .bind(lobby.id, key, key === null ? null : log.at, bytes),
    db.prepare("DELETE FROM screenshot_deletions WHERE key = ?").bind(key),
  ]);
}

export async function setVerified(db: D1Database, lobby: LobbyRow, verified: boolean, log: ActionLog): Promise<void> {
  await db.batch([
    lobbyActionStatement(db, lobby, log),
    db
      .prepare("UPDATE tourney_lobbies SET verified_by = ?2, verified_at = ?3, version = version + 1 WHERE id = ?1")
      .bind(lobby.id, verified ? log.adminId : null, verified ? log.at : null),
  ]);
}

/** Logs the action only when the lobby still has the version the caller checked. A failed
 * NOT NULL on `action` rolls back the batch, including all dependent match and screenshot writes. */
function lobbyActionStatement(db: D1Database, lobby: LobbyRow, log: ActionLog, attachingKey: string | null = null): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO admin_actions (admin_id, action, match_id, host_id, detail, at)
     VALUES (?1, CASE WHEN EXISTS (SELECT 1 FROM tourney_lobbies WHERE id = ?7 AND version = ?8)
       AND (?9 IS NULL OR EXISTS (SELECT 1 FROM screenshot_deletions WHERE key = ?9
         AND delete_after > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))) THEN ?2 END,
       ?3, ?4, ?5, ?6)`,
  ).bind(log.adminId, log.action, log.matchId ?? null, log.hostId ?? null, JSON.stringify(log.detail ?? null), log.at, lobby.id, lobby.version, attachingKey);
}

/** Whether a lobby mutation lost a race with another edit, replacement, expiry or deletion. */
export function isLobbyChanged(error: unknown): boolean {
  return String(error).includes("NOT NULL constraint failed: admin_actions.action");
}

/** Queue current screenshots before removing their references, in the same transaction. */
function queueScreenshotStatement(db: D1Database, lobbyIds: readonly number[], at: string): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO screenshot_deletions (key, bytes, queued_at, delete_after)
     SELECT screenshot_key, coalesce(screenshot_bytes, 0), ?2, ?2 FROM tourney_lobbies
     WHERE id IN (SELECT value FROM json_each(?1)) AND screenshot_key IS NOT NULL`,
  ).bind(JSON.stringify(lobbyIds), at);
}

/** Record an unreferenced upload for cleanup, including when its compensating R2 delete failed. */
export async function queueScreenshot(db: D1Database, key: string, bytes: number, at: string): Promise<void> {
  await db.prepare(
    `INSERT INTO screenshot_deletions (key, bytes, queued_at, delete_after) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(key) DO UPDATE SET delete_after = min(delete_after, excluded.delete_after)`,
  ).bind(key, bytes, at).run();
}

/** Reserve before R2 put so a crash never loses the object's cleanup key. If cleanup is pending,
 * atomically stop new storage growth past the caps until deletes succeed. */
export async function stageScreenshot(db: D1Database, key: string, bytes: number, now: Date, config: Pick<Config, "screenshotUploadGraceSeconds" | "screenshotsKept" | "screenshotStorageMaxBytes">): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO screenshot_deletions (key, bytes, queued_at, delete_after)
     SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM screenshot_deletions)
       OR ((SELECT count(*) FROM screenshot_deletions) + (SELECT count(*) FROM tourney_lobbies WHERE screenshot_key IS NOT NULL) + 1 <= ?5
         AND (SELECT coalesce(sum(bytes), 0) FROM screenshot_deletions)
           + (SELECT coalesce(sum(screenshot_bytes), 0) FROM tourney_lobbies WHERE screenshot_key IS NOT NULL) + ?2 <= ?6)`,
  ).bind(key, bytes, isoSeconds(now), isoSeconds(new Date(now.getTime() + config.screenshotUploadGraceSeconds * 1000)), config.screenshotsKept, config.screenshotStorageMaxBytes).run();
  return result.meta.changes === 1;
}

/** Oldest pending R2 deletes, bounded so retries fit the worker invocation. */
export async function pendingScreenshots(db: D1Database, limit: number, at: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT key FROM screenshot_deletions WHERE delete_after <= ?1 ORDER BY delete_after, key LIMIT ?2").bind(at, limit).all<{ key: string }>();
  return results.map((r) => r.key);
}

/** A successful R2 delete is the only point at which cleanup keys stop being tracked. */
export async function forgetScreenshots(db: D1Database, keys: readonly string[]): Promise<void> {
  await db.prepare("DELETE FROM screenshot_deletions WHERE key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(keys)).run();
}

/** Public screenshots must still belong to a lobby; pending deletes are never served. */
export async function hasScreenshot(db: D1Database, key: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM tourney_lobbies WHERE screenshot_key = ? LIMIT 1").bind(key).first()) !== null;
}

/**
 * Stored screenshots past the caps: beyond the newest `kept`, past `maxBytes` counted from the
 * newest, or taken before `before` (`""`: no age limit). Reads every stored screenshot's row, so
 * it runs after an upload, not on the cron.
 */
export async function listOverCaps(db: D1Database, kept: number, maxBytes: number, before: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT key FROM (
         SELECT screenshot_key AS key, screenshot_at AS at,
           ROW_NUMBER() OVER w AS n, SUM(coalesce(screenshot_bytes, 0)) OVER w AS total
         FROM tourney_lobbies WHERE screenshot_key IS NOT NULL
         WINDOW w AS (ORDER BY screenshot_at DESC, id DESC ROWS UNBOUNDED PRECEDING))
       WHERE n > ?1 - (SELECT count(*) FROM screenshot_deletions)
          OR total > ?2 - (SELECT coalesce(sum(bytes), 0) FROM screenshot_deletions)
          OR at < ?3`,
    )
    .bind(kept, maxBytes, before)
    .all<{ key: string }>();
  return results.map((r) => r.key);
}

/** Up to `limit` stored screenshots taken before `before`, oldest first (index `tourney_lobbies_screenshot`). */
export async function listOlderThan(db: D1Database, before: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT screenshot_key AS key FROM tourney_lobbies WHERE screenshot_key IS NOT NULL AND screenshot_at < ?1 ORDER BY screenshot_at LIMIT ?2")
    .bind(before, limit)
    .all<{ key: string }>();
  return results.map((r) => r.key);
}

/** Marks these screenshots expired. By key: a screenshot replaced meanwhile has a new one and stays. */
export async function expireScreenshots(db: D1Database, keys: readonly string[], at: string): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO screenshot_deletions (key, bytes, queued_at, delete_after)
       SELECT screenshot_key, coalesce(screenshot_bytes, 0), ?2, ?2 FROM tourney_lobbies
       WHERE screenshot_key IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify(keys), at),
    db
    .prepare(
      `UPDATE tourney_lobbies SET screenshot_key = NULL, screenshot_bytes = NULL, screenshot_expired_at = ?2, version = version + 1
       WHERE screenshot_key IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(keys), at),
  ]);
}

/** Logs an action on the row the statement before it inserted: its id goes in `detail` as `field`. */
function newRowActionStatement(db: D1Database, log: ActionLog, field: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO admin_actions (admin_id, action, detail, at) VALUES (?1, ?2, json_set(?3, '$.' || ?4, last_insert_rowid()), ?5)")
    .bind(log.adminId, log.action, JSON.stringify(log.detail ?? {}), field, log.at);
}

/** Sets `matches.tournament` on these matches: a lobby's match is a tournament. */
export function tournamentStatement(db: D1Database, matchIds: readonly number[], tournament: boolean): D1PreparedStatement {
  return db
    .prepare("UPDATE matches SET tournament = ?2 WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(matchIds), tournament ? 1 : 0);
}

/** Whether a write failed because the match is already another lobby's. */
export function isLinkedElsewhere(error: unknown): boolean {
  return /UNIQUE constraint failed: tourney_lobbies\.match_id/.test(String(error));
}
