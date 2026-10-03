import {
  compareMatches,
  displayRating,
  rateMatch,
  type HistoryEntry,
  type PlayerRating,
  type RatingConfig,
  type RatingMatch,
  type Ratings,
} from "./engine";

/**
 * What re-rating some matches changes in D1, decided before anything is written. Pure: the caller
 * reads the ratings to start from and what's stored, and writes only the rows that differ
 * (docs/database.md, "Rows read").
 *
 * Rating a new match is the same thing with one match, starting from the current ratings.
 */

/** A row of `ratings`. */
export interface StoredRating extends PlayerRating {
  display: number;
}

export interface RerateInput {
  /** Each player's rating just before the first match. A player who isn't here starts new. */
  start: ReadonlyMap<number, PlayerRating>;
  /** The matches that count, in any order: they are rated in play order. */
  matches: readonly RatingMatch[];
  /** The stored history of every match being re-rated, counted or not. */
  history: readonly HistoryEntry[];
  /** The stored ratings rows of the players in `matches` and `history`. */
  ratings: ReadonlyMap<number, StoredRating>;
}

export interface RatingWrites {
  /** History rows to delete: matches that no longer count, or a row whose `playedAt` moved. */
  historyRemove: HistoryEntry[];
  /** History rows to insert or overwrite. */
  historyUpsert: HistoryEntry[];
  /** Ratings rows to insert or overwrite. */
  ratingsUpsert: (StoredRating & { playerId: number })[];
  /** Players who have no rated match any more: their ratings row goes. */
  ratingsRemove: number[];
}

export function planRerate(input: RerateInput, config: RatingConfig): RatingWrites {
  const ratings: Ratings = new Map([...input.start].map(([id, rating]) => [id, { ...rating }]));
  const computed = [...input.matches].sort(compareMatches).flatMap((match) => rateMatch(ratings, match, config));

  const key = (entry: HistoryEntry) => `${entry.playerId}:${entry.matchId}`;
  const stored = new Map(input.history.map((entry) => [key(entry), entry]));
  const computedByKey = new Map(computed.map((entry) => [key(entry), entry]));

  const historyUpsert = computed.filter((entry) => !sameEntry(stored.get(key(entry)), entry));
  const historyRemove = input.history.filter((entry) => computedByKey.get(key(entry))?.playedAt !== entry.playedAt);

  const players = new Set([...computed, ...input.history].map((entry) => entry.playerId));
  const ratingsUpsert: RatingWrites["ratingsUpsert"] = [];
  const ratingsRemove: number[] = [];
  for (const playerId of players) {
    const rating = ratings.get(playerId);
    const current = input.ratings.get(playerId);
    if (!rating) {
      if (current) ratingsRemove.push(playerId);
      continue;
    }
    const row = { ...rating, display: displayRating(rating, config) };
    if (!sameRating(current, row)) ratingsUpsert.push({ playerId, ...row });
  }
  return { historyRemove, historyUpsert, ratingsUpsert, ratingsRemove };
}

/** Whether the plan writes nothing. */
export function isEmpty(writes: RatingWrites): boolean {
  return !writes.historyRemove.length && !writes.historyUpsert.length && !writes.ratingsUpsert.length && !writes.ratingsRemove.length;
}

function sameEntry(a: HistoryEntry | undefined, b: HistoryEntry): boolean {
  return (
    a !== undefined &&
    a.playedAt === b.playedAt &&
    a.mu === b.mu &&
    a.sigma === b.sigma &&
    a.display === b.display &&
    a.rounds === b.rounds &&
    a.wins === b.wins
  );
}

function sameRating(a: StoredRating | undefined, b: StoredRating): boolean {
  return (
    a !== undefined &&
    a.mu === b.mu &&
    a.sigma === b.sigma &&
    a.display === b.display &&
    a.rounds === b.rounds &&
    a.wins === b.wins &&
    a.lastPlayedAt === b.lastPlayedAt
  );
}
