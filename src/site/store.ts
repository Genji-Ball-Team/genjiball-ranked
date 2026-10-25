import { workshopStringMax } from "./rankTags";
import type { FormRound, StoredHistoryRow } from "./history";

/**
 * The public site's D1 queries (#14). Read-only, and each one reads through an index, so a page
 * view costs tens of rows (docs/database.md, "Free tier"). Only `accepted` and `void` matches are
 * public; a match in review or rejected doesn't exist here. Ratings are per region (#47): a region's
 * leaderboard is the `ratings` rows whose `board` is its id, and a match's ratings are on its
 * region's board (`h.board = m.region`).
 */

const publicStatuses = "('accepted', 'void')";

/** Alt accounts (`players.alt`): rated, but off the leaderboard and not counted in its places (index `players_alt`). */
const notAlt = (idSql: string) => `${idSql} NOT IN (SELECT id FROM players WHERE alt = 1)`;

/** The tourney lobby a match was played in (#31). */
export interface TourneyRef {
  id: number;
  name: string;
  lobby: string;
}

/** A match's `tourney` column: a `TourneyRef` as JSON, or NULL. */
function parseTourney(value: string | null): TourneyRef | null {
  return value === null ? null : (JSON.parse(value) as TourneyRef);
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

/** A leaderboard row, with the display rating the player had before `changeSince` (null when they had none yet). */
export interface LeaderboardRow extends RatingRow {
  displayBefore: number | null;
}

/**
 * A leaderboard page: players with at least `minRounds` rated rounds, best first, alts left out (index
 * `ratings_board_display`). With `activeSince`, only those who played a rated round since then, and the
 * places count only them. `displayBefore` is one seek per row in `rating_history`'s key.
 */
export async function listLeaderboard(
  db: D1Database,
  board: string,
  minRounds: number,
  limit: number,
  offset: number,
  changeSince: string,
  activeSince: string | null,
): Promise<LeaderboardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ratingColumns},
         (SELECT h.display FROM rating_history h WHERE h.board = r.board AND h.player_id = r.player_id AND h.played_at < ?5
          ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS displayBefore
       FROM ratings r JOIN players p ON p.id = r.player_id
       WHERE r.board = ?1 AND r.rounds >= ?2 AND p.alt = 0 AND (?6 IS NULL OR r.last_played_at >= ?6)
       ORDER BY r.display DESC, r.player_id LIMIT ?3 OFFSET ?4`,
    )
    .bind(board, minRounds, limit, offset, changeSince, activeSince)
    .all<LeaderboardRow>();
  return results;
}

/**
 * Who may get a rank tag, best first: at least `minRounds` rated rounds, a display rating of at
 * least `minDisplay` (the lowest tier) and a rated round since `activeSince`. `name` is the name the
 * player was last seen with in a log, which is what the game shows: the display name, unless an
 * admin set another one (#8). Names the Workshop can't hold are left out here, so they don't use up the
 * `limit` (index `ratings_board_display`).
 */
export async function listTagCandidates(
  db: D1Database,
  board: string,
  minRounds: number,
  minDisplay: number,
  activeSince: string,
  limit: number,
): Promise<RatingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT r.player_id AS playerId, r.display, r.rounds, r.wins, r.last_played_at AS lastPlayedAt,
           CASE WHEN p.name_fixed = 0 THEN p.name ELSE coalesce((SELECT a.name FROM aliases a WHERE a.player_id = p.id
             ORDER BY a.last_seen_at DESC, a.id DESC LIMIT 1), p.name) END AS name
         FROM ratings r JOIN players p ON p.id = r.player_id
         WHERE r.board = ?1 AND r.display >= ?2 AND r.rounds >= ?3 AND r.last_played_at >= ?4
       )
       WHERE length(name) BETWEEN 1 AND ?6 AND instr(name, '{') = 0 AND instr(name, '}') = 0
       ORDER BY display DESC, playerId LIMIT ?5`,
    )
    .bind(board, minDisplay, minRounds, activeSince, limit, workshopStringMax)
    .all<RatingRow>();
  return results;
}

