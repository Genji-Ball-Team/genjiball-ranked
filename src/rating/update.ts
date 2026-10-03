import type { Config } from "../config";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import type { RatingConfig } from "./engine";
import { planRerate } from "./plan";
import {
  compareRefs,
  fromStart,
  isConflict,
  lockStatement,
  ratedAtStatement,
  readAcceptedFrom,
  readHistory,
  readNewestRated,
  readNoLongerAccepted,
  readRatings,
  readRatingsBefore,
  readRounds,
  readState,
  readUnrated,
  staleFromMatchesStatement,
  staleFromStatement,
  staleUntilStatement,
  writeStatements,
  type CandidateMatch,
  type MatchRef,
} from "./store";

/**
 * Keeps the ratings in D1 up to date (docs/rating.md, "Ratings in the database").
 *
 * - `rateNewMatches`: after an upload, and on the cron. A match newer than every rated match is
 *   rated on top of the current ratings. An older one (a late upload) makes the ratings stale.
 * - `recomputeRatings`: on the cron while the ratings are stale. Re-rates from the first stale
 *   match on, a few matches a run, and writes only the rows that changed.
 * - `markMatchesChanged`, `markAllStale`: for whatever changes a rated match (a void, #7) or the
 *   rating itself (a config or engine change).
 */

export type UpdateConfig = RatingConfig & Pick<Config, "ratingIncompleteGraceHours" | "ratingMatchesPerRun">;

export interface RateNewResult {
  /** Matches rated on top of the current ratings. */
  rated: number;
  /** Matches older than the newest rated one: the ratings are stale from the first of them. */
  late: number;
  /** Another rating write landed first: nothing was written, the next run tries again. */
  conflict: boolean;
}

export interface RecomputeResult {
  /** The ratings were stale when the run started. */
  stale: boolean;
  /** Matches re-rated in this run. */
  rated: number;
  /** The ratings are up to date after this run. */
  done: boolean;
  conflict: boolean;
}

const hourMs = 60 * 60 * 1000;

/** A match counts once it's complete, or once its grace period has passed. */
function counts(match: CandidateMatch, config: UpdateConfig, now: Date): boolean {
  if (match.complete) return true;
  return Date.parse(match.playedAt) <= now.getTime() - config.ratingIncompleteGraceHours * hourMs;
}

export async function rateNewMatches(
  db: D1Database,
  config: UpdateConfig,
  now: Date,
  log: Logger,
  budget = config.ratingMatchesPerRun,
): Promise<RateNewResult> {
  const [state, unrated, newest] = await Promise.all([readState(db), readUnrated(db), readNewestRated(db)]);
  const due = unrated.filter((match) => counts(match, config, now));
  const isLate = (match: MatchRef) => newest !== null && compareRefs(match, newest) < 0;
  // A late match already inside the stale range needs nothing more.
  const late = due.filter((match) => isLate(match) && !(state.staleFrom && compareRefs(match, state.staleFrom) >= 0));
  const fresh = due.filter((match) => !isLate(match)).slice(0, Math.max(0, budget));
  if (!late.length && !fresh.length) return { rated: 0, late: 0, conflict: false };

  const stamp = isoSeconds(now);
  const statements = [lockStatement(db, state.version)];
  if (late.length) {
    statements.push(staleFromStatement(db, late[0]!, stamp));
    log.info("late matches: ratings stale", { from: late[0], matches: late.map((m) => m.id) });
  }
  if (fresh.length) {
    const rounds = await readRounds(db, fresh.map((m) => m.id));
    const players = [...new Set([...rounds.values()].flat(2))];
    const ratings = await readRatings(db, players);
    const writes = planRerate(
      {
        start: ratings,
        matches: fresh.map((m) => ({ id: m.id, playedAt: m.playedAt, rounds: rounds.get(m.id)! })),
        history: [],
        ratings,
      },
      config,
    );
    statements.push(...writeStatements(db, writes), ratedAtStatement(db, fresh.map((m) => m.id), stamp));
  }

  try {
    await db.batch(statements);
  } catch (error) {
    if (!isConflict(error)) throw error;
    log.info("rating conflict: another rating write came first", { matches: fresh.map((m) => m.id) });
    return { rated: 0, late: 0, conflict: true };
  }
  if (fresh.length) log.info("matches rated", { matches: fresh.map((m) => m.id) });
  return { rated: fresh.length, late: late.length, conflict: false };
}

