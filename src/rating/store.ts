import type { HistoryEntry, PlayerRating } from "./engine";
import type { RatingWrites, StoredRating } from "./plan";

/**
 * The ratings' D1 queries. Every rating write is one `db.batch` that starts with `lockStatement`:
 * if another write landed since the caller read `rating_state.version`, the whole batch fails and
 * nothing is written (`isConflict`).
 */

/** The leaderboard. `tourney` and `global` come with #26. */
export const board = "ranked";

/** A match's place in play order. */
export interface MatchRef {
  id: number;
  playedAt: string;
}

/** Recompute everything: before every match. */
export const fromStart: MatchRef = { id: 0, playedAt: "" };

export interface RatingState {
  version: number;
  /** Re-rate from this match on. `null`: the ratings are up to date. */
  staleFrom: MatchRef | null;
}

export interface CandidateMatch extends MatchRef {
  complete: boolean;
  rated: boolean;
  /** An admin marked it as a tournament: it counts more, and nobody loses much in it. */
  tournament: boolean;
}

export function compareRefs(a: MatchRef, b: MatchRef): number {
  if (a.playedAt !== b.playedAt) return a.playedAt < b.playedAt ? -1 : 1;
  return a.id - b.id;
}

const json = (value: unknown) => JSON.stringify(value);

export async function readState(db: D1Database): Promise<RatingState> {
  const row = await db
    .prepare("SELECT version, stale_played_at AS playedAt, stale_match_id AS id FROM rating_state WHERE board = ?")
    .bind(board)
    .first<{ version: number; playedAt: string | null; id: number | null }>();
  if (!row) throw new Error(`rating_state has no row for ${board}`);
  return { version: row.version, staleFrom: row.playedAt === null ? null : { playedAt: row.playedAt, id: row.id ?? 0 } };
}

/** Accepted matches that aren't rated, in play order (index `matches_unrated`). */
export async function readUnrated(db: D1Database): Promise<CandidateMatch[]> {
  const { results } = await db
    .prepare(
      `SELECT id, played_at AS playedAt, complete, tournament FROM matches
       WHERE status = 'accepted' AND rated_at IS NULL ORDER BY played_at, id`,
    )
    .all<{ id: number; playedAt: string; complete: number; tournament: number }>();
  return results.map((m) => ({
    id: m.id,
    playedAt: m.playedAt,
    complete: m.complete === 1,
    rated: false,
    tournament: m.tournament === 1,
  }));
}

/** The newest rated match (index `matches_rated`). */
export async function readNewestRated(db: D1Database): Promise<MatchRef | null> {
  return db
    .prepare("SELECT id, played_at AS playedAt FROM matches WHERE rated_at IS NOT NULL ORDER BY played_at DESC, id DESC LIMIT 1")
    .first<MatchRef>();
}

/** Accepted matches from `from` on, in play order, at most `limit`. */
export async function readAcceptedFrom(db: D1Database, from: MatchRef, limit: number): Promise<CandidateMatch[]> {
  const { results } = await db
    .prepare(
      `SELECT id, played_at AS playedAt, complete, rated_at IS NOT NULL AS rated, tournament FROM matches
       WHERE status = 'accepted' AND (played_at, id) >= (?1, ?2) ORDER BY played_at, id LIMIT ?3`,
    )
    .bind(from.playedAt, from.id, limit)
    .all<{ id: number; playedAt: string; complete: number; rated: number; tournament: number }>();
  return results.map((m) => ({
    id: m.id,
    playedAt: m.playedAt,
    complete: m.complete === 1,
    rated: m.rated === 1,
    tournament: m.tournament === 1,
  }));
}