export async function findRating(db: D1Database, board: string, playerId: number): Promise<RatingRow | null> {
  return db
    .prepare(`SELECT ${ratingColumns} FROM ratings r JOIN players p ON p.id = r.player_id WHERE r.board = ?1 AND r.player_id = ?2`)
    .bind(board, playerId)
    .first<RatingRow>();
}

/**
 * The players the asked ids are now: an id merged into another (#8) is the player it was merged
 * into. Ids that aren't a player are left out.
 */
export async function findCanonicalIds(db: D1Database, ids: readonly number[]): Promise<Map<number, number>> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE chain(asked, id, merged_into) AS (
         SELECT id, id, merged_into FROM players WHERE id IN (SELECT value FROM json_each(?1))
         UNION
         SELECT c.asked, p.id, p.merged_into FROM players p JOIN chain c ON p.id = c.merged_into
       )
       SELECT asked, id FROM chain WHERE merged_into IS NULL`,
    )
    .bind(JSON.stringify(ids))
    .all<{ asked: number; id: number }>();
  return new Map(results.map((r) => [r.asked, r.id]));
}

/** Every rating of these players, in any region (`board`). */
export async function listRatingsOf(db: D1Database, ids: readonly number[]): Promise<(RatingRow & { board: string })[]> {
  const { results } = await db
    .prepare(`SELECT r.board, ${ratingColumns} FROM ratings r JOIN players p ON p.id = r.player_id WHERE r.player_id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(ids))
    .all<RatingRow & { board: string }>();
  return results;
}

/** These players' ratings on one board with their place on its leaderboard, as `rankOf` counts it. Those not on it (alts too) are left out. */
export async function listRanked(db: D1Database, board: string, ids: readonly number[], minRounds: number): Promise<(RatingRow & { rank: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ratingColumns},
         (SELECT COUNT(*) + 1 FROM ratings o WHERE o.board = ?1 AND o.rounds >= ?3
           AND (o.display > r.display OR (o.display = r.display AND o.player_id < r.player_id)) AND ${notAlt("o.player_id")}) AS rank
       FROM ratings r JOIN players p ON p.id = r.player_id
       WHERE r.board = ?1 AND r.rounds >= ?3 AND p.alt = 0 AND r.player_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(board, JSON.stringify(ids), minRounds)
    .all<RatingRow & { rank: number }>();
  return results;
}