/**
 * One run of the recompute: re-rates up to `budget` accepted matches from the first stale one,
 * starting from each player's history just before it. Run it until `done`.
 */
export async function recomputeRatings(
  db: D1Database,
  config: UpdateConfig,
  now: Date,
  log: Logger,
  budget = config.ratingMatchesPerRun,
): Promise<RecomputeResult> {
  const state = await readState(db);
  const from = state.staleFrom;
  if (!from) return { stale: false, rated: 0, done: true, conflict: false };

  const size = Math.max(1, budget);
  const accepted = await readAcceptedFrom(db, from, size + 1);
  const next = accepted[size] ?? null;
  const batch = accepted.slice(0, size);
  const counted = batch.filter((match) => counts(match, config, now));
  const notCounted = batch.filter((match) => match.rated && !counts(match, config, now)).map((m) => m.id);
  const dropped = [...notCounted, ...(await readNoLongerAccepted(db, from, next))];

  const [rounds, history] = await Promise.all([
    readRounds(db, counted.map((m) => m.id)),
    readHistory(db, [...batch.map((m) => m.id), ...dropped]),
  ]);
  const players = [...new Set([...[...rounds.values()].flat(2), ...history.map((entry) => entry.playerId)])];
  const [start, ratings] = await Promise.all([readRatingsBefore(db, players, from), readRatings(db, players)]);
  const writes = planRerate(
    { start, matches: counted.map((m) => ({ id: m.id, playedAt: m.playedAt, rounds: rounds.get(m.id)! })), history, ratings },
    config,
  );

  const stamp = isoSeconds(now);
  const newlyRated = counted.filter((m) => !m.rated).map((m) => m.id);
  const statements = [
    lockStatement(db, state.version),
    ...writeStatements(db, writes),
    ...(newlyRated.length ? [ratedAtStatement(db, newlyRated, stamp)] : []),
    ...(dropped.length ? [ratedAtStatement(db, dropped, null)] : []),
    staleUntilStatement(db, next, stamp),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (!isConflict(error)) throw error;
    log.info("recompute conflict: another rating write came first");
    return { stale: true, rated: 0, done: false, conflict: true };
  }
  log.info("ratings recomputed", {
    from,
    matches: counted.length,
    dropped: dropped.length,
    historyWritten: writes.historyUpsert.length + writes.historyRemove.length,
    ratingsWritten: writes.ratingsUpsert.length + writes.ratingsRemove.length,
    next,
  });
  return { stale: true, rated: counted.length, done: next === null, conflict: false };
}

/**
 * For whatever changes matches that may be rated: a void, an un-void, accepting a match from the
 * review queue (#7). The ratings are stale from the earliest of them; the cron recomputes them,
 * or call `recomputeRatings` straight away.
 */
export async function markMatchesChanged(db: D1Database, matchIds: readonly number[], now: Date): Promise<void> {
  if (matchIds.length) await staleFromMatchesStatement(db, matchIds, isoSeconds(now)).run();
}

/** After a change to the rating config or engine: everything is re-rated. */
export async function markAllStale(db: D1Database, now: Date): Promise<void> {
  await staleFromStatement(db, fromStart, isoSeconds(now)).run();
}

/** The cron: rate what's due, then carry on a recompute if the ratings are stale. */
export async function updateRatings(db: D1Database, config: UpdateConfig, now: Date, log: Logger): Promise<void> {
  const fresh = await rateNewMatches(db, config, now, log);
  const budget = config.ratingMatchesPerRun - fresh.rated;
  if (budget > 0) await recomputeRatings(db, config, now, log, budget);
}