/** Rated matches that aren't accepted any more (voided, or replaced by a copy that isn't), from `from` up to `until`. */
export async function readNoLongerAccepted(db: D1Database, from: MatchRef, until: MatchRef | null): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM matches WHERE rated_at IS NOT NULL AND status != 'accepted' AND (played_at, id) >= (?1, ?2)
       AND (?3 IS NULL OR (played_at, id) < (?3, ?4))`,
    )
    .bind(from.playedAt, from.id, until?.playedAt ?? null, until?.id ?? null)
    .all<{ id: number }>();
  return results.map((m) => m.id);
}

/** The finishing order of each rated round of these matches, by player id, in round order. */
export async function readRounds(db: D1Database, matchIds: readonly number[]): Promise<Map<number, number[][]>> {
  const byMatch = new Map<number, number[][]>(matchIds.map((id) => [id, []]));
  if (!matchIds.length) return byMatch;
  const { results } = await db
    .prepare(
      `SELECT r.match_id AS matchId, r.number, rp.player_id AS playerId
       FROM rounds r JOIN round_players rp ON rp.round_id = r.id
       WHERE r.match_id IN (SELECT value FROM json_each(?1)) AND r.rated = 1 AND rp.position IS NOT NULL
       ORDER BY r.match_id, r.number, rp.position`,
    )
    .bind(json(matchIds))
    .all<{ matchId: number; number: number; playerId: number }>();
  let last: { matchId: number; number: number } | null = null;
  for (const row of results) {
    const rounds = byMatch.get(row.matchId)!;
    if (last?.matchId !== row.matchId || last.number !== row.number) rounds.push([]);
    rounds[rounds.length - 1]!.push(row.playerId);
    last = row;
  }
  return byMatch;
}

export async function readRatings(db: D1Database, playerIds: readonly number[]): Promise<Map<number, StoredRating>> {
  if (!playerIds.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT player_id AS playerId, mu, sigma, display, rounds, wins, last_played_at AS lastPlayedAt
       FROM ratings WHERE board = ?1 AND player_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(board, json(playerIds))
    .all<StoredRating & { playerId: number }>();
  return new Map(results.map(({ playerId, ...rating }) => [playerId, rating]));
}

/** The stored history of these matches. */
export async function readHistory(db: D1Database, matchIds: readonly number[]): Promise<HistoryEntry[]> {
  if (!matchIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT player_id AS playerId, match_id AS matchId, played_at AS playedAt, mu, sigma, display, rounds, wins
       FROM rating_history WHERE board = ?1 AND match_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(board, json(matchIds))
    .all<HistoryEntry>();
  return results;
}

/** Each player's rating just before `from`: their last history row before it. */
export async function readRatingsBefore(
  db: D1Database,
  playerIds: readonly number[],
  from: MatchRef,
): Promise<Map<number, PlayerRating>> {
  if (!playerIds.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT h.player_id AS playerId, h.mu, h.sigma, h.rounds, h.wins, h.played_at AS lastPlayedAt
       FROM json_each(?2) p JOIN rating_history h ON h.board = ?1 AND h.player_id = p.value
         AND (h.played_at, h.match_id) = (
           SELECT played_at, match_id FROM rating_history
           WHERE board = ?1 AND player_id = p.value AND (played_at, match_id) < (?3, ?4)
           ORDER BY played_at DESC, match_id DESC LIMIT 1)`,
    )
    .bind(board, json(playerIds), from.playedAt, from.id)
    .all<PlayerRating & { playerId: number }>();
  return new Map(results.map(({ playerId, ...rating }) => [playerId, rating]));
}

/**
 * Fails the batch it's in (NOT NULL on `version`) unless the version is still `version`, and
 * moves it on otherwise. Put it first in every batch that writes ratings.
 */
export function lockStatement(db: D1Database, version: number): D1PreparedStatement {
  return db
    .prepare("UPDATE rating_state SET version = CASE WHEN version = ?2 THEN version + 1 END WHERE board = ?1")
    .bind(board, version);
}

/** The error a batch fails with when `lockStatement` found a newer version. */
export function isConflict(error: unknown): boolean {
  return String(error).includes("NOT NULL constraint failed: rating_state.version");
}

/**
 * Marks the ratings stale from the earliest of these matches, unless they're stale from earlier
 * already. With `onlyRated`, only matches that are rated count: for a batch that's changing them.
 */
