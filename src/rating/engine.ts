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
  | "ratingNewPlayerStart"
  | "ratingNewPlayerStartFrom"
  | "ratingRoundsPerMatch"
  | "displayCenter"
  | "displayScale"
  | "displayFloor"
  | "ratingMatchMaxChange"
  | "tournamentBonusWeight"
  | "tournamentWinValueGrowth"
  | "tournamentWinnerBonus"
  | "tournamentMaxLoss"
  | "tournamentMaxLossBands"
  | "tournamentMaxGain"
>;

/** A match as the engine needs it. Player ids are `players.id`, not per-match log ids. */
export interface RatingMatch {
  id: number;
  /** ISO 8601. Matches are rated in this order, then by id. */
  playedAt: string;
  /** The finishing order of each rated round, in round order: winner first, leavers left out. */
  rounds: number[][];
  /** A tournament: its rounds, then its standings (a position bonus), are rated, with its own caps (`rateTournament`). */
  tournament?: boolean;
  /** A tournament's kills by player (`KILL`s, not of themselves), for its standings. A player left out has none. */
  kills?: ReadonlyMap<number, number>;
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

/**
 * A player's rating before their first rated round. One first rated in a match played from
 * `ratingNewPlayerStartFrom` on (`playedAt`) starts at `ratingNewPlayerStart`; before it, and with
 * no `playedAt`, at `ratingMu`.
 */
export function newRating(config: RatingConfig, playedAt?: string): PlayerRating {
  const lower = playedAt !== undefined && Date.parse(playedAt) >= Date.parse(config.ratingNewPlayerStartFrom);
  const mu = lower ? config.ratingMu + (config.ratingNewPlayerStart - config.displayCenter) / config.displayScale : config.ratingMu;
  return { mu, sigma: config.ratingSigma, rounds: 0, wins: 0, streak: 0, bestStreak: 0, lastPlayedAt: null };
}

/**
 * Rates one round in place. `order` is the finishing order, winner first. A round with fewer than
 * two players, or a player listed twice, changes nothing and returns false.
 */
export function rateRound(ratings: Ratings, order: readonly number[], config: RatingConfig, playedAt?: string): boolean {
  if (order.length < 2 || new Set(order).size !== order.length) return false;

  const n = config.ratingRoundsPerMatch;
  // Tau is spread over the rounds of a match, like the update itself.
  const tauSq = config.ratingTau ** 2 / n;
  const before = order.map((id) => {
    const current = ratings.get(id) ?? newRating(config, playedAt);
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
 * the match. A tournament match rates its rounds the same way, then its standings and its own caps
 * (`rateTournament`).
 */
export function rateMatch(ratings: Ratings, match: RatingMatch, config: RatingConfig): HistoryEntry[] {
  const started = new Map<number, PlayerRating>();
  for (const order of match.rounds) {
    for (const id of order) if (!started.has(id)) started.set(id, { ...(ratings.get(id) ?? newRating(config, match.playedAt)) });
  }

  const played = new Set<number>();
  const rated: number[][] = [];
  for (const order of match.rounds) {
    if (!rateRound(ratings, order, config, match.playedAt)) continue;
    order.forEach((id) => played.add(id));
    rated.push(order);
  }
  if (match.tournament) {
    rateTournament(ratings, started, tournamentStandings(rated, match.kills ?? new Map(), config), config);
  } else {
    for (const id of played) capChange(ratings.get(id)!, started.get(id)!, config.ratingMatchMaxChange, config.ratingMatchMaxChange, config);
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
      streak: rating.streak,
      bestStreak: rating.bestStreak,
    };
  });
}

/** A player's line in a tournament's standings. */
export interface Standing {
  playerId: number;
  wins: number;
  kills: number;
  /** `wins` × `tournamentWinValue` + `kills`. */
  score: number;
}

/** What a rated round win is worth in a tournament's score, for a lobby of `players` at the start. */
export function tournamentWinValue(players: number, config: Pick<RatingConfig, "tournamentWinValueGrowth">): number {
  return Math.round((players - 1) * (1 + players / config.tournamentWinValueGrowth)) + 1;
}

/**
 * A tournament's standings from its rated rounds (winner first) and kills: everyone who played a
 * rated round, a player who left keeping what they had, best score first (ties by player id, so
 * the order is always the same; tied players share their place in the bonus).
 */
export function tournamentStandings(
  rounds: readonly (readonly number[])[],
  kills: ReadonlyMap<number, number>,
  config: Pick<RatingConfig, "tournamentWinValueGrowth">,
): Standing[] {
  const winValue = tournamentWinValue(rounds[0]?.length ?? 0, config);
  const wins = new Map<number, number>();
  for (const order of rounds) {
    for (const id of order) if (!wins.has(id)) wins.set(id, 0);
    wins.set(order[0]!, wins.get(order[0]!)! + 1);
  }
  return [...wins]
    .map(([playerId, won]) => {
      const killed = kills.get(playerId) ?? 0;
      return { playerId, wins: won, kills: killed, score: won * winValue + killed };
    })
    .sort((a, b) => b.score - a.score || a.playerId - b.playerId);
}

/**
 * The rest of a tournament, after its rounds (docs/rating.md, "Tournaments"):
 *
 * 1. The position bonus: the standings are rated as one game (tied scores tie), and mu moves
 *    `tournamentBonusWeight` times as far as that game would move it. Sigma takes the game's update.
 *    It doesn't count as a round: rounds, wins and streaks stay as the rounds left them.
 * 2. The caps: nobody ends more than `tournamentMaxGain` above, or their loss cap
 *    (`tournamentMaxLoss`, by their display rating before) below, where they started.
 * 3. Everyone first on score gets `tournamentWinnerBonus` display points on top.
 */
export function rateTournament(ratings: Ratings, started: ReadonlyMap<number, PlayerRating>, standings: readonly Standing[], config: RatingConfig): void {
  if (standings.length >= 2) {
    const before = standings.map(({ playerId }) => {
      const current = ratings.get(playerId)!;
      return { mu: current.mu, sigma: Math.sqrt(current.sigma ** 2 + config.ratingTau ** 2) };
    });
    const rank = standings.map(({ score }) => 1 + standings.filter((other) => other.score > score).length);
    const after = rate(
      before.map(({ mu, sigma }) => [{ mu, sigma }]),
      { mu: config.ratingMu, sigma: config.ratingSigma, beta: config.ratingBeta, tau: 0, rank },
    );
    standings.forEach(({ playerId }, i) => {
      const rating = ratings.get(playerId)!;
      const full = after[i]![0]!;
      rating.mu = before[i]!.mu + (full.mu - before[i]!.mu) * config.tournamentBonusWeight;
      rating.sigma = full.sigma;
    });
  }

  for (const { playerId } of standings) {
    const start = started.get(playerId)!;
    capChange(ratings.get(playerId)!, start, tournamentMaxLoss(displayRating(start, config), config), config.tournamentMaxGain, config);
  }

  const best = standings[0]?.score;
  for (const { playerId, score } of standings) {
    if (score !== best) continue;
    const rating = ratings.get(playerId)!;
    rating.mu = muForDisplay(displayExact(rating, config) + config.tournamentWinnerBonus, config);
  }
}

/** The most display points a player rated `display` before a tournament can lose in it. */
export function tournamentMaxLoss(display: number, config: Pick<RatingConfig, "tournamentMaxLoss" | "tournamentMaxLossBands">): number {
  return config.tournamentMaxLossBands.find((band) => display < band.below)?.maxLoss ?? config.tournamentMaxLoss;
}

/**
 * If the match moved a player more than `maxLoss` display points down or `maxGain` up, sets their
 * mu to the one that shows exactly that many from where they started (sigma, rounds, wins and
 * streaks stay as the match left them). The display only depends on mu, so that's `muForDisplay`.
 * A loss cap that reaches `displayFloor` never applies: the display can't get below it.
 */
export function capChange(rating: PlayerRating, started: PlayerRating, maxLoss: number, maxGain: number, config: RatingConfig): void {
  const from = displayRating(started, config);
  const change = displayRating(rating, config) - from;
  if (change > maxGain) rating.mu = muForDisplay(from + maxGain, config);
  else if (change < -maxLoss) rating.mu = muForDisplay(from - maxLoss, config);
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
 * The leaderboard number: mu on an Elo-like scale. A new player is `displayCenter`. Above it the
 * number rises `displayScale` per point of mu. Below it the curve eases toward `displayFloor` and
 * never reaches it, with the same slope at the center, so weak players pile up in the 900s instead
 * of falling without end. Sigma doesn't count: a number that took off z·sigma would rise as sigma
 * shrinks, so players would climb by playing more, not by getting better.
 */
export function displayRating(rating: Pick<PlayerRating, "mu">, config: RatingConfig): number {
  return Math.max(config.displayFloor, Math.round(displayExact(rating, config)));
}

/** `displayRating` before rounding. */
function displayExact(rating: Pick<PlayerRating, "mu">, config: RatingConfig): number {
  const x = config.displayScale * (rating.mu - config.ratingMu);
  if (x >= 0) return config.displayCenter + x;
  const room = config.displayCenter - config.displayFloor;
  return config.displayFloor + room * Math.exp(x / room);
}

/** The mu that `displayExact` turns into `display`, which must be above `displayFloor`. */
function muForDisplay(display: number, config: RatingConfig): number {
  const room = config.displayCenter - config.displayFloor;
  const x = display >= config.displayCenter ? display - config.displayCenter : room * Math.log((display - config.displayFloor) / room);
  return config.ratingMu + x / config.displayScale;
}

/** The highest tier the display rating reaches, or null below the first. `tiers` is lowest first. */
export function tierFor(display: number, tiers: readonly Tier[]): Tier | null {
  let tier: Tier | null = null;
  for (const candidate of tiers) {
    if (display >= candidate.threshold) tier = candidate;
  }
  return tier;
}
