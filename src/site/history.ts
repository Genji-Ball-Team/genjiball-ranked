import type { Config } from "../config";

/**
 * A player's rating history graph (#17), from their `rating_history` rows in one region. Pure: the
 * caller reads the rows and the newest rounds; this thins the graph, finds the peak and counts the
 * recent form.
 */

export type HistoryConfig = Pick<Config, "ratingHistoryMaxPoints" | "recentFormRounds">;

/** A history point: the player's rating after a match. */
export interface HistoryPoint {
  matchId: number;
  playedAt: string;
  rating: number;
}

/** A `rating_history` row of a public match: the rating after it and the win streaks. */
export interface StoredHistoryRow extends HistoryPoint {
  streak: number;
  bestStreak: number;
}

/** A rated round of the player's, as recent form shows it. */
export interface FormRound {
  matchId: number;
  round: number;
  /** 1 = won. */
  position: number;
  /** Players in the round's rated order. */
  players: number;
}

/** The peak: the highest rating after a match, the earliest when it was reached more than once. */
export function peakOf<T extends HistoryPoint>(points: readonly T[]): T | null {
  let peak: T | null = null;
  for (const point of points) if (!peak || point.rating > peak.rating) peak = point;
  return peak;
}

/**
 * At most `max` points, in play order: evenly spaced over the matches, always the first and the
 * last, and the peak in place of the point nearest to it, so the graph never hides the top.
 */
export function downsample<T extends HistoryPoint>(points: readonly T[], max: number): T[] {
  const size = Math.max(3, Math.floor(max));
  if (points.length <= size) return [...points];
  const last = points.length - 1;
  const picked = Array.from({ length: size }, (_, i) => Math.round((i * last) / (size - 1)));
  const peak = points.indexOf(peakOf(points)!);
  if (!picked.includes(peak)) {
    // The nearest picked point inside the ends: the first and the last stay.
    let nearest = 1;
    for (let i = 1; i < size - 1; i++) if (Math.abs(picked[i]! - peak) < Math.abs(picked[nearest]! - peak)) nearest = i;
    picked[nearest] = peak;
  }
  return [...new Set(picked)].sort((a, b) => a - b).map((i) => points[i]!);
}

/** Recent form from the player's newest rated rounds (`listFormRounds`), newest first. */
export function recentForm(rounds: readonly FormRound[]) {
  const wins = rounds.filter((r) => r.position === 1).length;
  const average = rounds.length ? rounds.reduce((sum, r) => sum + r.position, 0) / rounds.length : null;
  return {
    rounds: rounds.length,
    wins,
    averagePosition: average === null ? null : Math.round(average * 100) / 100,
    results: rounds,
  };
}
