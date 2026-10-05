import { findRegion, type Config, type Region } from "../config";
import { fail } from "../http";
import { secondsBefore } from "../lobby/handler";
import { listLiveLobbies } from "../lobby/store";
import { isoSeconds } from "../time";
import { nameKey } from "../upload/plan";
import { screenshotUrl, isScreenshotKey } from "../tourney/screenshot";
import { findTourney, hasScreenshot, listLobbies, listPast, listUpcoming, readStandings, type LobbyRow, type TourneyRow } from "../tourney/store";
import { noRecords, recordsView, type RecordsConfig } from "../records/stats";
import { readRecords } from "../records/store";
import { downsample, peakOf, recentForm, type HistoryConfig } from "./history";
import { rankTags, type RankTagsConfig } from "./rankTags";
import { nextTier, standing } from "./standing";
import {
  canonicalPlayerId,
  findHeadToHead,
  findMatchDetail,
  findPlayer,
  findPlayerStats,
  findRating,
  latestFeedSeq,
  listFeed,
  listFormRounds,
  listHistory,
  listLeaderboard,
  listPlayerMatches,
  listRatedRegions,
  listRivals,
  listTagCandidates,
  rankOf,
  searchPlayers,
  type MatchDetail,
  type RatingRow,
} from "./store";

/**
 * The public read API behind the site's pages (#14, docs/api.md "Site"): `/api/leaderboard`,
 * `/api/players/:id`, `/api/players?search=` and `/api/matches/:id`, and the match feed `/api/matches?after=` (#59),
 * and head-to-head records (#18): `/api/head-to-head?a=&b=`. No token; browsers may cache an answer for
 * `publicCacheSeconds`. Also the rank tags the host tool builds the game's code from (#9):
 * `/api/rank-tags`, cached for `rankTagsCacheSeconds`. And `/api/server`: whether this is the test server
 * (#37), for the banner on every page. And the Tourneys page (#31): `/api/tourneys`, `/api/tourneys/:id`
 * and the verify screenshots, `/api/screenshots/:key`. And the live lobbies (#11): `/api/lobbies`, cached
 * for `lobbiesCacheSeconds`. A player's rating history graph (#17), `/api/players/:id/history`, their
 * round stats for compare (#16), `/api/players/:id/stats`, and
 * the records page (#19), `/api/records`.
 *
 * Regions (#47): the leaderboard, a player's rating, matches, rivals and history, head-to-head, the
 * records, the rank tags, the Tourneys page and the live lobbies show one region's, `?region=`, the
 * first of `regions` without one.
 */

