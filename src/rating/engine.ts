import { rate } from "openskill";
import type { Config, Tier } from "../config";

/**
 * The rating engine (#6). Pure: it takes rounds and returns ratings, and never touches D1.
 *
 * Each rated round is one OpenSkill game, ranked by its finishing order (winner first). Players
 * who left the round are already out of the order (the parser drops them), so they don't change.
 * A round moves mu about 1/`ratingRoundsPerMatch` as far as a full game, so one round can't swing
 * the leaderboard, and a match moves no one more than `ratingMatchMaxChange` display points. See
 * GenjiBall-CE `docs/ranked-log.md`, "How the server rates a round".
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
  | "ratingMatchMaxChange"
  | "tournamentWeight"
  | "tournamentMaxChange"
>;

/** A match as the engine needs it. Player ids are `players.id`, not per-match log ids. */
export interface RatingMatch {
  id: number;
  /** ISO 8601. Matches are rated in this order, then by id. */
  playedAt: string;
  /** The finishing order of each rated round, in round order: winner first, leavers left out. */
  rounds: number[][];
  /** A tournament counts `tournamentWeight` times a normal match, and nobody moves more than `tournamentMaxChange` (not `ratingMatchMaxChange`) either way in it. */
  tournament?: boolean;
}

export interface PlayerRating {
  mu: number;
  sigma: number;
  /** Rated rounds played. */
  rounds: number;
  /** Rated rounds won. */
  wins: number;
  /** Rated rounds won in a row, up to now: a round they finish in another place ends it. A round they left doesn't count. */
  streak: number;
  /** The longest `streak` they ever had. */
  bestStreak: number;
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
  streak: number;
  bestStreak: number;
}

export type Ratings = Map<number, PlayerRating>;

export function newRating(config: RatingConfig): PlayerRating {
  return { mu: config.ratingMu, sigma: config.ratingSigma, rounds: 0, wins: 0, streak: 0, bestStreak: 0, lastPlayedAt: null };
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
    const streak = i === 0 ? prior.streak + 1 : 0;
    // Damping: mu moves 1/n of the way to the full update. Sigma takes the full update: damping it
    // too kept every regular's sigma near 6 however much they played, so the ratings never settled
    // and a strong player kept gaining a lot from beating far weaker ones (docs/rating.md).
    ratings.set(id, {
      mu: prior.mu + (full.mu - prior.mu) / n,
      sigma: full.sigma,
      rounds: prior.rounds + 1,
      wins: prior.wins + (i === 0 ? 1 : 0),
      streak,
      bestStreak: Math.max(prior.bestStreak, streak),
      lastPlayedAt: prior.lastPlayedAt,
    });
  });
  return true;
}

/**
 * Rates a match's rounds in place, in order, and returns the rating after the match of every
 * player who played a rated round in it.
 *
 * Then it holds every player's change to `ratingMatchMaxChange` display points either way: a
 * player who would move further keeps the rating that is exactly that far from where they started
 * the match. A tournament match damps each round less (`tournamentWeight` times as much movement)
 * and is held to `tournamentMaxChange` instead.
 */
export function rateMatch(ratings: Ratings, match: RatingMatch, config: RatingConfig): HistoryEntry[] {
  const rounding = match.tournament ? tournamentConfig(config) : config;
  const maxChange = match.tournament ? config.tournamentMaxChange : config.ratingMatchMaxChange;
  const started = new Map<number, PlayerRating>();
  for (const order of match.rounds) {
    for (const id of order) if (!started.has(id)) started.set(id, { ...(ratings.get(id) ?? newRating(config)) });
  }

  const played = new Set<number>();
  for (const order of match.rounds) {
    if (rateRound(ratings, order, rounding)) order.forEach((id) => played.add(id));
  }
  for (const id of played) capChange(ratings.get(id)!, started.get(id)!, maxChange, config);

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
      streak: rating.streak,
      bestStreak: rating.bestStreak,
    };
  });
}

/** The config a tournament's rounds are rated with: damped 1/`tournamentWeight` as much. */
function tournamentConfig(config: RatingConfig): RatingConfig {
  // Never below 1, which rates every round as a full game.
  return { ...config, ratingRoundsPerMatch: Math.max(1, config.ratingRoundsPerMatch / config.tournamentWeight) };
}

/**
 * If the match moved a player more than `maxChange` display points either way, moves
 * their mu back toward where they started, as little as it takes to move exactly that many (sigma,
 * rounds, wins and streaks stay as the match left them).
 */
export function capChange(rating: PlayerRating, started: PlayerRating, maxChange: number, config: RatingConfig): void {
  const from = displayRating(started, config);
  const within = (r: Pick<PlayerRating, "mu" | "sigma">) => Math.abs(displayRating(r, config) - from) <= maxChange;
  if (within(rating)) return;
  // Bisection on how far to move mu from the start toward the match's result. t = 0 moves nothing
  // (always allowed), t = 1 moves too far.
  const end = rating.mu;
  let allowed = 0;
  let tooFar = 1;
  for (let step = 0; step < 50; step++) {
    const t = (allowed + tooFar) / 2;
    if (within({ mu: started.mu + t * (end - started.mu), sigma: rating.sigma })) allowed = t;
    else tooFar = t;
  }
  rating.mu = started.mu + allowed * (end - started.mu);
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

/**
 * The leaderboard number: the conservative rating mu − z·sigma on an Elo-like scale. A new player
 * is `displayCenter`. Above it the number rises `displayScale` per point of rating. Below it the
 * curve eases toward `displayFloor` and never reaches it, with the same slope at the center, so
 * weak players pile up in the 900s instead of falling without end.
 */
export function displayRating(rating: Pick<PlayerRating, "mu" | "sigma">, config: RatingConfig): number {
  const conservative = rating.mu - config.displayZ * rating.sigma;
  const x = config.displayScale * (conservative - config.ratingMu);
  if (x >= 0) return Math.round(config.displayCenter + x);
  const room = config.displayCenter - config.displayFloor;
  return Math.max(config.displayFloor, Math.round(config.displayFloor + room * Math.exp(x / room)));
}

/** The highest tier the display rating reaches, or null below the first. `tiers` is lowest first. */
export function tierFor(display: number, tiers: readonly Tier[]): Tier | null {
  let tier: Tier | null = null;
  for (const candidate of tiers) {
    if (display >= candidate.threshold) tier = candidate;
  }
  return tier;
}
