import type { Config, Tier } from "../config";
import { tierFor } from "../rating/engine";
import { dayMs } from "../time";

/**
 * Where a player stands, from their stored rating: their tier and whether they're inactive. Pure,
 * so the leaderboard, the player page and the rank tags (#9) all apply the same rules.
 */

export type TierView = Pick<Tier, "label" | "color" | "threshold">;

export type StandingConfig = Pick<Config, "tiers" | "minRankedRounds" | "inactiveAfterDays">;

export interface Standing {
  /**
   * The tier the game knows: never a site-only one (Rookie). The host tool colours the in-game top
   * 10 by it, so it stays as it was. Null below the game's first tier, or with fewer than
   * `minRankedRounds` rated rounds.
   */
  tier: TierView | null;
  /** The tier the site and the Discord bot show: `tier`, or a site-only one below the game's. */
  siteTier: TierView | null;
  /** When they last played, once that's more than `inactiveAfterDays` ago. Null while active. */
  inactiveSince: string | null;
}

export function standing(
  rating: { display: number; rounds: number; lastPlayedAt: string | null },
  config: StandingConfig,
  now: Date,
): Standing {
  const ranked = rating.rounds >= config.minRankedRounds;
  const tier = ranked ? tierFor(rating.display, gameTiers(config.tiers)) : null;
  const siteTier = ranked ? tierFor(rating.display, config.tiers) : null;
  const last = rating.lastPlayedAt === null ? null : Date.parse(rating.lastPlayedAt);
  const inactive = last !== null && now.getTime() - last > config.inactiveAfterDays * dayMs;
  return {
    tier: tier && tierView(tier),
    siteTier: siteTier && tierView(siteTier),
    inactiveSince: inactive ? rating.lastPlayedAt : null,
  };
}

/** The next tier up from a display rating, for "142 to Grandmaster". Null at the top tier. */
export function nextTier(display: number, tiers: readonly Tier[]): TierView | null {
  const next = tiers.find((tier) => tier.threshold > display);
  return next ? tierView(next) : null;
}

/** The site tier a display rating is in, whatever the player's rounds (a peak's). Null below the first. */
export function tierOf(display: number, tiers: readonly Tier[]): TierView | null {
  const tier = tierFor(display, tiers);
  return tier && tierView(tier);
}

/** The tiers with a rank tag in game: all but the site-only ones (`siteOnly` in the config). */
export function gameTiers(tiers: readonly Tier[]): Tier[] {
  return tiers.filter((tier) => !tier.siteOnly);
}

function tierView(tier: Tier): TierView {
  return { label: tier.label, color: tier.color, threshold: tier.threshold };
}
