// What a card can show, by kind: the share sheet lists them as toggles ("Show"), and every style
// draws only the picked ones, laid out again around what's left (kit.ts, `stack`). The name, the
// brand and the region are always on the card. A part the card has no data for (no title, no
// rating line yet) isn't offered.
import type { CompareCard, MatchCard, PlayerCard, ShareCard } from "./types";

interface Part<T> {
  label: string;
  /** Whether this card has it to show. */
  has?: (card: T) => boolean;
}

const line = (d: PlayerCard) => d.points.length > 1;

export const playerParts = {
  title: { label: "Title", has: (d) => d.crown != null },
  tier: { label: "Tier", has: (d) => d.tier != null },
  rating: { label: "Rating" },
  rank: { label: "Rank" },
  change: { label: "Change", has: line },
  rounds: { label: "Rated rounds" },
  winRate: { label: "Rounds won" },
  peak: { label: "Peak" },
  streak: { label: "Best streak" },
  chart: { label: "Rating line", has: line },
  form: { label: "Recent form", has: (d) => d.form.length > 0 },
} satisfies Record<string, Part<PlayerCard>>;

export const matchParts = {
  winner: { label: "Winner", has: (d) => d.winners.length > 0 },
  winnerLine: { label: "Winner's rounds", has: (d) => d.winners.length > 0 && d.winnerLine !== "" },
  tourney: { label: "Tourney", has: (d) => d.tourney != null },
  id: { label: "Match number" },
  date: { label: "Date", has: (d) => d.date !== "" },
  map: { label: "Map", has: (d) => d.map !== "" },
  length: { label: "Rounds" },
  playerCount: { label: "Player count" },
  standings: { label: "Standings", has: (d) => d.rows.length > 0 },
  changes: { label: "Rating change" },
  ratings: { label: "Ratings" },
  won: { label: "Rounds won" },
  kills: { label: "Kills" },
} satisfies Record<string, Part<MatchCard>>;

export const compareParts = {
  tier: { label: "Tier", has: (d) => d.players.some((p) => p.tier) },
  rating: { label: "Rating" },
  rank: { label: "Rank" },
  winRate: { label: "Rounds won" },
  kills: { label: "Kills a round" },
  peak: { label: "Peak" },
  chart: { label: "Rating lines", has: (d) => d.players.some((p) => p.points.length > 1) },
} satisfies Record<string, Part<CompareCard>>;

export type PlayerPart = keyof typeof playerParts;
export type MatchPart = keyof typeof matchParts;
export type ComparePart = keyof typeof compareParts;

/** The parts of each kind of card. */
export const parts = { player: playerParts, match: matchParts, compare: compareParts };
type Kind = ShareCard["kind"];

/** Off unless picked: the ones that make a busy card busier. Everything else starts on. */
const offAtFirst: Record<Kind, readonly string[]> = {
  player: ["rounds"],
  match: ["playerCount"],
  compare: [],
};

/** What a card shows: `has(part)` is true when it's picked and the card has it. */
export interface Show<P extends string> {
  has(part: P): boolean;
  /** How many of `list` are shown. */
  count(...list: P[]): number;
}

/** The parts this card has, in their order, each with its label. */
export function offered(card: ShareCard): { key: string; label: string }[] {
  const all = parts[card.kind] as unknown as Record<string, Part<ShareCard>>;
  return Object.entries(all)
    .filter(([, p]) => !p.has || p.has(card))
    .map(([key, p]) => ({ key, label: p.label }));
}

export const defaults = (kind: Kind): string[] => Object.keys(parts[kind]).filter((key) => !offAtFirst[kind].includes(key));

export function showFor(card: ShareCard, picked: readonly string[]): Show<string> {
  const all = parts[card.kind] as unknown as Record<string, Part<ShareCard>>;
  const on = new Set(picked.filter((key) => Object.hasOwn(all, key) && (all[key]?.has?.(card) ?? true)));
  return { has: (part) => on.has(part), count: (...list) => list.filter((part) => on.has(part)).length };
}
