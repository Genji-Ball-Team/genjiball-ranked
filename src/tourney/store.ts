import { actionStatement, type ActionLog } from "../admin/store";
import { board } from "../rating/store";
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
  startsAt: string;
  status: TourneyStatus;
  notes: string | null;
}

export interface LobbyRow {
  id: number;
  tourneyId: number;
  label: string;
  matchId: number | null;
  /** The match is public (accepted or void): the site shows it and its standings. */
  matchPublic: boolean;
  matchVoid: boolean;
  screenshotKey: string | null;
  screenshotAt: string | null;
  verifiedAt: string | null;
  /** The admin who verified it. */
  verifiedBy: string | null;
}

const tourneyColumns = "id, name, starts_at AS startsAt, status, notes";

/** Tourneys still to come or being played, soonest first (index `tourneys_status_starts`). */
export async function listUpcoming(db: D1Database): Promise<TourneyRow[]> {
  const { results } = await db
    .prepare(`SELECT ${tourneyColumns} FROM tourneys WHERE status IN ${upcomingStatuses} ORDER BY starts_at, id`)
    .all<TourneyRow>();
  return results;
}

/** Played and cancelled tourneys, newest first. */
export async function listPast(db: D1Database, limit: number, offset: number): Promise<TourneyRow[]> {
  const { results } = await db
    .prepare(`SELECT ${tourneyColumns} FROM tourneys WHERE status IN ${pastStatuses} ORDER BY starts_at DESC, id DESC LIMIT ?1 OFFSET ?2`)
    .bind(limit, offset)
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

const lobbyColumns = `l.id, l.tourney_id AS tourneyId, l.label, l.match_id AS matchId,
  coalesce(m.status IN ('accepted', 'void'), 0) AS matchPublic, coalesce(m.status = 'void', 0) AS matchVoid,
  l.screenshot_key AS screenshotKey, l.screenshot_at AS screenshotAt, l.verified_at AS verifiedAt, a.name AS verifiedBy`;
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
            WHERE h.board = ?2 AND h.player_id = mp.player_id AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
           (SELECT h.display FROM rating_history h
            WHERE h.board = ?2 AND h.player_id = mp.player_id AND (h.played_at, h.match_id) < (m.played_at, m.id)
            ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
         FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN players p ON p.id = mp.player_id
         WHERE mp.match_id IN (SELECT value FROM json_each(?1)) ORDER BY mp.match_id, mp.log_id`,
      )
      .bind(ids, board),
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
  startsAt: string;
  status: TourneyStatus;
  notes: string | null;
}

export async function createTourney(db: D1Database, t: TourneyFields, log: ActionLog): Promise<TourneyRow> {
  const [inserted] = await db.batch<TourneyRow>([
    db
      .prepare(`INSERT INTO tourneys (name, starts_at, status, notes, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING ${tourneyColumns}`)
      .bind(t.name, t.startsAt, t.status, t.notes, log.at),
    newRowActionStatement(db, log, "tourney"),
  ]);
  return inserted!.results[0]!;
}

export async function updateTourney(db: D1Database, id: number, t: TourneyFields, log: ActionLog): Promise<void> {
  await db.batch([
    db.prepare("UPDATE tourneys SET name = ?2, starts_at = ?3, status = ?4, notes = ?5 WHERE id = ?1").bind(id, t.name, t.startsAt, t.status, t.notes),
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
  id: number,
  label: string,
  matchId: number | null,
  log: ActionLog,
  extra: D1PreparedStatement[],
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE tourney_lobbies SET label = ?2, match_id = ?3,
           verified_by = CASE WHEN match_id IS ?3 THEN verified_by END, verified_at = CASE WHEN match_id IS ?3 THEN verified_at END
         WHERE id = ?1`,
      )
      .bind(id, label, matchId),
    ...extra,
    actionStatement(db, log),
  ]);
}

export async function deleteLobby(db: D1Database, id: number, log: ActionLog, extra: D1PreparedStatement[]): Promise<void> {
  await db.batch([db.prepare("DELETE FROM tourney_lobbies WHERE id = ?").bind(id), ...extra, actionStatement(db, log)]);
}

/** Sets (or clears) the lobby's screenshot. A new screenshot isn't verified yet. */
export async function setScreenshot(db: D1Database, id: number, key: string | null, log: ActionLog): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE tourney_lobbies SET screenshot_key = ?2, screenshot_at = ?3, verified_by = NULL, verified_at = NULL WHERE id = ?1")
      .bind(id, key, key === null ? null : log.at),
    actionStatement(db, log),
  ]);
}

export async function setVerified(db: D1Database, id: number, verified: boolean, log: ActionLog): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE tourney_lobbies SET verified_by = ?2, verified_at = ?3 WHERE id = ?1")
      .bind(id, verified ? log.adminId : null, verified ? log.at : null),
    actionStatement(db, log),
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
