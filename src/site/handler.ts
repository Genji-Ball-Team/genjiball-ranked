import type { Config } from "../config";
import { fail } from "../http";
import { isoSeconds } from "../time";
import { rankTags, type RankTagsConfig } from "./rankTags";
import { nextTier, standing } from "./standing";
import {
  findMatchDetail,
  findPlayer,
  findRating,
  listLeaderboard,
  listPlayerMatches,
  listTagCandidates,
  rankOf,
  type MatchDetail,
  type RatingRow,
} from "./store";

/**
 * The public read API behind the site's pages (#14, docs/api.md "Site"): `/api/leaderboard`,
 * `/api/players/:id` and `/api/matches/:id`. No token; browsers may cache an answer for
 * `publicCacheSeconds`. Also the rank tags the host tool builds the game's code from (#9):
 * `/api/rank-tags`, cached for `rankTagsCacheSeconds`. And `/api/server`: whether this is the test server
 * (#37), for the banner on every page.
 */

export type SiteConfig = RankTagsConfig &
  Pick<Config, "leaderboardPageSize" | "playerRecentMatches" | "publicCacheSeconds" | "rankTagsCacheSeconds" | "testServer">;

/** Answers a site route, or returns null when the path isn't one. */
export async function handleSite(request: Request, db: D1Database, config: SiteConfig, now = new Date()): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "").split("/").slice(2);
  const route = path[0];
  if (path.length === 1 && route === "leaderboard") {
    if (!isRead(request)) return notAllowed();
    return cached(await leaderboard(db, config, url.searchParams.get("page"), now), config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "server") {
    if (!isRead(request)) return notAllowed();
    return cached({ testServer: config.testServer }, config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "rank-tags") {
    if (!isRead(request)) return notAllowed();
    return cached(await tags(db, config, now), config.rankTagsCacheSeconds);
  }
  if (path.length === 2 && (route === "players" || route === "matches")) {
    if (!isRead(request)) return notAllowed();
    const id = /^[1-9]\d{0,15}$/.test(path[1]!) ? Number(path[1]) : null;
    const body = id === null ? null : route === "players" ? await player(db, config, id, now) : await match(db, id);
    if (!body) return fail(404, "not_found", route === "players" ? "No such player" : "No such match");
    return cached(body, config.publicCacheSeconds);
  }
  return null;
}

async function leaderboard(db: D1Database, config: SiteConfig, pageParam: string | null, now: Date) {
  const page = pageParam && /^[1-9]\d{0,5}$/.test(pageParam) ? Number(pageParam) : 1;
  const size = config.leaderboardPageSize;
  const offset = (page - 1) * size;
  // One more than a page, to know if there's a next one.
  const rows = await listLeaderboard(db, config.minRankedRounds, size + 1, offset);
  return {
    page,
    pageSize: size,
    hasMore: rows.length > size,
    players: rows.slice(0, size).map((row, i) => ({ rank: offset + i + 1, ...ratingView(row, config, now) })),
  };
}

async function player(db: D1Database, config: SiteConfig, id: number, now: Date) {
  const [found, rating, matches] = await Promise.all([
    findPlayer(db, id),
    findRating(db, id),
    listPlayerMatches(db, id, config.playerRecentMatches),
  ]);
  if (!found) return null;
  const ranked = rating !== null && rating.rounds >= config.minRankedRounds;
  return {
    player: {
      ...found,
      rating: rating && {
        rank: ranked ? await rankOf(db, rating, config.minRankedRounds) : null,
        ...ratingView(rating, config, now),
        nextTier: nextTier(rating.display, config.tiers),
      },
    },
    matches,
  };
}

function ratingView(row: RatingRow, config: SiteConfig, now: Date) {
  return {
    id: row.playerId,
    name: row.name,
    rating: row.display,
    rounds: row.rounds,
    wins: row.wins,
    lastPlayedAt: row.lastPlayedAt,
    ...standing(row, config, now),
  };
}

async function tags(db: D1Database, config: SiteConfig, now: Date) {
  const lowest = config.tiers[0];
  const activeSince = isoSeconds(new Date(now.getTime() - config.inactiveAfterDays * 24 * 60 * 60 * 1000));
  const candidates = lowest
    ? await listTagCandidates(db, config.minRankedRounds, lowest.threshold, activeSince, config.rankTagsMaxNames)
    : [];
  return rankTags(candidates, config, now);
}

async function match(db: D1Database, id: number) {
  const detail = await findMatchDetail(db, id);
  return detail && { match: matchView(detail) };
}

/** The match page's data: log ids become player ids, and each round lists its finishing order. */
export function matchView({ match, players, rounds, roundPlayers }: MatchDetail) {
  const byLogId = new Map(players.map((p) => [p.logId, p]));
  const perPlayer = new Map(players.map((p) => [p.playerId, { rounds: 0, wins: 0 }]));
  const roundsView = rounds.map((round) => {
    const entries = roundPlayers.filter((rp) => rp.roundId === round.id);
    // Rated rounds have the rated order; other rounds the winner, then the logged ELIM places.
    const order = (rp: (typeof entries)[number]) =>
      rp.position ?? (rp.logId === round.winnerId ? 1 : (rp.place ?? Number.MAX_SAFE_INTEGER));
    const placements = entries
      .sort((a, b) => Number(a.left) - Number(b.left) || order(a) - order(b) || a.logId - b.logId)
      .map((rp) => {
        const p = byLogId.get(rp.logId);
        if (round.rated && rp.position !== null && p) {
          const totals = perPlayer.get(p.playerId)!;
          totals.rounds += 1;
          if (rp.position === 1) totals.wins += 1;
        }
        return { playerId: p?.playerId ?? null, name: p?.name ?? null, position: rp.position, left: rp.left };
      });
    const winner = round.winnerId === null ? undefined : byLogId.get(round.winnerId);
    return { number: round.number, result: round.result, rated: round.rated, broken: round.broken, winner: winner?.playerId ?? null, placements };
  });

  // A player who rejoined has two log ids: list them once.
  const seen = new Set<number>();
  const playersView = players
    .filter((p) => !seen.has(p.playerId) && seen.add(p.playerId))
    .map((p) => ({ id: p.playerId, name: p.name, ...perPlayer.get(p.playerId)!, ratingBefore: p.ratingBefore, ratingAfter: p.ratingAfter }));
  return { ...match, players: playersView, rounds: roundsView };
}

function isRead(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function notAllowed(): Response {
  return fail(405, "method_not_allowed", "Use GET", { Allow: "GET, HEAD" });
}

function cached(body: unknown, seconds: number): Response {
  return Response.json(body, { headers: { "Cache-Control": `public, max-age=${seconds}` } });
}
