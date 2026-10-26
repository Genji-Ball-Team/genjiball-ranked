import type { Config, Tier } from "../config";
import { pageNumber } from "../http";

/**
 * The leaderboard's filter (`/api/leaderboard`, docs/api.md): which of the board's players a page
 * shows. Pure: the handler reads the URL through `parseBoardFilter`, the store turns it into SQL.
 * Each player keeps their place on the whole board, so a filtered page's places can skip.
 */
export interface BoardFilter {
  /** `none` for below the first tier, then site tiers by lowercase label, lowest first; empty for every tier. */
  tiers: string[];
  /** Played a rated round in this many days; null for any time. */
  played: number | null;
  /** At least this many rated rounds; null for the board's own minimum. */
  rounds: number | null;
  /** Display rating from and to, both included; null for no bound. */
  min: number | null;
  max: number | null;
}

export type BoardFilterConfig = Pick<Config, "tiers" | "inactiveAfterDays" | "leaderboardFilterMaxDays">;

/** The tier value for players below the first tier. */
export const noTier = "none";

/** True when the filter shows every player: the plain board. */
export function isOpen(filter: BoardFilter): boolean {
  return !filter.tiers.length && filter.played === null && filter.rounds === null && filter.min === null && filter.max === null;
}

/**
 * The filter in `?tier=master,none&played=7&rounds=100&min=1500&max=2000`, or the message saying
 * what's wrong with it. `?active=1`, the old Everyone / Active switch, is `played=inactiveAfterDays`.
 */
export function parseBoardFilter(params: URLSearchParams, config: BoardFilterConfig): BoardFilter | string {
  const known = [noTier, ...config.tiers.map((t) => t.label.toLowerCase())];
  const tiers = (params.get("tier") ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const unknown = tiers.find((t) => !known.includes(t));
  if (unknown) return `tier must be among ${known.join(", ")}, not "${unknown}"`;

  const count = (name: string, max = Infinity): number | null | string => {
    const value = params.get(name);
    if (value === null || value === "") return null;
    const n = pageNumber(value);
    return n === null || n > max ? `${name} must be a whole number from 1${max < Infinity ? ` to ${max}` : ""}` : n;
  };
  const played = params.get("active") === "1" && !params.has("played") ? config.inactiveAfterDays : count("played", config.leaderboardFilterMaxDays);
  const rounds = count("rounds");
  const rating = (name: string): number | null | string => {
    const value = params.get(name);
    if (value === null || value === "") return null;
    return /^-?\d{1,6}$/.test(value) ? Number(value) : `${name} must be a whole rating`;
  };
  const min = rating("min");
  const max = rating("max");
  for (const v of [played, rounds, min, max]) if (typeof v === "string") return v;
  return { tiers: known.filter((t) => tiers.includes(t)), played, rounds, min, max } as BoardFilter;
}

/**
 * The display ratings the picked tiers cover, each `[from, below]` with null for no bound, lowest
 * first: a tier runs from its threshold to the next one's, `none` from nothing to the first.
 */
export function tierRanges(picked: readonly string[], tiers: readonly Tier[]): [number | null, number | null][] {
  const bounds = tiers.map((t) => t.threshold);
  const ranges: [number | null, number | null][] = [];
  if (picked.includes(noTier)) ranges.push([null, bounds[0] ?? null]);
  tiers.forEach((tier, i) => {
    if (picked.includes(tier.label.toLowerCase())) ranges.push([tier.threshold, bounds[i + 1] ?? null]);
  });
  return ranges;
}
