import { rate } from "openskill";
import type { Config, Tier } from "../config";

/**
 * The rating engine (#6). Pure: it takes rounds and returns ratings, and never touches D1.
 *
 * Each rated round is one OpenSkill game, ranked by its finishing order (winner first). Players
 * who left the round are already out of the order (the parser drops them), so they don't change.
 * A round is damped to about 1/`ratingRoundsPerMatch` of a full game, so one round can't swing
 * the leaderboard. See GenjiBall-CE `docs/ranked-log.md`, "How the server rates a round".
 */

export type RatingConfig = Pick<
  Config,
  | "ratingMu"
  | "ratingSigma"
  | "ratingBeta"
  | "ratingTau"
  | "ratingRoundsPerMatch"
  | "displayZ"
  | "displayCenter"
  | "displayScale"
  | "displayFloor"
>;

/** A match as the engine needs it. Player ids are `players.id`, not per-match log ids. */
export interface RatingMatch {
  id: number;
  /** ISO 8601. Matches are rated in this order, then by id. */
  playedAt: string;
  /** The finishing order of each rated round, in round order: winner first, leavers left out. */
  rounds: number[][];
}

export interface PlayerRating {
  mu: number;
  sigma: number;
  /** Rated rounds played. */
  rounds: number;
  /** Rated rounds won. */
  wins: number;
  lastPlayedAt: string | null;
}

/**
 * A player's rating after a match they were in, for the history graph. It holds the whole
 * `PlayerRating`, so a recompute can start from it (`lastPlayedAt` is `playedAt`).
 */
export interface HistoryEntry {
  playerId: number;
  matchId: number;
  playedAt: string;
  mu: number;
  sigma: number;
  display: number;
  rounds: number;
  wins: number;
}

export type Ratings = Map<number, PlayerRating>;

export function newRating(config: RatingConfig): PlayerRating {
  return { mu: config.ratingMu, sigma: config.ratingSigma, rounds: 0, wins: 0, lastPlayedAt: null };
}

/**
 * Rates one round in place. `order` is the finishing order, winner first. A round with fewer than
 * two players, or a player listed twice, changes nothing and returns false.
 */
export function rateRound(ratings: Ratings, order: readonly number[], config: RatingConfig): boolean {
  if (order.length < 2 || new Set(order).size !== order.length) return false;

  const n = config.ratingRoundsPerMatch;
  // Tau is spread over the rounds of a match, like the update itself.
  const tauSq = config.ratingTau ** 2 / n;
  const before = order.map((id) => {
    const current = ratings.get(id) ?? newRating(config);
    return { ...current, sigma: Math.sqrt(current.sigma ** 2 + tauSq) };
  });

  const after = rate(
    before.map(({ mu, sigma }) => [{ mu, sigma }]),
    { mu: config.ratingMu, sigma: config.ratingSigma, beta: config.ratingBeta, tau: 0 },
  );

  order.forEach((id, i) => {
    const prior = before[i]!;
    const full = after[i]![0]!;
    // Damping: move 1/n of the way to the full update, in mu and in variance.
    const variance = prior.sigma ** 2 + (full.sigma ** 2 - prior.sigma ** 2) / n;
    ratings.set(id, {
      mu: prior.mu + (full.mu - prior.mu) / n,
      sigma: Math.sqrt(variance),
      rounds: prior.rounds + 1,
      wins: prior.wins + (i === 0 ? 1 : 0),
      lastPlayedAt: prior.lastPlayedAt,
    });
  });
  return true;
}

/**
 * Rates a match's rounds in place, in order, and returns the rating after the match of every
 * player who played a rated round in it.
 */
export function rateMatch(ratings: Ratings, match: RatingMatch, config: RatingConfig): HistoryEntry[] {
  const played = new Set<number>();
  for (const order of match.rounds) {
    if (rateRound(ratings, order, config)) order.forEach((id) => played.add(id));
  }
  return [...played].map((playerId) => {
    const rating = ratings.get(playerId)!;
    rating.lastPlayedAt = match.playedAt;
    return {
      playerId,
      matchId: match.id,
      playedAt: match.playedAt,
      mu: rating.mu,
      sigma: rating.sigma,
      display: displayRating(rating, config),
      rounds: rating.rounds,
      wins: rating.wins,
    };
  });
}

/** Play order: by `playedAt`, then by id, so the same matches always rate the same way. */
export function compareMatches(a: RatingMatch, b: RatingMatch): number {
  if (a.playedAt !== b.playedAt) return a.playedAt < b.playedAt ? -1 : 1;
  return a.id - b.id;
}

/**
 * Ratings from scratch: every match in play order, starting from new ratings. Pass only the
 * matches that count (accepted, not void; legacy included). The same matches always give the
 * same ratings, whatever order they are passed in.
 */
export function recompute(matches: readonly RatingMatch[], config: RatingConfig): {
  ratings: Ratings;
  history: HistoryEntry[];
} {
  const ratings: Ratings = new Map();
  const history: HistoryEntry[] = [];
  for (const match of [...matches].sort(compareMatches)) {
    history.push(...rateMatch(ratings, match, config));
  }
  return { ratings, history };
}

/** The leaderboard number: the conservative rating mu − z·sigma on an Elo-like scale. */
export function displayRating(rating: Pick<PlayerRating, "mu" | "sigma">, config: RatingConfig): number {
  const conservative = rating.mu - config.displayZ * rating.sigma;
  const display = config.displayCenter + config.displayScale * (conservative - config.ratingMu);
  return Math.max(config.displayFloor, Math.round(display));
}

/** The highest tier the display rating reaches, or null below the first. `tiers` is lowest first. */
export function tierFor(display: number, tiers: readonly Tier[]): Tier | null {
  let tier: Tier | null = null;
  for (const candidate of tiers) {
    if (display >= candidate.threshold) tier = candidate;
  }
  return tier;
}
