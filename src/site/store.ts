import { board } from "../rating/store";
import { workshopStringMax } from "./rankTags";

/**
 * The public site's D1 queries (#14). Read-only, and each one reads through an index, so a page
 * view costs tens of rows (docs/database.md, "Free tier"). Only `accepted` and `void` matches are
 * public; a match in review or rejected doesn't exist here.
 */

const publicStatuses = "('accepted', 'void')";

/** The tourney lobby a match was played in (#31). */
export interface TourneyRef {
  id: number;
  name: string;
  lobby: string;
}

/** `tourney`: a match's `TourneyRef` as JSON, or NULL. Reads through the lobby's unique `match_id`. */
const tourneyRef = `(SELECT json_object('id', t.id, 'name', t.name, 'lobby', l.label)
  FROM tourney_lobbies l JOIN tourneys t ON t.id = l.tourney_id WHERE l.match_id = m.id) AS tourney`;

export interface RatingRow {
  playerId: number;
  name: string;
  display: number;
  rounds: number;
  wins: number;
  lastPlayedAt: string | null;
}

const ratingColumns = `r.player_id AS playerId, p.name, r.display, r.rounds, r.wins, r.last_played_at AS lastPlayedAt`;

/** A leaderboard page: players with at least `minRounds` rated rounds, best first (index `ratings_board_display`). */
export async function listLeaderboard(db: D1Database, minRounds: number, limit: number, offset: number): Promise<RatingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ratingColumns} FROM ratings r JOIN players p ON p.id = r.player_id
       WHERE r.board = ?1 AND r.rounds >= ?2 ORDER BY r.display DESC, r.player_id LIMIT ?3 OFFSET ?4`,
    )
    .bind(board, minRounds, limit, offset)
    .all<RatingRow>();
  return results;
}

/**
 * Who may get a rank tag, best first: at least `minRounds` rated rounds, a display rating of at
 * least `minDisplay` (the lowest tier) and a rated round since `activeSince`. Names the Workshop
 * can't hold are left out here, so they don't use up the `limit` (index `ratings_board_display`).
 */
export async function listTagCandidates(
  db: D1Database,
  minRounds: number,
  minDisplay: number,
  activeSince: string,
  limit: number,
): Promise<RatingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ratingColumns} FROM ratings r JOIN players p ON p.id = r.player_id
       WHERE r.board = ?1 AND r.display >= ?2 AND r.rounds >= ?3 AND r.last_played_at >= ?4
         AND length(p.name) BETWEEN 1 AND ?6 AND instr(p.name, '{') = 0 AND instr(p.name, '}') = 0
       ORDER BY r.display DESC, r.player_id LIMIT ?5`,
    )
    .bind(board, minDisplay, minRounds, activeSince, limit, workshopStringMax)
    .all<RatingRow>();
  return results;
}

export async function findRating(db: D1Database, playerId: number): Promise<RatingRow | null> {
  return db
    .prepare(`SELECT ${ratingColumns} FROM ratings r JOIN players p ON p.id = r.player_id WHERE r.board = ?1 AND r.player_id = ?2`)
    .bind(board, playerId)
    .first<RatingRow>();
}

