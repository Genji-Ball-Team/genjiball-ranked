import { findRegion, type Config, type Region } from "../config";
import { positiveId } from "../http";
import { matchView } from "./handler";
import { standing, type StandingConfig } from "./standing";
import { findCanonicalPlayer, findMatchDetail, findRating, rankOf } from "./store";

/**
 * Link previews: a player, match or compare link posted in Discord, X and the like shows that
 * page's own title and description instead of the site's. The pages are static HTML that fill
 * themselves in the browser, which a link preview crawler doesn't run, so for a crawler
 * (`linkPreviewAgents`) the Worker writes them into the page's meta tags. Everyone else gets the
 * page as it is.
 */

export type PreviewConfig = StandingConfig & Pick<Config, "regions" | "linkPreviewAgents" | "compareMaxPlayers">;

export interface Preview {
  title: string;
  description: string;
}

/** The pages with a preview of their own. */
export const previewPages: readonly string[] = ["/player", "/match", "/compare"];

const siteName = "Genji Ball Ranked";

/** Whether the request comes from a link preview crawler (`linkPreviewAgents`). */
export function isPreviewAgent(request: Request, config: Pick<PreviewConfig, "linkPreviewAgents">): boolean {
  const agent = (request.headers.get("User-Agent") ?? "").toLowerCase();
  return config.linkPreviewAgents.some((name) => agent.includes(name.toLowerCase()));
}

/** The page's preview, or null when it shows nothing (no such player or match): the site's own then. */
export async function pagePreview(db: D1Database, config: PreviewConfig, url: URL, now: Date): Promise<Preview | null> {
  // A player or compare page in an unknown region shows the first, as the site does.
  const region = findRegion(config.regions, url.searchParams.get("region")) ?? config.regions[0]!;
  if (url.pathname === "/player") {
    const id = positiveId(url.searchParams.get("id"));
    return id === null ? null : playerPreview(db, config, region, id, now);
  }
  if (url.pathname === "/match") {
    const id = positiveId(url.searchParams.get("id"));
    return id === null ? null : matchPreview(db, config, id);
  }
  if (url.pathname === "/compare") {
    const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map(positiveId))].filter((id) => id !== null);
    return ids.length ? comparePreview(db, config, region, ids.slice(0, config.compareMaxPlayers), now) : null;
  }
  return null;
}

/** One player's standing in a region, as the preview words it: `Master · 1650`, or null without a rating. */
async function rated(db: D1Database, config: PreviewConfig, region: Region, id: number, now: Date) {
  const player = await findCanonicalPlayer(db, id);
  if (!player) return null;
  const rating = await findRating(db, region.id, player.id);
  if (!rating) return { name: player.name, rating: null, rank: null, line: "" };
  const { siteTier } = standing(rating, config, now);
  const ranked = rating.rounds >= config.minRankedRounds;
  return {
    name: player.name,
    rating,
    rank: ranked ? await rankOf(db, region.id, rating, config.minRankedRounds) : null,
    line: [siteTier?.label, rating.display > 0 ? String(rating.display) : null].filter(Boolean).join(" · "),
  };
}

async function playerPreview(db: D1Database, config: PreviewConfig, region: Region, id: number, now: Date): Promise<Preview | null> {
  const p = await rated(db, config, region, id, now);
  if (!p) return null;
  if (!p.rating) return { title: `${p.name} (${region.label})`, description: `No rated rounds in ${region.label} yet. Genji Ball ranked stats.` };
  const r = p.rating;
  const won = r.rounds ? Math.round((100 * r.wins) / r.rounds) : 0;
  return {
    title: `${p.name}${p.line ? ` · ${p.line}` : ""}`,
    description: [
      p.rank ? `#${p.rank} on the ${region.label} leaderboard.` : `Not on the ${region.label} leaderboard yet.`,
      `${r.rounds} rated ${r.rounds === 1 ? "round" : "rounds"}, ${won}% won.`,
    ].join(" "),
  };
}

async function matchPreview(db: D1Database, config: PreviewConfig, id: number): Promise<Preview | null> {
  const detail = await findMatchDetail(db, id);
  if (!detail) return null;
  const m = matchView(detail);
  const region = findRegion(config.regions, m.region);
  const won = m.players.filter((p) => p.place === 1 && p.roundWins > 0);
  const winner = won.length ? `${won.map((p) => p.name).join(" & ")} ${won.length > 1 ? "share the win" : "wins"}` : null;
  const day = m.playedAt.slice(0, 10);
  const top = [...m.players]
    .sort((a, b) => a.place - b.place)
    .slice(0, 3)
    .map((p) => `${p.place}. ${p.name} (${p.roundWins} won, ${p.kills} ${p.kills === 1 ? "kill" : "kills"})`);
  return {
    title: [`Match ${m.id}`, winner, m.tourney?.name].filter(Boolean).join(" · "),
    description: [
      `${m.players.length} players, ${m.rounds.length} ${m.rounds.length === 1 ? "round" : "rounds"}${region ? ` in ${region.label}` : ""}, ${day}.`,
      top.join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  };
}

async function comparePreview(db: D1Database, config: PreviewConfig, region: Region, ids: number[], now: Date): Promise<Preview | null> {
  const players = (await Promise.all(ids.map((id) => rated(db, config, region, id, now)))).filter((p) => p !== null);
  if (!players.length) return null;
  return {
    title: players.length > 1 ? players.map((p) => p.name).join(" vs ") : `Compare ${players[0]!.name}`,
    description: `${players.map((p) => `${p.name}: ${p.rating ? p.line || "unranked" : "not rated"}`).join(" · ")}. Side by side in ${region.label}.`,
  };
}

/** The page with the preview in its title and meta tags, and the share image's address made absolute (crawlers want one). */
export function withPreview(page: Response, preview: Preview | null, url: URL): Response {
  const image = new URL("/og.png", url).href;
  const content = (value: string) => ({ element: (el: Element) => void el.setAttribute("content", value) });
  let rewriter = new HTMLRewriter()
    .on('meta[property="og:image"]', content(image))
    .on('meta[property="og:url"]', content(url.href));
  if (preview) {
    rewriter = rewriter
      .on("title", { element: (el) => void el.setInnerContent(`${preview.title} – ${siteName}`) })
      .on('meta[name="description"], meta[property="og:description"]', content(preview.description))
      .on('meta[property="og:title"]', content(preview.title));
  }
  const res = rewriter.transform(page);
  const headers = new Headers(res.headers);
  // Made for this request: no asset ETag, and not the page a browser gets.
  headers.delete("ETag");
  headers.set("Cache-Control", "no-store");
  headers.set("Vary", "User-Agent");
  return new Response(res.body, { status: res.status, headers });
}
