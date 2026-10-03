import type { Config } from "../config";
import { isoSeconds } from "../time";
import { standing, type StandingConfig } from "./standing";
import type { RatingRow } from "./store";

/**
 * The rank tags for the game's `RANKS - generated` rule (#9), as GenjiBall-CE `docs/rank-tags.md`
 * (v1.3.3R) defines them. Pure: the handler reads the candidates, this picks who gets a tag.
 *
 * The host tool writes the rule: it escapes `"` and `\` in the strings. This leaves out what it
 * can't write at all: names with `{` or `}` (Workshop placeholders), and strings over
 * `workshopStringMax` characters.
 */

export type RankTagsConfig = StandingConfig & Pick<Config, "rankTagsMaxNames">;

/** A Workshop `Custom String` holds at most this many characters. */
export const workshopStringMax = 128;

export interface RankTags {
  /** The line under the in-game guide's header. */
  header: string;
  /** When these tags were made. */
  updatedAt: string;
  /** Lowest first, every tier, with or without names. */
  tiers: { label: string; color: [number, number, number, number]; guide: string; names: string[] }[];
}

/**
 * `candidates`: players who may have a tag, best first (`listTagCandidates`). Each one active, with
 * enough rated rounds and in a tier, gets their tier's tag; at most `rankTagsMaxNames` names, the
 * best ones.
 */
export function rankTags(candidates: readonly RatingRow[], config: RankTagsConfig, now: Date): RankTags {
  const tiers = config.tiers.map((tier) => ({
    label: tier.label,
    color: [...tier.color, 255] as [number, number, number, number],
    guide: `${tier.label} - ${tier.threshold}`,
    names: [] as string[],
  }));
  let count = 0;
  for (const player of candidates) {
    if (count >= config.rankTagsMaxNames) break;
    if (!isWritable(player.name)) continue;
    const { tier, inactiveSince } = standing(player, config, now);
    if (!tier || inactiveSince) continue;
    tiers.find((t) => t.label === tier.label)!.names.push(player.name);
    count += 1;
  }
  const updatedAt = isoSeconds(now);
  return { header: `Ranks updated ${updatedAt.slice(0, 10)}`, updatedAt, tiers };
}

function isWritable(name: string): boolean {
  return name.length > 0 && name.length <= workshopStringMax && !/[{}]/.test(name);
}