/** The player's place on the leaderboard, in the order `listLeaderboard` uses: alts don't count. Not for an alt, which has none. */
export async function rankOf(db: D1Database, board: string, rating: RatingRow, minRounds: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM ratings
       WHERE board = ?1 AND rounds >= ?2 AND (display > ?3 OR (display = ?3 AND player_id < ?4)) AND ${notAlt("player_id")}`,
    )
    .bind(board, minRounds, rating.display, rating.playerId)
    .first<{ rank: number }>();
  return row!.rank;
}

/**
 * The regions (of `regions`, ids) the player has a rating in. `ratings` is keyed (board, player_id), so
 * `WHERE player_id = ?` alone scans the table; naming the boards makes each one a primary-key seek.
 */
export async function listRatedRegions(db: D1Database, playerId: number, regions: readonly string[]): Promise<string[]> {
  if (!regions.length) return [];
  const { results } = await db
    .prepare("SELECT board FROM ratings WHERE player_id = ?1 AND board IN (SELECT value FROM json_each(?2))")
    .bind(playerId, JSON.stringify(regions))
    .all<{ board: string }>();
  return results.map((r) => r.board);
}

export interface PlayerRow {
  id: number;
  name: string;
  aliases: string[];
  /** The player an admin merged this one into (#8), or null. */
  mergedInto: number | null;
  /** An admin marked them an alt account: no place on the leaderboard. */
  alt: boolean;
}

/**
 * The player an id answers for: a player an admin merged into another (#8) answers as that one.
 * Follows any number of merges in one query. UNION also stops a corrupt cycle.
 */
export async function findCanonicalPlayer(db: D1Database, id: number): Promise<PlayerRow | null> {
  const row = await db
    .prepare(
      `WITH RECURSIVE chain(id, merged_into) AS (
         SELECT id, merged_into FROM players WHERE id = ?1
         UNION
         SELECT p.id, p.merged_into FROM players p JOIN chain c ON p.id = c.merged_into
       )
       SELECT p.id, p.name, p.merged_into AS mergedInto, p.alt,
         (SELECT json_group_array(name) FROM (SELECT a.name FROM aliases a WHERE a.player_id = p.id ORDER BY a.last_seen_at DESC)) AS aliases
       FROM players p WHERE p.id = (SELECT id FROM chain WHERE merged_into IS NULL)`,
    )
    .bind(id)
    .first<{ id: number; name: string; mergedInto: number | null; alt: number; aliases: string }>();
  return row && { ...row, alt: row.alt === 1, aliases: JSON.parse(row.aliases) as string[] };
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
 * best-matching name, the current name winning a tie. Ratings are the region's (`board`); with
 * `onlyRated`, players with no rating there are left out. Reads every alias once (a "contains" can't
 * use an index), then the players and ratings of the hits by their keys.
 */
export async function searchPlayers(db: D1Database, key: string, board: string, onlyRated: boolean, limit: number): Promise<PlayerSearchRow[]> {
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
           WHERE instr(a.name_key, ?1) > 0 AND (?4 = 0 OR r.player_id IS NOT NULL)
         )
       )
       WHERE nth = 1
       ORDER BY score, display IS NULL, display DESC, id LIMIT ?3`,
    )
    .bind(key, board, limit, onlyRated ? 1 : 0)
    .all<PlayerSearchRow>();
  return results;
}

export interface PlayerMatchRow {
  id: number;
  playedAt: string;
  map: string | null;
  legacy: boolean;
  void: boolean;
  /** A tournament: its standings are rated too (docs/rating.md, "Tournaments"). */
  tournament: boolean;
  /** The tourney it was a lobby of, if an admin linked it. */
  tourney: TourneyRef | null;
  /** The player's display rating after the match, and before it. Null when the match isn't rated (for them). */
  ratingAfter: number | null;
  ratingBefore: number | null;
}

/**
 * The player's newest public matches in the region. Newest by id, through index `match_players_player`, so the
 * page doesn't read every match the player was ever in; a match uploaded late can sort out of play
 * order, which the page shows by its date anyway. Group and sort on `mp.match_id`, not `m.id`:
 * then SQLite walks the index and stops at the limit instead of grouping the whole history.
 */
export async function listPlayerMatches(
  db: D1Database,
  board: string,
  playerId: number,
  limit: number,
  before: number | null = null,
): Promise<PlayerMatchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.played_at AS playedAt, m.map, m.legacy, m.status = 'void' AS void, m.tournament, ${tourneyRef},
         (SELECT h.display FROM rating_history h
          WHERE h.board = ?1 AND h.player_id = ?2 AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
         (SELECT h.display FROM rating_history h
          WHERE h.board = ?1 AND h.player_id = ?2 AND (h.played_at, h.match_id) < (m.played_at, m.id)
          ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ?2 AND m.status IN ${publicStatuses} AND m.region = ?1 AND (?4 IS NULL OR mp.match_id < ?4)
       GROUP BY mp.match_id ORDER BY mp.match_id DESC LIMIT ?3`,
    )
    .bind(board, playerId, limit, before)
    .all<Omit<PlayerMatchRow, "legacy" | "void" | "tournament" | "tourney"> & { legacy: number; void: number; tournament: number; tourney: string | null }>();
  return results.map((m) => ({
    ...m,
    legacy: m.legacy === 1,
    void: m.void === 1,
    tournament: m.tournament === 1,
    tourney: parseTourney(m.tourney),
    ratingBefore: m.ratingAfter === null ? null : m.ratingBefore,
  }));
}

/** A player's rounds won and kills in one match, their log ids added up. */
export interface MatchTotalRow {
  matchId: number;
  playerId: number;
  roundWins: number;
  kills: number;
}

/** Every player's totals in these matches, from `match_players` alone: their places follow from it. */
export async function listMatchTotals(db: D1Database, matchIds: number[]): Promise<MatchTotalRow[]> {
  if (!matchIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT match_id AS matchId, player_id AS playerId, SUM(round_wins) AS roundWins, SUM(kills) AS kills
       FROM match_players WHERE match_id IN (SELECT value FROM json_each(?1)) GROUP BY match_id, player_id`,
    )
    .bind(JSON.stringify(matchIds))
    .all<MatchTotalRow>();
  return results;
}

