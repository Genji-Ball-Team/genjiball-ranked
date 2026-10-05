import type { Config } from "../config";
import { fail } from "../http";
import { isoSeconds } from "../time";
import { nameKey } from "../upload/plan";
import { screenshotUrl, isScreenshotKey } from "../tourney/screenshot";
import { findTourney, hasScreenshot, listLobbies, listPast, listUpcoming, readStandings, type LobbyRow, type TourneyRow } from "../tourney/store";
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
  searchPlayers,
  type MatchDetail,
  type RatingRow,
} from "./store";

/**
 * The public read API behind the site's pages (#14, docs/api.md "Site"): `/api/leaderboard`,
 * `/api/players/:id`, `/api/players?search=` and `/api/matches/:id`. No token; browsers may cache an answer for
 * `publicCacheSeconds`. Also the rank tags the host tool builds the game's code from (#9):
 * `/api/rank-tags`, cached for `rankTagsCacheSeconds`. And `/api/server`: whether this is the test server
 * (#37), for the banner on every page. And the Tourneys page (#31): `/api/tourneys`, `/api/tourneys/:id`
 * and the verify screenshots, `/api/screenshots/:key`.
 */

export type SiteConfig = RankTagsConfig &
  Pick<
    Config,
    "leaderboardPageSize" | "playerRecentMatches" | "playerSearchLimit" | "playerSearchMinLength" | "publicCacheSeconds" | "rankTagsCacheSeconds" | "testServer" | "tourneysPageSize" | "screenshotCacheSeconds"
  >;

/** Answers a site route, or returns null when the path isn't one. */
export async function handleSite(
  request: Request,
  db: D1Database,
  config: SiteConfig,
  now = new Date(),
  proofs?: R2Bucket,
): Promise<Response | null> {
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
  if (path.length === 1 && route === "players") {
    if (!isRead(request)) return notAllowed();
    const search = (url.searchParams.get("search") ?? "").trim();
    if ([...search].length < config.playerSearchMinLength) {
      return fail(400, "bad_request", `search needs at least ${config.playerSearchMinLength} characters`);
    }
    return cached(await playerSearch(db, config, search, now), config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "tourneys") {
    if (!isRead(request)) return notAllowed();
    return cached(await tourneys(db, config, url.searchParams.get("page")), config.publicCacheSeconds);
  }
  if (path.length === 2 && route === "screenshots") {
    if (!isRead(request)) return notAllowed();
    return screenshot(db, proofs, path[1]!, config);
  }
  if (path.length === 2 && (route === "players" || route === "matches" || route === "tourneys")) {
    if (!isRead(request)) return notAllowed();
    const id = /^[1-9]\d{0,15}$/.test(path[1]!) ? Number(path[1]) : null;
    const read = { players: () => player(db, config, id!, now), matches: () => match(db, id!), tourneys: () => tourney(db, id!) }[route];
    const body = id === null ? null : await read();
    if (!body) return fail(404, "not_found", { players: "No such player", matches: "No such match", tourneys: "No such tourney" }[route]);
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

/** Name search for the Discord bot's autocomplete and the site (#58). */
async function playerSearch(db: D1Database, config: SiteConfig, search: string, now: Date) {
  const rows = await searchPlayers(db, nameKey(search), config.playerSearchLimit);
  return {
    players: rows.map((row) => ({
      id: row.id,
      name: row.name,
      rating: row.display,
      tier: row.display === null ? null : standing({ ...row, display: row.display }, config, now).tier,
      matchedAlias: row.matchedAlias,
    })),
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

/**
 * The Tourneys page: every tourney still to come, soonest first, and a page of past ones, newest
 * first, each lobby with its standings.
 */
async function tourneys(db: D1Database, config: SiteConfig, pageParam: string | null) {
  const page = pageParam && /^[1-9]\d{0,5}$/.test(pageParam) ? Number(pageParam) : 1;
  const size = config.tourneysPageSize;
  // One more than a page, to know if there's a next one.
  const [upcoming, past] = await Promise.all([page === 1 ? listUpcoming(db) : [], listPast(db, size + 1, (page - 1) * size)]);
  const shown = [...upcoming, ...past.slice(0, size)];
  const views = await tourneyViews(db, shown);
  return { page, pageSize: size, hasMore: past.length > size, upcoming: views.slice(0, upcoming.length), past: views.slice(upcoming.length) };
}

async function tourney(db: D1Database, id: number) {
  const found = await findTourney(db, id);
  if (!found) return null;
  const [view] = await tourneyViews(db, [found]);
  return { tourney: view };
}

/** Tourneys with their lobbies, and each public match's standings. */
async function tourneyViews(db: D1Database, list: TourneyRow[]) {
  const lobbies = await listLobbies(
    db,
    list.map((t) => t.id),
  );
  const standings = await readStandings(
    db,
    lobbies.filter((l) => l.matchPublic).map((l) => l.matchId!),
  );
  const lobbyView = (l: LobbyRow) => ({
    id: l.id,
    label: l.label,
    // A match in review or rejected isn't public (docs/api.md, "Site"): the lobby shows no result yet.
    matchId: l.matchPublic ? l.matchId : null,
    void: l.matchPublic && l.matchVoid,
    screenshot: screenshotUrl(l.screenshotKey),
    // Deleted to stay inside the storage caps: the result and verified mark stay.
    screenshotExpired: l.screenshotKey === null && l.screenshotExpiredAt !== null,
    verified: l.verifiedAt !== null,
    standings: l.matchPublic ? standings.get(l.matchId!)! : [],
  });
  return list.map((t) => ({ ...t, lobbies: lobbies.filter((l) => l.tourneyId === t.id).map(lobbyView) }));
}

/** A currently attached verify screenshot from R2, cached for the configured lifetime. */
async function screenshot(db: D1Database, proofs: R2Bucket | undefined, key: string, config: SiteConfig): Promise<Response> {
  const object = proofs && isScreenshotKey(key) && await hasScreenshot(db, key) ? await proofs.get(key) : null;
  if (!object) return fail(404, "not_found", "No such screenshot");
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": `public, max-age=${config.screenshotCacheSeconds}, immutable`,
      "X-Content-Type-Options": "nosniff",
      ETag: object.httpEtag,
    },
  });
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
