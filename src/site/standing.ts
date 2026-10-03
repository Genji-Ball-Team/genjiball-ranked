import type { Config, Tier } from "../config";
import { tierFor } from "../rating/engine";

/**
 * Where a player stands, from their stored rating: their tier and whether they're inactive. Pure,
 * so the leaderboard, the player page and the rank tags (#9) all apply the same rules.
 */

export type StandingConfig = Pick<Config, "tiers" | "minRankedRounds" | "inactiveAfterDays">;

export interface Standing {
  /** Null below the first tier, or with fewer than `minRankedRounds` rated rounds. */
  tier: Pick<Tier, "label" | "color"> | null;
  /** When they last played, once that's more than `inactiveAfterDays` ago. Null while active. */
  inactiveSince: string | null;
}

const dayMs = 24 * 60 * 60 * 1000;

export function standing(
  rating: { display: number; rounds: number; lastPlayedAt: string | null },
  config: StandingConfig,
  now: Date,
): Standing {
  const tier = rating.rounds >= config.minRankedRounds ? tierFor(rating.display, config.tiers) : null;
  const last = rating.lastPlayedAt === null ? null : Date.parse(rating.lastPlayedAt);
  const inactive = last !== null && now.getTime() - last > config.inactiveAfterDays * dayMs;
  return {
    tier: tier && { label: tier.label, color: tier.color },
    inactiveSince: inactive ? rating.lastPlayedAt : null,
  };
}