/** A match in the recent matches list. */
export interface RecentMatchRow {
  id: number;
  playedAt: string;
  map: string | null;
  legacy: boolean;
  void: boolean;
  tournament: boolean;
  tourney: TourneyRef | null;
  players: RecentPlayerRow[];
}

/** A player in a recent match: their totals, their log ids added up, and the rating it gave them. */
export interface RecentPlayerRow {
  id: number;
  name: string;
  roundWins: number;
  kills: number;
  ratingAfter: number | null;
  ratingBefore: number | null;
}

/**
 * The region's newest public matches by play time, older than match `before` when given, with their
 * players. Each status is walked down index `matches_region_status_played` and stops at the limit,
 * so a page reads about `limit` match rows, not the region's every match.
 */
export async function listRecentMatches(db: D1Database, board: string, limit: number, before: number | null): Promise<RecentMatchRow[]> {
  const older = before === null ? "" : "AND (played_at, id) < (SELECT played_at, id FROM matches WHERE id = ?3)";
  const newest = (status: string) =>
    `SELECT * FROM (SELECT id, played_at FROM matches WHERE region = ?1 AND status = '${status}' ${older} ORDER BY played_at DESC, id DESC LIMIT ?2)`;
  const page = `SELECT id FROM (${newest("accepted")} UNION ALL ${newest("void")}) ORDER BY played_at DESC, id DESC LIMIT ?2`;
  const params = before === null ? [board, limit] : [board, limit, before];
  const [matches, players] = await db.batch([
    db
      .prepare(
        `WITH page AS MATERIALIZED (${page})
         SELECT m.id, m.played_at AS playedAt, m.map, m.legacy, m.status = 'void' AS void, m.tournament, ${tourneyRef}
         FROM page CROSS JOIN matches m ON m.id = page.id ORDER BY m.played_at DESC, m.id DESC`,
      )
      .bind(...params),
    // A player who rejoined has two log ids: one row, their totals added up, with the name they last joined as.
    db
      .prepare(
        `WITH page AS MATERIALIZED (${page})
         SELECT mp.match_id AS matchId, mp.player_id AS id, mp.name, max(mp.log_id) AS logId,
           SUM(mp.round_wins) AS roundWins, SUM(mp.kills) AS kills,
           (SELECT h.display FROM rating_history h
            WHERE h.board = m.region AND h.player_id = mp.player_id AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
           (SELECT h.display FROM rating_history h
            WHERE h.board = m.region AND h.player_id = mp.player_id AND (h.played_at, h.match_id) < (m.played_at, m.id)
            ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
         FROM page CROSS JOIN match_players mp ON mp.match_id = page.id CROSS JOIN matches m ON m.id = mp.match_id
         GROUP BY mp.match_id, mp.player_id`,
      )
      .bind(...params),
  ]);
  type RawMatch = Omit<RecentMatchRow, "players" | "tourney" | "legacy" | "void" | "tournament"> & { tourney: string | null } & Record<"legacy" | "void" | "tournament", number>;
  const byMatch = new Map<number, RecentPlayerRow[]>();
  for (const p of players!.results as (RecentPlayerRow & { matchId: number })[]) {
    const list = byMatch.get(p.matchId) ?? [];
    list.push({ id: p.id, name: p.name, roundWins: p.roundWins, kills: p.kills, ratingAfter: p.ratingAfter, ratingBefore: p.ratingAfter === null ? null : p.ratingBefore });
    byMatch.set(p.matchId, list);
  }
  return (matches!.results as RawMatch[]).map((m) => ({
    ...m,
    legacy: m.legacy === 1,
    void: m.void === 1,
    tournament: m.tournament === 1,
    tourney: parseTourney(m.tourney),
    players: byMatch.get(m.id) ?? [],
  }));
}

