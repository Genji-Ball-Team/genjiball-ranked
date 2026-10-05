import type { Config } from "../config";
import type { ParsedMatch } from "../parser/types";

/**
 * Host AFK: the host tool's AFK button. Every round that starts while it's on, the host is dropped
 * from the rating like a leaver (GenjiBall-CE `docs/ranked-log.md`, "Host AFK"; docs/rating.md).
 * The log doesn't say: the host tool sends the rounds with the upload (`X-Host-Afk`), and the host
 * is the player whose `JOIN` has `host` `1`. Pure: no D1.
 */

/** AFK rounds by `matchKey`: `ROUND_START` numbers, ascending, no repeats. */
export type HostAfk = Map<string, number[]>;

export type HostAfkConfig = Pick<Config, "hostMatchKeysMax" | "hostAfkMaxRounds">;

/** What a match key may be in the header: no separator or space. The game writes 12 digits. */
const keyPattern = /^[^\s:;,]{1,64}$/;
const roundPattern = /^[1-9]\d{0,8}$/;

/**
 * Reads `X-Host-Afk: <matchKey>:<round>,<round>[;<matchKey>:<rounds>...]`. Missing or blank: no
 * rounds. A key may have no rounds (`482913507226:`); a key listed twice gets both lists. Returns
 * the message of the `400` for a malformed header.
 */
export function parseHostAfkHeader(header: string | null, config: HostAfkConfig): HostAfk | string {
  const afk: HostAfk = new Map();
  if (!header?.trim()) return afk;
  for (const entry of header.split(";")) {
    if (!entry.trim()) continue;
    const colon = entry.indexOf(":");
    if (colon < 0) return `X-Host-Afk: "${clip(entry)}" isn't <matchKey>:<rounds>`;
    const key = entry.slice(0, colon).trim();
    if (!keyPattern.test(key)) return `X-Host-Afk: "${clip(key)}" isn't a match key`;
    const rounds = new Set(afk.get(key));
    for (const field of entry.slice(colon + 1).split(",")) {
      const round = field.trim();
      if (!round) continue;
      if (!roundPattern.test(round)) return `X-Host-Afk: "${clip(round)}" isn't a round number (match ${key})`;
      rounds.add(Number(round));
    }
    if (rounds.size > config.hostAfkMaxRounds) return `X-Host-Afk: at most ${config.hostAfkMaxRounds} rounds a match (match ${key})`;
    afk.set(key, [...rounds].sort((a, b) => a - b));
    if (afk.size > config.hostMatchKeysMax) return `X-Host-Afk: at most ${config.hostMatchKeysMax} matches`;
  }
  return afk;
}

/** Both lists' rounds, ascending: the lowest `max` if there are more. */
export function unionRounds(a: readonly number[], b: readonly number[], max: number): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y).slice(0, max);
}

/** Whether one of these rounds drops the host from the match: a round of it they were in and didn't leave. */
export function dropsHost(match: ParsedMatch, rounds: readonly number[]): boolean {
  return withHostAfk(match, rounds) !== match;
}

/**
 * The match with the host dropped from the AFK rounds, like a leaver: out of the finishing order
 * (the others keep theirs) and listed in `afkIds`. A host who rejoined has several ids: all are
 * dropped. Nothing else changes (stats, wins), and a log without `host` has no host to drop. The
 * parse isn't changed: a new match is returned when a round is.
 */
export function withHostAfk(match: ParsedMatch, afkRounds: readonly number[]): ParsedMatch {
  const hostIds = new Set(match.players.filter((p) => p.host).map((p) => p.id));
  if (!hostIds.size || !afkRounds.length) return match;
  const afk = new Set(afkRounds);
  let changed = false;
  const rounds = match.rounds.map((round) => {
    if (!afk.has(round.number)) return round;
    // A host who left the round is already dropped as a leaver.
    const afkIds = round.playerIds.filter((id) => hostIds.has(id) && !round.leftIds.includes(id));
    if (!afkIds.length) return round;
    changed = true;
    const finishingOrder = round.finishingOrder?.filter((id) => !afkIds.includes(id)) ?? null;
    return { ...round, afkIds, finishingOrder };
  });
  return changed ? { ...match, rounds } : match;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}