export type SiteConfig = RankTagsConfig &
  HistoryConfig &
  Pick<RecordsConfig, "recordsActivityDays"> &
  Pick<
    Config,
    | "leaderboardPageSize"
    | "matchFeedLimit"
    | "playerRecentMatches"
    | "playerRivalsLimit"
    | "playerSearchLimit"
    | "playerSearchMinLength"
    | "publicCacheSeconds"
    | "rankTagsCacheSeconds"
    | "testServer"
    | "tourneysPageSize"
    | "screenshotCacheSeconds"
    | "regions"
    | "lobbyTtlSeconds"
    | "lobbiesCacheSeconds"
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
  const regional = ["leaderboard", "rank-tags", "tourneys", "players", "lobbies", "records", "head-to-head"].includes(route ?? "");
  const region = regional ? regionParam(url, config) : null;
  if (region instanceof Response) return region;
  if (path.length === 1 && route === "leaderboard") {
    if (!isRead(request)) return notAllowed();
    return cached(await leaderboard(db, config, region!, url.searchParams.get("page"), now), config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "server") {
    if (!isRead(request)) return notAllowed();
    return cached({ testServer: config.testServer, regions: config.regions }, config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "rank-tags") {
    if (!isRead(request)) return notAllowed();
    return cached(await tags(db, config, region!, now), config.rankTagsCacheSeconds);
  }
  if (path.length === 1 && route === "players") {
    if (!isRead(request)) return notAllowed();
    const search = (url.searchParams.get("search") ?? "").trim();
    if ([...search].length < config.playerSearchMinLength) {
      return fail(400, "bad_request", `search needs at least ${config.playerSearchMinLength} characters`);
    }
    return cached(await playerSearch(db, config, region!, url.searchParams.has("region"), search, now), config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "matches") {
    if (!isRead(request)) return notAllowed();
    // Every region's matches unless one is asked for.
    const feedRegion = url.searchParams.has("region") ? regionParam(url, config) : null;
    if (feedRegion instanceof Response) return feedRegion;
    const body = await feed(db, config, feedRegion, url.searchParams.get("after"), url.searchParams.get("limit"));
    if (!body) return fail(400, "bad_request", `after must be a cursor from this feed, 0 or latest; limit 1 to ${config.matchFeedLimit}`);
    return cached(body, config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "lobbies") {
    if (!isRead(request)) return notAllowed();
    return cached(await lobbies(db, config, region!, now), config.lobbiesCacheSeconds);
  }
  if (path.length === 1 && route === "records") {
    if (!isRead(request)) return notAllowed();
    return cached(await records(db, config, region!, now), config.publicCacheSeconds);
  }
  if (path.length === 3 && route === "players" && (path[2] === "history" || path[2] === "stats")) {
    if (!isRead(request)) return notAllowed();
    const id = /^[1-9]\d{0,15}$/.test(path[1]!) ? Number(path[1]) : null;
    const body = id === null ? null : await (path[2] === "history" ? history : stats)(db, config, region!, id);
    if (!body) return fail(404, "not_found", "No such player");
    return cached(body, config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "head-to-head") {
    if (!isRead(request)) return notAllowed();
    const a = playerIdParam(url.searchParams.get("a"));
    const b = playerIdParam(url.searchParams.get("b"));
    if (a === null || b === null || a === b) return fail(400, "bad_request", "a and b must be two different player ids");
    const body = await headToHead(db, region!, a, b);
    if (body === "same") return fail(400, "bad_request", "a and b are one player (merged)");
    if (!body) return fail(404, "not_found", "No such player");
    return cached(body, config.publicCacheSeconds);
  }
  if (path.length === 1 && route === "tourneys") {
    if (!isRead(request)) return notAllowed();
    return cached(await tourneys(db, config, region!, url.searchParams.get("page")), config.publicCacheSeconds);
  }
  if (path.length === 2 && route === "screenshots") {
    if (!isRead(request)) return notAllowed();
    return screenshot(db, proofs, path[1]!, config);
  }
  if (path.length === 2 && (route === "players" || route === "matches" || route === "tourneys")) {
    if (!isRead(request)) return notAllowed();
    const id = playerIdParam(path[1]!);
    const read = { players: () => player(db, config, region!, id!, now), matches: () => match(db, id!), tourneys: () => tourney(db, id!) }[route];
    const body = id === null ? null : await read();
    if (!body) return fail(404, "not_found", { players: "No such player", matches: "No such match", tourneys: "No such tourney" }[route]);
    return cached(body, config.publicCacheSeconds);
  }
  return null;
}

/** A positive id from the path or a parameter, or null. */
function playerIdParam(param: string | null): number | null {
  return param !== null && /^[1-9]\d{0,15}$/.test(param) ? Number(param) : null;
}

/** `?region=`: one of `regions`, the first without it, or the 400 for one that isn't a region. */
function regionParam(url: URL, config: SiteConfig): Region | Response {
  const param = url.searchParams.get("region");
  const region = param === null ? config.regions[0]! : findRegion(config.regions, param);
  return region ?? fail(400, "bad_request", `region must be one of ${config.regions.map((r) => r.id).join(", ")}`);
}

async function leaderboard(db: D1Database, config: SiteConfig, region: Region, pageParam: string | null, now: Date) {
  const page = pageParam && /^[1-9]\d{0,5}$/.test(pageParam) ? Number(pageParam) : 1;
  const size = config.leaderboardPageSize;
  const offset = (page - 1) * size;
  // One more than a page, to know if there's a next one.
  const rows = await listLeaderboard(db, region.id, config.minRankedRounds, size + 1, offset);
  return {
    region: region.id,
    page,
    pageSize: size,
    hasMore: rows.length > size,
    players: rows.slice(0, size).map((row, i) => ({ rank: offset + i + 1, ...ratingView(row, config, now) })),
  };
}

/**
 * The region's open ranked lobbies, longest open first: those with a heartbeat in the last
 * `lobbyTtlSeconds`. `tourney` is the tourney lobby it's for, once #25 lets a heartbeat say so.
 */
async function lobbies(db: D1Database, config: SiteConfig, region: Region, now: Date) {
  const rows = await listLiveLobbies(db, region.id, secondsBefore(now, config.lobbyTtlSeconds));
  return { region: region.id, lobbies: rows.map((row) => ({ ...row, tourney: null })) };
}

/**
 * The match feed: public matches changed after the cursor, oldest change first, in one region or
 * all. `after=latest` gives no matches and the current cursor, to start from now. Null when a
 * parameter is malformed.
 */
async function feed(db: D1Database, config: SiteConfig, region: Region | null, afterParam: string | null, limitParam: string | null) {
  const limit = limitParam === null ? config.matchFeedLimit : /^[1-9]\d{0,5}$/.test(limitParam) ? Number(limitParam) : 0;
  if (limit < 1 || limit > config.matchFeedLimit) return null;
  if (afterParam === "latest") return { cursor: await latestFeedSeq(db), hasMore: false, matches: [] };
  if (afterParam === null || !/^(0|[1-9]\d{0,15})$/.test(afterParam)) return null;
  const after = Number(afterParam);
  // One more than asked for, to know if there's more.
  const rows = await listFeed(db, after, region?.id ?? null, limit + 1);
  const shown = rows.slice(0, limit);
  return {
    cursor: shown.at(-1)?.seq ?? after,
    hasMore: rows.length > limit,
    matches: shown.map((row) => row.match),
  };
}

/**
 * A player in one region: their rating, matches and rivals there, and the regions they have a rating
 * in. A player an admin merged into another (#8) answers as that one, so old links keep working.
 */
async function player(db: D1Database, config: SiteConfig, region: Region, id: number, now: Date): Promise<object | null> {
  const canonical = await canonicalPlayerId(db, id);
  if (canonical === null) return null;
  const [found, rating, matches, rated, rivals] = await Promise.all([
    findPlayer(db, canonical),
    findRating(db, region.id, canonical),
    listPlayerMatches(db, region.id, canonical, config.playerRecentMatches),
    listRatedRegions(db, canonical),
    listRivals(db, region.id, canonical, config.playerRivalsLimit),
  ]);
  if (!found) return null;
  const ranked = rating !== null && rating.rounds >= config.minRankedRounds;
  return {
    region: region.id,
    player: {
      id: found.id,
      name: found.name,
      aliases: found.aliases,
      regions: config.regions.map((r) => r.id).filter((r) => rated.includes(r)),
      rating: rating && {
        rank: ranked ? await rankOf(db, region.id, rating, config.minRankedRounds) : null,
        ...ratingView(rating, config, now),
        nextTier: nextTier(rating.display, config.tiers),
      },
    },
    matches,
    ...rivals,
  };
}

/**
 * Two players' record against each other in one region (#18). A player an admin merged into another
 * (#8) counts as that one; `"same"` when both are one player. Null when either isn't a player.
 */
async function headToHead(db: D1Database, region: Region, aId: number, bId: number) {
  const [a, b] = await Promise.all([canonicalPlayerId(db, aId), canonicalPlayerId(db, bId)]);
  if (a === null || b === null) return null;
  if (a === b) return "same" as const;
  const [first, second, record] = await Promise.all([findPlayer(db, a), findPlayer(db, b), findHeadToHead(db, region.id, a, b)]);
  if (!first || !second) return null;
  return {
    region: region.id,
    rounds: record.rounds,
    a: { id: first.id, name: first.name, ahead: record.ahead, kills: record.kills },
    b: { id: second.id, name: second.name, ahead: record.rounds - record.ahead, kills: record.deaths },
  };
}

/**
 * A player's rating history in one region (#17): the graph (at most `ratingHistoryMaxPoints`
 * points), the peak, the win streaks and the recent form. Compare (#16) asks once per player, so
 * each answer is cached on its own URL.
 */
async function history(db: D1Database, config: SiteConfig, region: Region, requested: number) {
  // A merged player's id answers for the player they were merged into (#8), like the player page.
  const id = await canonicalPlayerId(db, requested);
  if (id === null) return null;
  const [found, rows] = await Promise.all([findPlayer(db, id), listHistory(db, region.id, id)]);
  if (!found) return null;
  const form = recentForm(await listFormRounds(db, region.id, id, config.recentFormRounds));
  const peak = peakOf(rows);
  const last = rows.at(-1);
  const point = (row: (typeof rows)[number]) => ({ matchId: row.matchId, playedAt: row.playedAt, rating: row.rating });
  return {
    region: region.id,
    player: { id: found.id, name: found.name },
    matches: rows.length,
    points: downsample(rows, config.ratingHistoryMaxPoints).map(point),
    peak: peak && point(peak),
    streak: last?.streak ?? 0,
    bestStreak: last?.bestStreak ?? 0,
    form,
  };
}

/**
 * A player's round stats in one region, for compare (#16): kills, deflects and touches in their rated
 * rounds, and their average place. Its own route, so the player page doesn't read every round.
 */
async function stats(db: D1Database, _config: SiteConfig, region: Region, requested: number) {
  const id = await canonicalPlayerId(db, requested);
  if (id === null) return null;
  const [found, totals] = await Promise.all([findPlayer(db, id), findPlayerStats(db, region.id, id)]);
  if (!found) return null;
  return { region: region.id, player: { id: found.id, name: found.name }, stats: totals };
}

/** The region's records page, as the cron last stored it; empty before the first refresh. */
async function records(db: D1Database, config: SiteConfig, region: Region, now: Date) {
  const stored = await readRecords(db, region.id);
  if (stored) return { region: region.id, updatedAt: stored.refreshedAt, ...stored.body };
  return { region: region.id, updatedAt: null, ...recordsView({ records: noRecords, days: [], players: 0, topHosts: [] }, config, now) };
}

/**
 * Name search for the Discord bot's autocomplete and the site (#58), with the region's ratings.
 * With `?region=` sent (`onlyRated`), only players rated there.
 */
async function playerSearch(db: D1Database, config: SiteConfig, region: Region, onlyRated: boolean, search: string, now: Date) {
  const rows = await searchPlayers(db, nameKey(search), region.id, onlyRated, config.playerSearchLimit);
  return {
    region: region.id,
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

async function tags(db: D1Database, config: SiteConfig, region: Region, now: Date) {
  const lowest = config.tiers[0];
  const activeSince = isoSeconds(new Date(now.getTime() - config.inactiveAfterDays * 24 * 60 * 60 * 1000));
  const candidates = lowest
    ? await listTagCandidates(db, region.id, config.minRankedRounds, lowest.threshold, activeSince, config.rankTagsMaxNames)
    : [];
  return { region: region.id, ...rankTags(candidates, config, now) };
}

async function match(db: D1Database, id: number) {
  const detail = await findMatchDetail(db, id);
  return detail && { match: matchView(detail) };
}

/**
 * The match page's data: log ids become player ids, and each round lists its finishing order. Stats
 * (#15), counted at upload: `kills` (`KILL` lines with them as attacker, not a self-kill: per round
 * those in it, for the match every one, between rounds too), `deflects`, `touches` (deflects plus
 * times a ball someone sent eliminated them; a hit before anyone deflected can't be told from a
 * fall). For the match: `roundWins` (every `WIN` round, rated or not), `longestStreak` (most of them
 * in a row) and `place`. Legacy logs have no deflects: those are null.
 */
export function matchView({ match, players, rounds, roundPlayers }: MatchDetail) {
  const byLogId = new Map(players.map((p) => [p.logId, p]));
  const perPlayer = new Map(
    players.map((p) => [
      p.playerId,
      { rounds: 0, wins: 0, roundWins: 0, kills: 0, deflects: match.legacy ? null : 0, touches: match.legacy ? null : 0, longestStreak: 0 },
    ]),
  );
  // A player who rejoined has a log id per stay: their kills add up.
  for (const p of players) perPlayer.get(p.playerId)!.kills += p.kills;
  // The current run of round wins, per player.
  const streaks = new Map<number, number>();
  const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
  // Each round's players, in one pass: a long match has thousands of rounds.
  const byRound = new Map<number, typeof roundPlayers>();
  for (const rp of roundPlayers) {
    const list = byRound.get(rp.roundId);
    if (list) list.push(rp);
    else byRound.set(rp.roundId, [rp]);
  }
  const roundsView = rounds.map((round) => {
    const entries = byRound.get(round.id) ?? [];
    // Rated rounds have the rated order; other rounds the winner, then the logged ELIM places.
    const order = (rp: (typeof entries)[number]) =>
      rp.position ?? (rp.logId === round.winnerId ? 1 : (rp.place ?? Number.MAX_SAFE_INTEGER));
    const placements = entries
      .sort((a, b) => Number(a.left) - Number(b.left) || order(a) - order(b) || a.logId - b.logId)
      .map((rp) => {
        const p = byLogId.get(rp.logId);
        const deflects = match.legacy ? null : rp.deflects;
        const touches = add(deflects, rp.killerId === null ? 0 : 1);
        const totals = p && perPlayer.get(p.playerId)!;
        if (p && totals) {
          if (round.rated && rp.position !== null) {
            totals.rounds += 1;
            if (rp.position === 1) totals.wins += 1;
          }
          totals.deflects = add(totals.deflects, deflects);
          totals.touches = add(totals.touches, touches);
          // A streak runs over the WIN rounds they played to the end; other rounds don't break it.
          if (round.result === "WIN" && !rp.left) {
            const won = rp.logId === round.winnerId;
            if (won) totals.roundWins += 1;
            const streak = won ? (streaks.get(p.playerId) ?? 0) + 1 : 0;
            streaks.set(p.playerId, streak);
            totals.longestStreak = Math.max(totals.longestStreak, streak);
          }
        }
        return { playerId: p?.playerId ?? null, name: p?.name ?? null, position: rp.position, left: rp.left, kills: rp.kills, deflects, touches };
      });
    const winner = round.winnerId === null ? undefined : byLogId.get(round.winnerId);
    return { number: round.number, result: round.result, rated: round.rated, broken: round.broken, winner: winner?.playerId ?? null, placements };
  });

  // A player who rejoined has two log ids: list them once.
  const seen = new Set<number>();
  const playersView = players
    .filter((p) => !seen.has(p.playerId) && seen.add(p.playerId))
    .map((p) => ({ id: p.playerId, name: p.name, ...perPlayer.get(p.playerId)!, ratingBefore: p.ratingBefore, ratingAfter: p.ratingAfter }));
  // Overall, as the tourney standings: most rounds won (every WIN round), ties broken by kills; the
  // same wins and kills share a place.
  const placeOf = (p: (typeof playersView)[number]) =>
    1 + playersView.filter((o) => o.roundWins > p.roundWins || (o.roundWins === p.roundWins && o.kills > p.kills)).length;
  return { ...match, players: playersView.map((p) => ({ ...p, place: placeOf(p) })), rounds: roundsView };
}

/**
 * The Tourneys page: every tourney still to come, soonest first, and a page of past ones, newest
 * first, each lobby with its standings.
 */
async function tourneys(db: D1Database, config: SiteConfig, region: Region, pageParam: string | null) {
  const page = pageParam && /^[1-9]\d{0,5}$/.test(pageParam) ? Number(pageParam) : 1;
  const size = config.tourneysPageSize;
  // One more than a page, to know if there's a next one.
  const [upcoming, past] = await Promise.all([
    page === 1 ? listUpcoming(db, region.id) : [],
    listPast(db, region.id, size + 1, (page - 1) * size),
  ]);
  const shown = [...upcoming, ...past.slice(0, size)];
  const views = await tourneyViews(db, shown);
  return { region: region.id, page, pageSize: size, hasMore: past.length > size, upcoming: views.slice(0, upcoming.length), past: views.slice(upcoming.length) };
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