export interface MatchRow {
  id: number;
  region: string;
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
  /** `KILL` lines with them as attacker, not a self-kill, in the whole match (between rounds too). */
  kills: number;
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
  /** The host, dropped from the round's rating as AFK (`X-Host-Afk`). */
  afk: boolean;
  /** Log id of the player whose deflect eliminated them (`ELIM` killer). */
  killerId: number | null;
  /** `KILL` lines in the round with them as attacker, not a self-kill. */
  kills: number;
  /** `DEFLECT` lines in the round. Null for legacy matches: their logs have none. */
  deflects: number | null;
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
        `SELECT m.id, m.region, m.played_at AS playedAt, m.map, m.preset, m.game_version AS gameVersion, m.legacy, m.status = 'void' AS void,
           m.complete, m.tournament, ${tourneyRef}
         FROM matches m WHERE m.id = ?1 AND m.status IN ${publicStatuses}`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT mp.log_id AS logId, mp.player_id AS playerId, mp.name, mp.kills,
           (SELECT h.display FROM rating_history h
            WHERE h.board = m.region AND h.player_id = mp.player_id AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
           (SELECT h.display FROM rating_history h
            WHERE h.board = m.region AND h.player_id = mp.player_id AND (h.played_at, h.match_id) < (m.played_at, m.id)
            ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.match_id = ?1 AND m.status IN ${publicStatuses} ORDER BY mp.log_id`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT r.id, r.number, r.result, r.winner_id AS winnerId, r.rated, r.broken
         FROM matches m JOIN rounds r ON r.match_id = m.id
         WHERE m.id = ? AND m.status IN ${publicStatuses} ORDER BY r.number`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT rp.round_id AS roundId, rp.log_id AS logId, rp.position, rp.place, rp.left_round AS "left", rp.afk, rp.killer_id AS killerId, rp.kills, rp.deflects
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
      tourney: parseTourney(row.tourney),
    },
    players: (players!.results as MatchPlayerRow[]).map((p) => ({ ...p, ratingBefore: p.ratingAfter === null ? null : p.ratingBefore })),
    rounds: (rounds!.results as (Omit<RoundRow, "rated"> & { rated: number })[]).map((r) => ({ ...r, rated: r.rated === 1 })),
    roundPlayers: (roundPlayers!.results as (Omit<RoundPlayerRow, "left" | "afk"> & { left: number; afk: number })[]).map((rp) => ({
      ...rp,
      left: rp.left === 1,
      afk: rp.afk === 1,
    })),
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
      region: string;
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
 * `limit`, in `region` or every region, each with its players and its change number. A match that
 * stopped being public, or with `region` was moved out of it, is only its id, `removed`. Ratings
 * are on the board of the match's region.
 * Reads through index `matches_feed`, so asking when nothing changed reads no match rows.
 */
export async function listFeed(
  db: D1Database,
  after: number,
  region: string | null,
  limit: number,
): Promise<{ seq: number; match: FeedMatchRow }[]> {
  // A match moved out of the region is listed there too, as removed (`feed_left_regions`).
  const inRegion = "(?3 IS NULL OR region = ?3 OR instr(feed_left_regions, ',' || ?3 || ',') > 0)";
  const page = `SELECT id FROM matches WHERE feed_seq > ?1 AND ${inRegion} ORDER BY feed_seq LIMIT ?2`;
  const [matches, players] = await db.batch([
    db
      .prepare(
        `SELECT m.id, m.feed_seq AS seq, m.status NOT IN ${publicStatuses} OR (?3 IS NOT NULL AND m.region IS NOT ?3) AS removed, m.region, m.played_at AS playedAt, m.map, m.legacy,
           m.status = 'void' AS void, m.complete, m.tournament, ${tourneyRef},
           (SELECT COUNT(*) FROM rounds r WHERE r.match_id = m.id) AS rounds,
           (SELECT COUNT(*) FROM rounds r WHERE r.match_id = m.id AND r.rated = 1) AS ratedRounds
         FROM matches m WHERE m.feed_seq > ?1 AND ${inRegion} ORDER BY m.feed_seq LIMIT ?2`,
      )
      .bind(after, limit, region),
    // A player who rejoined has two log ids: one row, with the name they last joined as.
    // Each page match's rounds and wins per player are counted once (`rs`), from its rounds and their
    // players by primary key. As a subquery per player this walked the player's every round
    // (`round_players_player`): about 880,000 rows on prod for a page of 20 matches, now about 7,000.
    // CROSS JOIN fixes the order: the page first, never `matches` as the outer loop.
    db
      .prepare(
        `WITH page AS MATERIALIZED (${page}),
         rs AS (
           SELECT r.match_id AS match_id, rp.player_id AS player_id, COUNT(*) AS rounds, coalesce(SUM(rp.position = 1), 0) AS wins
           FROM page CROSS JOIN rounds r ON r.match_id = page.id AND r.rated = 1
             CROSS JOIN round_players rp ON rp.round_id = r.id AND rp.position IS NOT NULL
           GROUP BY r.match_id, rp.player_id
         )
         SELECT mp.match_id AS matchId, mp.player_id AS id, mp.name, max(mp.log_id) AS logId,
           coalesce(rs.rounds, 0) AS rounds, coalesce(rs.wins, 0) AS wins,
           (SELECT h.display FROM rating_history h
            WHERE h.board = m.region AND h.player_id = mp.player_id AND h.played_at = m.played_at AND h.match_id = m.id) AS ratingAfter,
           (SELECT h.display FROM rating_history h
            WHERE h.board = m.region AND h.player_id = mp.player_id AND (h.played_at, h.match_id) < (m.played_at, m.id)
            ORDER BY h.played_at DESC, h.match_id DESC LIMIT 1) AS ratingBefore
         FROM page CROSS JOIN match_players mp ON mp.match_id = page.id CROSS JOIN matches m ON m.id = mp.match_id
           LEFT JOIN rs ON rs.match_id = mp.match_id AND rs.player_id = mp.player_id
         WHERE m.status IN ${publicStatuses}
         GROUP BY mp.match_id, mp.player_id ORDER BY mp.match_id, wins DESC, mp.player_id`,
      )
      .bind(after, limit, region),
  ]);
  type RawMatch = { id: number; seq: number; removed: number; region: string; playedAt: string; map: string | null; tourney: string | null; rounds: number; ratedRounds: number } & Record<
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
          tourney: parseTourney(m.tourney),
          players: byMatch.get(m.id) ?? [],
        },
  }));
}

