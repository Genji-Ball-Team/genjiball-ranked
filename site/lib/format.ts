// Numbers, dates and words as the site writes them.
import { tiers, type Tier as TierName } from "@genji-ball-team/ui/chip.js";
import { html, type Html } from "./html";
import type { Tier } from "./types";

const siteName = "Genji Ball Ranked";

/** Sets the tab's title: "EU leaderboard – Genji Ball Ranked". */
export const title = (what: string): void => void (document.title = `${what} – ${siteName}`);

// Numbers as the game shows them: digits only, no separators ("2273").
export const num = (n: number): string => String(n);

/** The display rating never goes below 0, so 0 means "at the bottom of the scale", not a score. */
export const rating = (r: number | null | undefined): string => (r && r > 0 ? num(r) : "–");

export const winRate = (wins: number, rounds: number): string =>
  rounds ? `${Math.round((100 * wins) / rounds)}%` : "–";

export const date = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "3 days ago": how long ago something was, for beside a date. */
export function ago(iso: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}

export const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
export const count = (n: number, one: string, many?: string): string => `${num(n)} ${plural(n, one, many)}`;

/** The UI library's tier name for a tier from the API ("Grandmaster" → "grandmaster"), if it has it. */
export function tierName(tier: Tier | null | undefined): TierName | undefined {
  const name = tier?.label.toLowerCase();
  return tiers.find((t) => t === name);
}

/** A tier's chip, or nothing. */
export function tierChip(tier: Tier | null | undefined): Html | "" {
  if (!tier) return "";
  const name = tierName(tier);
  return html`<gb-chip${name && html` tier="${name}"`}>${tier.label}</gb-chip>`;
}

/** A name with the part matching `query` (lower case) in a <mark>. */
export function highlight(name: string, query: string): Html {
  const lower = name.toLowerCase();
  const at = query ? lower.indexOf(query) : -1;
  // Lower case can change a name's length (rare letters): then nothing is marked.
  if (at < 0 || lower.length !== name.length) return html`${name}`;
  const end = at + query.length;
  return html`${name.slice(0, at)}<mark>${name.slice(at, end)}</mark>${name.slice(end)}`;
}

/** "1st", "2nd", "3rd", "4th": a place in a round. */
export function ordinal(n: number): string {
  const ends: Partial<Record<Intl.LDMLPluralRule, string>> = { one: "st", two: "nd", few: "rd" };
  return `${n}${ends[new Intl.PluralRules("en", { type: "ordinal" }).select(n)] ?? "th"}`;
}

const mapNames: Record<string, string> = { "workshop-island-night": "Workshop Island Night", other: "Another map" };
export const mapName = (map: string | null): string => (map ? (mapNames[map] ?? map) : "");

/** A match's grey chips: a tourney match, a void one, one from an older game version. */
export function matchFlags(m: { tournament: boolean; void: boolean; legacy: boolean }): Html {
  return html`${m.tournament && html`<gb-chip title="A tourney match: counts more on the leaderboard">Tourney</gb-chip>`}${
    m.void && html`<gb-chip class="void" title="Doesn't count for ratings">Void</gb-chip>`
  }${m.legacy && html`<gb-chip title="Played on an older game version">Legacy</gb-chip>`}`;
}