/** The player's place on the leaderboard, in the order `listLeaderboard` uses. */
export async function rankOf(db: D1Database, rating: RatingRow, minRounds: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM ratings
       WHERE board = ?1 AND rounds >= ?2 AND (display > ?3 OR (display = ?3 AND player_id < ?4))`,
    )
    .bind(board, minRounds, rating.display, rating.playerId)
    .first<{ rank: number }>();
  return row!.rank;
}

export interface PlayerRow {
  id: number;
  name: string;
  aliases: string[];
}

export async function findPlayer(db: D1Database, id: number): Promise<PlayerRow | null> {
  const row = await db
    .prepare(
      `SELECT p.id, p.name,
         (SELECT json_group_array(name) FROM (SELECT a.name FROM aliases a WHERE a.player_id = p.id ORDER BY a.last_seen_at DESC)) AS aliases
       FROM players p WHERE p.id = ?`,
    )
    .bind(id)
    .first<{ id: number; name: string; aliases: string }>();
  return row && { ...row, aliases: JSON.parse(row.aliases) as string[] };
}

export interface PlayerSearchRow {
  id: number;
  name: string;
  /** The display rating, or null with no rated round. */
  display: number | null;
  rounds: number;
  lastPlayedAt: string | null;
  /** The old name that matched, when the current name matched less well (or not at all). */
  matchedAlias: string | null;
}

/**
 * Players whose name or an old name contains `key` (a `nameKey`), at most `limit`: exact names
 * first, then names starting with it, then the rest, each by rating. A player counts once, by their
 * best-matching name, the current name winning a tie. Reads every alias once (a "contains" can't use
 * an index), then the players and ratings of the hits by their keys.
 */
export async function searchPlayers(db: D1Database, key: string, limit: number): Promise<PlayerSearchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, display, rounds, lastPlayedAt, CASE WHEN alias = name THEN NULL ELSE alias END AS matchedAlias
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY score, alias = name DESC, aliasSeenAt DESC) AS nth
         FROM (
           SELECT a.player_id AS id, p.name, a.name AS alias, a.last_seen_at AS aliasSeenAt,
             r.display, coalesce(r.rounds, 0) AS rounds, r.last_played_at AS lastPlayedAt,
             CASE WHEN a.name_key = ?1 THEN 0 WHEN substr(a.name_key, 1, length(?1)) = ?1 THEN 1 ELSE 2 END AS score
           FROM aliases a JOIN players p ON p.id = a.player_id
           LEFT JOIN ratings r ON r.board = ?2 AND r.player_id = a.player_id
           WHERE instr(a.name_key, ?1) > 0
         )
       )
       WHERE nth = 1
       ORDER BY score, display IS NULL, display DESC, id LIMIT ?3`,
    )
    .bind(key, board, limit)
    .all<PlayerSearchRow>();
  return results;
}

export interface PlayerMatchRow {
  id: number;
  playedAt: string;
  map: string | null;
  legacy: boolean;
  void: boolean;
  /** A tournament: counts more on the leaderboard (`tournamentWeight`). */
  tournament: boolean;
  /** The tourney it was a lobby of, if an admin linked it. */
  tourney: TourneyRef | null;
  /** The player's display rating after the match, and before it. Null when the match isn't rated (for them). */
  ratingAfter: number | null;
  ratingBefore: number | null;
}

/**
 * The player's newest public matches. Newest by id, through index `match_players_player`, so the
 * page doesn't read every match the player was ever in; a match uploaded late can sort out of play
 * order, which the page shows by its date anyway. Group and sort on `mp.match_id`, not `m.id`:
 * then SQLite walks the index and stops at the limit instead of grouping the whole history.
 */