export function staleFromMatchesStatement(db: D1Database, matchIds: readonly number[], now: string, onlyRated = false): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, ?3),
         stale_played_at = CASE WHEN stale_played_at IS NULL OR (m.played_at, m.id) < (stale_played_at, stale_match_id)
           THEN m.played_at ELSE stale_played_at END,
         stale_match_id = CASE WHEN stale_played_at IS NULL OR (m.played_at, m.id) < (stale_played_at, stale_match_id)
           THEN m.id ELSE stale_match_id END
       FROM (SELECT played_at, id FROM matches WHERE id IN (SELECT value FROM json_each(?2))
             AND (?4 = 0 OR rated_at IS NOT NULL) ORDER BY played_at, id LIMIT 1) AS m
       WHERE board = ?1`,
    )
    .bind(board, json(matchIds), now, onlyRated ? 1 : 0);
}

/** Marks the ratings stale from `from` (`fromStart` for everything). */
export function staleFromStatement(db: D1Database, from: MatchRef, now: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, ?4),
         stale_played_at = CASE WHEN stale_played_at IS NULL OR (?2, ?3) < (stale_played_at, stale_match_id)
           THEN ?2 ELSE stale_played_at END,
         stale_match_id = CASE WHEN stale_played_at IS NULL OR (?2, ?3) < (stale_played_at, stale_match_id)
           THEN ?3 ELSE stale_match_id END
       WHERE board = ?1`,
    )
    .bind(board, from.playedAt, from.id, now);
}

/** Moves the start of the stale range to `next`, or clears it when the recompute is done. */
export function staleUntilStatement(db: D1Database, next: MatchRef | null, now: string): D1PreparedStatement {
  return next
    ? db
        .prepare("UPDATE rating_state SET stale_played_at = ?2, stale_match_id = ?3, recomputed_at = ?4 WHERE board = ?1")
        .bind(board, next.playedAt, next.id, now)
    : db
        .prepare(
          "UPDATE rating_state SET stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = ?2 WHERE board = ?1",
        )
        .bind(board, now);
}

export function ratedAtStatement(db: D1Database, matchIds: readonly number[], ratedAt: string | null): D1PreparedStatement {
  return db
    .prepare("UPDATE matches SET rated_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(json(matchIds), ratedAt);
}

/** The statements that write a plan: only the rows that changed. */
export function writeStatements(db: D1Database, w: RatingWrites): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (w.historyRemove.length) {
    statements.push(
      db
        .prepare(
          `DELETE FROM rating_history WHERE board = ?1 AND (player_id, played_at, match_id) IN
           (SELECT e.value ->> 'playerId', e.value ->> 'playedAt', e.value ->> 'matchId' FROM json_each(?2) e)`,
        )
        .bind(board, json(w.historyRemove)),
    );
  }
  if (w.historyUpsert.length) {
    statements.push(
      db
        .prepare(
          `INSERT INTO rating_history (board, player_id, match_id, played_at, mu, sigma, display, rounds, wins)
           SELECT ?1, e.value ->> 'playerId', e.value ->> 'matchId', e.value ->> 'playedAt', e.value ->> 'mu',
             e.value ->> 'sigma', e.value ->> 'display', e.value ->> 'rounds', e.value ->> 'wins'
           FROM json_each(?2) e WHERE true
           ON CONFLICT (board, player_id, played_at, match_id) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma,
             display = excluded.display, rounds = excluded.rounds, wins = excluded.wins`,
        )
        .bind(board, json(w.historyUpsert)),
    );
  }
  if (w.ratingsUpsert.length) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ratings (board, player_id, mu, sigma, display, rounds, wins, last_played_at)
           SELECT ?1, e.value ->> 'playerId', e.value ->> 'mu', e.value ->> 'sigma', e.value ->> 'display',
             e.value ->> 'rounds', e.value ->> 'wins', e.value ->> 'lastPlayedAt'
           FROM json_each(?2) e WHERE true
           ON CONFLICT (board, player_id) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma, display = excluded.display,
             rounds = excluded.rounds, wins = excluded.wins, last_played_at = excluded.last_played_at`,
        )
        .bind(board, json(w.ratingsUpsert)),
    );
  }
  if (w.ratingsRemove.length) {
    statements.push(
      db
        .prepare("DELETE FROM ratings WHERE board = ?1 AND player_id IN (SELECT value FROM json_each(?2))")
        .bind(board, json(w.ratingsRemove)),
    );
  }
  return statements;
}
