import type { Title } from "../config";

/**
 * Titles (God, Demigod): won in the 1v1 tourney every two months, and given by the Discord staff as a
 * role per region. Who has them is the Discord bot's to know: it reads the roles of the players it has
 * linked to their site player, and answers `GET /titles` on its Worker, reached here through the `BOT`
 * service binding (wrangler.toml). The site only shows them: `/api/titles` and the leaderboard page.
 */

export interface TitleEntry {
  playerId: number;
  region: string;
  title: string;
}

/** The bot's titles, or none when there's no binding or the bot doesn't answer: the leaderboard then shows no titles. */
export async function fetchTitles(bot: Fetcher | undefined): Promise<TitleEntry[]> {
  if (!bot) return [];
  try {
    const response = await bot.fetch("https://bot/titles");
    return response.ok ? parseTitles(await response.json()) : [];
  } catch {
    return [];
  }
}

/** The well-formed entries of the bot's `{ titles: [{ playerId, region, title }] }`. */
export function parseTitles(body: unknown): TitleEntry[] {
  const list = (body as { titles?: unknown } | null)?.titles;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is TitleEntry =>
      typeof e === "object" && e !== null && Number.isSafeInteger(e.playerId) && e.playerId > 0 && typeof e.region === "string" && typeof e.title === "string",
  );
}

/**
 * One region's titled players, in the order of `titles` and best rated first within a title, at most
 * `max` of each. `rated` are the players' ratings there by id: someone without one isn't shown. A
 * player with two titles shows under the first.
 */
export function pickTitles<T extends { playerId: number; display: number }>(
  entries: readonly TitleEntry[],
  region: string,
  titles: readonly Title[],
  rated: ReadonlyMap<number, T>,
): { title: string; rating: T }[] {
  const shown = new Set<number>();
  return titles.flatMap(({ label, max }) => {
    const picked = entries
      .filter((e) => e.region === region && e.title === label && !shown.has(e.playerId))
      .map((e) => rated.get(e.playerId))
      .filter((r, i, all): r is T => r !== undefined && all.findIndex((o) => o?.playerId === r.playerId) === i)
      .sort((a, b) => b.display - a.display || a.playerId - b.playerId)
      .slice(0, max);
    picked.forEach((r) => shown.add(r.playerId));
    return picked.map((rating) => ({ title: label, rating }));
  });
}