export async function listPlayerMatches(db: D1Database, playerId: number, limit: number): Promise<PlayerMatchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.played_at AS playedAt, m.map, m.legacy, m.status = 'void' AS void, m.tournament, ${tourneyRef},
         (SELECT h.display FROM rating_history h
          WHERE h.board = ?1 AND h.player_id = ?2 AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
         (SELECT h.display FROM rating_history h
          WHERE h.board = ?1 AND h.player_id = ?2 AND (h.played_at, h.match_id) < (m.played_at, m.id)
          ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ?2 AND m.status IN ${publicStatuses}
       GROUP BY mp.match_id ORDER BY mp.match_id DESC LIMIT ?3`,
    )
    .bind(board, playerId, limit)
    .all<Omit<PlayerMatchRow, "legacy" | "void" | "tournament" | "tourney"> & { legacy: number; void: number; tournament: number; tourney: string | null }>();
  return results.map((m) => ({
    ...m,
    legacy: m.legacy === 1,
    void: m.void === 1,
    tournament: m.tournament === 1,
    tourney: m.tourney === null ? null : (JSON.parse(m.tourney) as TourneyRef),
    ratingBefore: m.ratingAfter === null ? null : m.ratingBefore,
  }));
}

export interface MatchRow {
  id: number;
  playedAt: string;
  map: string | null;
  preset: string | null;
  gameVersion: string;
  legacy: boolean;
  void: boolean;
  complete: boolean;
  tournament: boolean;
  tourney: TourneyRef | null;
}

export interface MatchPlayerRow {
  logId: number;
  playerId: number;
  name: string;
  ratingAfter: number | null;
  ratingBefore: number | null;
}

export interface RoundRow {
  id: number;
  number: number;
  result: "WIN" | "NONE" | "ABORT";
  winnerId: number | null;
  rated: boolean;
  broken: string | null;
}

export interface RoundPlayerRow {
  roundId: number;
  logId: number;
  position: number | null;
  place: number | null;
  left: boolean;
}

export interface MatchDetail {
  match: MatchRow;
  players: MatchPlayerRow[];
  rounds: RoundRow[];
  roundPlayers: RoundPlayerRow[];
}

/**
 * A public match with its players, rounds and placements, in one batch. Null if it isn't public.
 * Every statement checks the status, so asking for a match in review reads one row, not all of it.
 */
export async function findMatchDetail(db: D1Database, id: number): Promise<MatchDetail | null> {
  const [match, players, rounds, roundPlayers] = await db.batch([
    db
      .prepare(
        `SELECT m.id, m.played_at AS playedAt, m.map, m.preset, m.game_version AS gameVersion, m.legacy, m.status = 'void' AS void,
           m.complete, m.tournament, ${tourneyRef}
         FROM matches m WHERE m.id = ?1 AND m.status IN ${publicStatuses}`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT mp.log_id AS logId, mp.player_id AS playerId, mp.name,
           (SELECT h.display FROM rating_history h
            WHERE h.board = ?2 AND h.player_id = mp.player_id AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
           (SELECT h.display FROM rating_history h
            WHERE h.board = ?2 AND h.player_id = mp.player_id AND (h.played_at, h.match_id) < (m.played_at, m.id)
            ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.match_id = ?1 AND m.status IN ${publicStatuses} ORDER BY mp.log_id`,
      )
      .bind(id, board),
    db
      .prepare(
        `SELECT r.id, r.number, r.result, r.winner_id AS winnerId, r.rated, r.broken
         FROM matches m JOIN rounds r ON r.match_id = m.id
         WHERE m.id = ? AND m.status IN ${publicStatuses} ORDER BY r.number`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT rp.round_id AS roundId, rp.log_id AS logId, rp.position, rp.place, rp.left_round AS "left"
         FROM matches m JOIN rounds r ON r.match_id = m.id JOIN round_players rp ON rp.round_id = r.id
         WHERE m.id = ? AND m.status IN ${publicStatuses}`,
      )
      .bind(id),
  ]);
  type Raw = Omit<MatchRow, "legacy" | "void" | "complete" | "tournament" | "tourney"> &
    Record<"legacy" | "void" | "complete" | "tournament", number> & { tourney: string | null };
  const row = match!.results[0] as Raw | undefined;
  if (!row) return null;
  return {
    match: {
      ...row,
      legacy: row.legacy === 1,
      void: row.void === 1,
      complete: row.complete === 1,
      tournament: row.tournament === 1,
      tourney: row.tourney === null ? null : (JSON.parse(row.tourney) as TourneyRef),
    },
    players: (players!.results as MatchPlayerRow[]).map((p) => ({ ...p, ratingBefore: p.ratingAfter === null ? null : p.ratingBefore })),
    rounds: (rounds!.results as (Omit<RoundRow, "rated"> & { rated: number })[]).map((r) => ({ ...r, rated: r.rated === 1 })),
    roundPlayers: (roundPlayers!.results as (Omit<RoundPlayerRow, "left"> & { left: number })[]).map((rp) => ({ ...rp, left: rp.left === 1 })),
  };
}

export interface FeedPlayerRow {
  id: number;
  name: string;
  /** Rated rounds the player finished in this match, and won. */
  rounds: number;
  wins: number;
  ratingAfter: number | null;
  ratingBefore: number | null;
}

export type FeedMatchRow =
  | {
      id: number;
      removed: false;
      playedAt: string;
      map: string | null;
      legacy: boolean;
      void: boolean;
      complete: boolean;
      tournament: boolean;
      tourney: TourneyRef | null;
      rounds: number;
      ratedRounds: number;
      players: FeedPlayerRow[];
    }
  | { id: number; removed: true };

/** The newest change number of the match feed: where a reader starting now begins. */
export async function latestFeedSeq(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT coalesce(max(feed_seq), 0) AS seq FROM matches").first<{ seq: number }>();
  return row!.seq;
}

/**
 * The match feed (#59): matches whose `feed_seq` is past `after`, oldest change first, at most
 * `limit`, each with its players and its change number. A match that stopped being public is only
 * its id, `removed`.
 * Reads through index `matches_feed`, so asking when nothing changed reads no match rows.
 */
export async function listFeed(db: D1Database, after: number, limit: number): Promise<{ seq: number; match: FeedMatchRow }[]> {
  const page = "SELECT id FROM matches WHERE feed_seq > ?1 ORDER BY feed_seq LIMIT ?2";
  const [matches, players] = await db.batch([
    db
      .prepare(
        `SELECT m.id, m.feed_seq AS seq, m.status NOT IN ${publicStatuses} AS removed, m.played_at AS playedAt, m.map, m.legacy,
           m.status = 'void' AS void, m.complete, m.tournament, ${tourneyRef},
           (SELECT COUNT(*) FROM rounds r WHERE r.match_id = m.id) AS rounds,
           (SELECT COUNT(*) FROM rounds r WHERE r.match_id = m.id AND r.rated = 1) AS ratedRounds
         FROM matches m WHERE m.feed_seq > ?1 ORDER BY m.feed_seq LIMIT ?2`,
      )
      .bind(after, limit),
    // A player who rejoined has two log ids: one row, with the name they last joined as.
    db
      .prepare(
        `SELECT mp.match_id AS matchId, mp.player_id AS id, mp.name, max(mp.log_id) AS logId,
           (SELECT COUNT(*) FROM rounds r JOIN round_players rp ON rp.round_id = r.id
            WHERE r.match_id = mp.match_id AND r.rated = 1 AND rp.player_id = mp.player_id AND rp.position IS NOT NULL) AS rounds,
           (SELECT COUNT(*) FROM rounds r JOIN round_players rp ON rp.round_id = r.id
            WHERE r.match_id = mp.match_id AND r.rated = 1 AND rp.player_id = mp.player_id AND rp.position = 1) AS wins,
           (SELECT h.display FROM rating_history h
            WHERE h.board = ?3 AND h.player_id = mp.player_id AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
           (SELECT h.display FROM rating_history h
            WHERE h.board = ?3 AND h.player_id = mp.player_id AND (h.played_at, h.match_id) < (m.played_at, m.id)
            ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.match_id IN (${page}) AND m.status IN ${publicStatuses}
         GROUP BY mp.match_id, mp.player_id ORDER BY mp.match_id, wins DESC, mp.player_id`,
      )
      .bind(after, limit, board),
  ]);
  type RawMatch = { id: number; seq: number; removed: number; playedAt: string; map: string | null; tourney: string | null; rounds: number; ratedRounds: number } & Record<
    "legacy" | "void" | "complete" | "tournament",
    number
  >;
  const byMatch = new Map<number, FeedPlayerRow[]>();
  for (const p of players!.results as (FeedPlayerRow & { matchId: number })[]) {
    const list = byMatch.get(p.matchId) ?? [];
    list.push({ id: p.id, name: p.name, rounds: p.rounds, wins: p.wins, ratingAfter: p.ratingAfter, ratingBefore: p.ratingAfter === null ? null : p.ratingBefore });
    byMatch.set(p.matchId, list);
  }
  return (matches!.results as RawMatch[]).map(({ seq, ...m }) => ({
    seq,
    match: m.removed === 1
      ? { id: m.id, removed: true }
      : {
          ...m,
          removed: false,
          legacy: m.legacy === 1,
          void: m.void === 1,
          complete: m.complete === 1,
          tournament: m.tournament === 1,
          tourney: m.tourney === null ? null : (JSON.parse(m.tourney) as TourneyRef),
          players: byMatch.get(m.id) ?? [],
        },
  }));
}