/**
 * The player's rating history in a region (#17), in play order: one row per rated match that is
 * public in the region now. A match in review or rejected since it was rated stays out until the
 * recompute drops it; a voided one shows until then, as it's public. One row per match the player
 * was rated in, through the primary key of `rating_history`: a few thousand at most.
 */
export async function listHistory(db: D1Database, board: string, playerId: number): Promise<StoredHistoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT h.match_id AS matchId, h.played_at AS playedAt, h.display AS rating, h.streak, h.best_streak AS bestStreak
       FROM rating_history h JOIN matches m ON m.id = h.match_id
       WHERE h.board = ?1 AND h.player_id = ?2 AND m.status IN ${publicStatuses} AND m.region = ?1
       ORDER BY h.played_at, h.match_id`,
    )
    .bind(board, playerId)
    .all<StoredHistoryRow>();
  return results;
}

/**
 * Recent form (#17): the player's newest `limit` rated rounds in the region, newest first, of
 * matches public there now, with how many players were in each round's rated order.
 *
 * Reads the player's matches newest first (their `rating_history` rows, a few hundred at most) and,
 * match by match, each round and the player's own `round_players` row by the `(player_id, round_id)`
 * index, stopping at `limit`: the order is forced (CROSS JOIN, INDEXED BY) and matches ORDER BY, so
 * there's no sort of the player's every round (about 7,000 rows read for a regular, now about 300).
 */
export async function listFormRounds(db: D1Database, board: string, playerId: number, limit: number): Promise<FormRound[]> {
  const { results } = await db
    .prepare(
      `WITH newest AS MATERIALIZED (
         SELECT r.id AS roundId, r.match_id AS matchId, hm.played_at AS playedAt, r.number AS round, rp.position
         FROM (SELECT h.match_id, h.played_at FROM rating_history h JOIN matches m ON m.id = h.match_id
                WHERE h.board = ?1 AND h.player_id = ?2 AND m.status IN ${publicStatuses} AND m.region = ?1
                ORDER BY h.played_at DESC, h.match_id DESC) hm
           CROSS JOIN rounds r ON r.match_id = hm.match_id AND r.rated = 1
           CROSS JOIN round_players rp INDEXED BY round_players_player
             ON rp.round_id = r.id AND rp.player_id = ?2 AND rp.position IS NOT NULL
         ORDER BY hm.played_at DESC, hm.match_id DESC, r.number DESC LIMIT ?3
       )
       SELECT n.matchId, n.round, n.position,
         (SELECT COUNT(*) FROM round_players x WHERE x.round_id = n.roundId AND x.position IS NOT NULL) AS players
       FROM newest n ORDER BY n.playedAt DESC, n.matchId DESC, n.round DESC`,
    )
    .bind(board, playerId, limit)
    .all<FormRound>();
  return results;
}

export interface RivalRow {
  id: number;
  name: string;
  /** `KILL` lines of one on the other, in the direction asked for. */
  kills: number;
  /** Rated rounds both finished. */
  rounds: number;
}

/**
 * A player's most eliminated opponents (`mostEliminated`) and the opponents who eliminated them
 * most (`mostEliminatedBy`) in the region, at most `limit` each, most first, and their totals over
 * every opponent (`eliminations`: `kills` of theirs on another player, `deaths` by another player's
 * kill, so a fall or a self-kill is neither). Reads the player's `pair_stats` rows once (one per
 * opponent, through the primary key), and the names of the shown ones.
 */
export async function listRivals(
  db: D1Database,
  board: string,
  playerId: number,
  limit: number,
): Promise<{ mostEliminated: RivalRow[]; mostEliminatedBy: RivalRow[]; eliminations: { kills: number; deaths: number } }> {
  const { results } = await db
    .prepare(
      `SELECT s.opponent_id AS id, p.name, s.kills, s.deaths, s.rounds, s.byKills, s.byDeaths, s.totalKills, s.totalDeaths
       FROM (
         SELECT opponent_id, kills, deaths, rounds,
           ROW_NUMBER() OVER (ORDER BY kills DESC, opponent_id) AS byKills,
           ROW_NUMBER() OVER (ORDER BY deaths DESC, opponent_id) AS byDeaths,
           sum(kills) OVER () AS totalKills, sum(deaths) OVER () AS totalDeaths
         FROM pair_stats WHERE region = ?1 AND player_id = ?2 AND (kills > 0 OR deaths > 0)
       ) s JOIN players p ON p.id = s.opponent_id
       WHERE (s.byKills <= ?3 AND s.kills > 0) OR (s.byDeaths <= ?3 AND s.deaths > 0)`,
    )
    .bind(board, playerId, limit)
    .all<{
      id: number;
      name: string;
      kills: number;
      deaths: number;
      rounds: number;
      byKills: number;
      byDeaths: number;
      totalKills: number;
      totalDeaths: number;
    }>();
  const pick = (count: "kills" | "deaths", rank: "byKills" | "byDeaths") =>
    results
      .filter((r) => r[count] > 0 && r[rank] <= limit)
      .sort((a, b) => a[rank] - b[rank])
      .map((r) => ({ id: r.id, name: r.name, kills: r[count], rounds: r.rounds }));
  // Every row carries the totals; with any kill or death, the opponent ranked first by it is shown.
  const totals = results[0];
  return {
    mostEliminated: pick("kills", "byKills"),
    mostEliminatedBy: pick("deaths", "byDeaths"),
    eliminations: { kills: totals?.totalKills ?? 0, deaths: totals?.totalDeaths ?? 0 },
  };
}

export interface PlayerStatsRow {
  /** Rated rounds the player finished (`position` set) in the region's accepted matches. */
  rounds: number;
  /** Their `KILL`s in those rounds, as the match page counts a round's kills. */
  kills: number;
  /** Of those rounds, the ones whose log has deflects (not legacy): what `deflects` and `touches` are over. */
  deflectRounds: number;
  deflects: number;
  /** Deflects, plus being eliminated by a ball someone sent, as on the match page. */
  touches: number;
  /** Average finishing place in those rounds (1 = won), `null` with none. */
  averagePosition: number | null;
}

/**
 * A player's round stats in the region (#16), for compare: totals over the rated rounds they finished
 * in accepted matches (not void, review or rejected, like the head-to-head and the records). Reads the
 * player's `round_players` rows through `round_players_player`, with each one's round and match.
 */
export async function findPlayerStats(db: D1Database, board: string, playerId: number): Promise<PlayerStatsRow> {
  const row = await db
    .prepare(
      `SELECT count(*) AS rounds, coalesce(sum(rp.kills), 0) AS kills, count(rp.deflects) AS deflectRounds,
         coalesce(sum(rp.deflects), 0) AS deflects,
         coalesce(sum(rp.deflects + (rp.killer_id IS NOT NULL)), 0) AS touches, avg(rp.position) AS averagePosition
       FROM round_players rp JOIN rounds r ON r.id = rp.round_id JOIN matches m ON m.id = r.match_id
       WHERE rp.player_id = ?2 AND rp.position IS NOT NULL AND r.rated = 1 AND m.status = 'accepted' AND m.region = ?1`,
    )
    .bind(board, playerId)
    .first<PlayerStatsRow>();
  return row ?? { rounds: 0, kills: 0, deflectRounds: 0, deflects: 0, touches: 0, averagePosition: null };
}

export interface HeadToHeadRow {
  /** Rated rounds both finished. */
  rounds: number;
  /** Rounds `a` finished above `b`. */
  ahead: number;
  /** `KILL` lines of `a` on `b` and of `b` on `a`, anywhere in the matches. */
  kills: number;
  deaths: number;
  /** Of the rounds, the finals: the two finished 1st and 2nd, the last two alive. */
  finals: number;
  /** Finals `a` won. */
  finalWins: number;
}

/** Two players' record against each other in the region: one `pair_stats` row. Zeros if they never met. */
export async function findHeadToHead(db: D1Database, board: string, a: number, b: number): Promise<HeadToHeadRow> {
  const row = await db
    .prepare(
      `SELECT rounds, ahead, kills, deaths, finals, final_wins AS finalWins FROM pair_stats
       WHERE region = ?1 AND player_id = ?2 AND opponent_id = ?3`,
    )
    .bind(board, a, b)
    .first<HeadToHeadRow>();
  return row ?? { rounds: 0, ahead: 0, kills: 0, deaths: 0, finals: 0, finalWins: 0 };
}
