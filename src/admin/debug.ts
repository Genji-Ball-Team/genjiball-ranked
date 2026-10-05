import { fail } from "../http";
import { isRated, planUpload, type MatchPlan } from "../upload/plan";
import { parseFile, readBody, result, sha256 } from "../upload/handler";
import { findStoredCopies, findUploadByHash, type Host } from "../upload/store";
import { displayRating, recompute, type RatingMatch } from "../rating/engine";
import { diffRatings } from "../rating/diff";
import type { StoredRating } from "../rating/plan";
import {
  fromStart,
  peekStaleFrom,
  readAcceptedFrom,
  readBoard,
  readBoardBefore,
  readRounds,
  readState,
  staleFromStatement,
} from "../rating/store";
import { counts, updateRatings } from "../rating/update";
import type { ParsedMatch } from "../parser/types";
import { isoSeconds } from "../time";
import { actionStatement, findHostById } from "./store";
import { BadRequest, regionField, type Context } from "./request";

/**
 * Debug tools for admins (#33): what the parser makes of a log, and what a recompute would do to a
 * region's ratings, without writing anything (docs/api.md, "Admin").
 */

/** `?name=1` / `true` on, `0` / `false` / left out off. */
function flag(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  if (value === null || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new BadRequest(`${name} must be 1 or 0`);
}

/**
 * `POST /api/admin/parse?region=&host=&legacy=1`: the body is a log file, as with an upload (same
 * size limit). Parses it and plans it like an upload would, and answers what it found, writing
 * nothing. With `host`, the plan is against that host's stored copies and trust; without, as from a
 * trusted host with nothing stored. `region` is echoed into the matches (else the host's home region).
 * `legacy=1` reads it as a v1.3.2 file, as `legacy-import` does.
 */
export async function dryRunParse(ctx: Context, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const asked = params.has("region") ? regionField(params.get("region"), ctx.config, "region") : null;
  const legacy = flag(params, "legacy");
  let host: Host | null = null;
  if (params.has("host")) {
    const hostParam = params.get("host") ?? "";
    if (!/^[1-9]\d{0,15}$/.test(hostParam)) throw new BadRequest("host must be a host id");
    host = await findHostById(ctx.db, Number(hostParam));
    if (!host) return fail(404, "not_found", "No such host");
  }
  const region = asked ?? host?.region ?? null;

  const bytes = await readBody(request, ctx.config);
  if (bytes instanceof Response) return bytes;
  const contentHash = await sha256(bytes);
  const duplicateOf = (await findUploadByHash(ctx.db, contentHash))?.id ?? null;
  const base = {
    dryRun: true,
    region,
    host: host && { id: host.id, name: host.name, trust: host.trust, region: host.region },
    legacy,
    bytes: bytes.length,
    duplicateOf,
  };

  const parsed = parseFile(bytes, contentHash, legacy, ctx.config);
  if (parsed instanceof Response) {
    const error = (await parsed.json()) as { error: string; message: string };
    return Response.json({ ...base, upload: { status: parsed.status, ...error }, matches: [], warnings: [error.message] });
  }

  // A legacy import is as from a trusted host; so is a dry run with no host.
  const trust = legacy || !host ? "trusted" : host.trust;
  const keys = parsed.map((m) => m.matchKey).filter((key) => key !== "");
  const stored = host ? await findStoredCopies(ctx.db, host.id, keys) : [];
  const plans = planUpload(parsed, stored, trust, ctx.config);
  const storedRegion = new Map(stored.map((copy) => [copy.id, copy.region]));
  const regionOf = (plan: MatchPlan) => (plan.storedId === null ? region : (storedRegion.get(plan.storedId) ?? region));

  const warnings = fileWarnings(parsed, ctx.config.ratingIncompleteGraceHours);
  let upload: { status: number; result?: string; error?: string; message?: string };
  if (host?.trust === "revoked" && !legacy) {
    upload = { status: 403, error: "revoked", message: "This host token has been revoked" };
  } else if (host && !region) {
    upload = { status: legacy ? 400 : 422, error: legacy ? "bad_request" : "no_region", message: "No region: send one, or give the host a home region" };
  } else if (duplicateOf !== null) {
    upload = { status: 200, result: "duplicate" };
  } else {
    upload = { status: 200, result: plans.some((p) => p.action === "insert" || p.action === "replace") ? "stored" : "unchanged" };
  }
  if (upload.message) warnings.unshift(upload.message);
  if (duplicateOf !== null) warnings.unshift(`This exact file is already stored (upload ${duplicateOf}): an upload of it changes nothing`);

  ctx.log.debug("admin: dry-run parse", { admin: ctx.admin.id, bytes: bytes.length, matches: plans.map((p) => `${p.matchKey}:${p.action}:${p.status}`) });
  return Response.json({ ...base, upload, matches: plans.map((plan) => describe(plan, regionOf(plan))), warnings });
}

/** A match of the dry-run parse: what the upload would answer for it, and what the parser read. */
function describe(plan: MatchPlan, region: string | null) {
  const m = plan.match;
  const names = new Map(m.players.map((p) => [p.id, p.name]));
  return {
    ...result(plan, region ?? ""),
    region,
    storedMatchId: plan.storedId,
    format: m.format,
    gameVersion: m.gameVersion,
    startLine: m.startLine,
    unranked: m.unranked,
    settings: m.settings,
    complete: m.endResult !== null,
    startTime: m.startTime,
    endTime: m.endTime,
    endResult: m.endResult,
    players: m.players,
    ratedRounds: m.rounds.filter((r) => isRated(r.finishingOrder)).length,
    rounds: m.rounds.map((r) => ({
      number: r.number,
      result: r.result,
      rated: isRated(r.finishingOrder),
      startTime: r.startTime,
      endTime: r.endTime,
      players: r.playerIds,
      winnerId: r.winnerId,
      left: r.leftIds,
      broken: r.broken,
      placements: isRated(r.finishingOrder) ? r.finishingOrder.map((id, i) => ({ position: i + 1, id, name: names.get(id) ?? null })) : [],
    })),
    kills: m.kills.length,
    deflects: m.deflects.length,
    problems: m.problems,
  };
}

/** What someone reading the dry run should notice, beyond each match's status. */
function fileWarnings(matches: readonly ParsedMatch[], graceHours: number): string[] {
  const warnings: string[] = [];
  const copies = new Map<string, number>();
  for (const m of matches) if (m.matchKey) copies.set(m.matchKey, (copies.get(m.matchKey) ?? 0) + 1);
  for (const [key, n] of copies) if (n > 1) warnings.push(`The file holds ${n} copies of match ${key}: only the longest is used`);
  for (const m of matches) {
    const name = m.matchKey || `at line ${m.startLine}`;
    if (m.problems.length) warnings.push(`Match ${name}: ${m.problems.length} line(s) skipped, see its problems`);
    if (m.endResult === null && !m.rejection) warnings.push(`Match ${name} has no MATCH_END: it's rated ${graceHours} h after it started, if no longer copy comes`);
    const broken = m.rounds.filter((r) => r.broken.length).length;
    if (broken) warnings.push(`Match ${name}: ${broken} broken round(s), not rated`);
  }
  return warnings;
}

/**
 * `POST /api/admin/ratings/recompute?region=eu` (`region` required).
 *
 * - `dryRun=1`: rates the region's matches from scratch in memory (at most `ratingDryRunMaxMatches`)
 *   and answers how the ratings would differ from the stored ones. Writes nothing.
 * - Without: marks the region's ratings stale from the start, logged in `admin_actions`, then runs
 *   one run of the update like the other admin actions; the cron finishes it.
 */
export async function recomputeRegion(ctx: Context, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (!params.has("region")) throw new BadRequest("region is required");
  const region = regionField(params.get("region"), ctx.config, "region");
  if (flag(params, "dryRun")) return Response.json(await recomputeDiff(ctx, region));

  await readState(ctx.db, region); // makes the region's rating_state row if it's never been rated
  const at = isoSeconds(ctx.now);
  await ctx.db.batch([
    staleFromStatement(ctx.db, region, fromStart, at),
    actionStatement(ctx.db, { adminId: ctx.admin.id, action: "ratings_recompute", detail: { region }, at }),
  ]);
  ctx.log.info("admin: ratings recompute", { admin: ctx.admin.id, region });

  try {
    await updateRatings(ctx.db, ctx.config, ctx.now, ctx.log, [region]);
  } catch (error) {
    // The ratings are marked stale: the cron recomputes them.
    ctx.log.error("rating after admin action failed", { region, error: String(error) });
  }
  return Response.json({ region, ratingsStale: (await peekStaleFrom(ctx.db, region)) !== null });
}

/** The dry run: a from-scratch recompute of the region in memory, against what's stored. */
async function recomputeDiff(ctx: Context, region: string) {
  const { db, config } = ctx;
  const [staleFrom, accepted] = await Promise.all([
    peekStaleFrom(db, region),
    readAcceptedFrom(db, region, fromStart, -1), // LIMIT -1: all of them
  ]);
  const counted = accepted.filter((m) => counts(m, config, ctx.now));
  const batch = counted.slice(0, config.ratingDryRunMaxMatches);
  const next = counted[batch.length] ?? null;

  const rounds = new Map<number, number[][]>();
  const chunk = Math.max(1, config.ratingDryRunReadChunk);
  for (let i = 0; i < batch.length; i += chunk) {
    for (const [id, r] of await readRounds(db, batch.slice(i, i + chunk).map((m) => m.id))) rounds.set(id, r);
  }
  const matches: RatingMatch[] = batch.map((m) => ({ id: m.id, playedAt: m.playedAt, rounds: rounds.get(m.id)!, tournament: m.tournament }));
  const after = new Map<number, StoredRating>(
    [...recompute(matches, config).ratings].map(([id, rating]) => [id, { ...rating, display: displayRating(rating, config) }]),
  );
  // Capped: compare with the leaderboard as it stood before the first match left out.
  const before = next ? await readBoardBefore(db, region, next) : await readBoard(db, region);
  const diff = diffRatings(before, after, config.minRankedRounds);

  const listed = diff.players.slice(0, config.ratingDryRunListLimit);
  const names = await playerNames(db, listed.map((p) => p.playerId));
  ctx.log.info("admin: dry-run recompute", { admin: ctx.admin.id, region, matches: batch.length, capped: next !== null, changed: diff.summary.changed });
  return {
    dryRun: true,
    region,
    staleFrom,
    matches: {
      /** Accepted matches that count now (complete, or past `ratingIncompleteGraceHours`). */
      counted: counted.length,
      recomputed: batch.length,
      capped: next !== null,
      /** Capped: the first match left out; the stored side is the leaderboard just before it. */
      until: next && { id: next.id, playedAt: next.playedAt },
    },
    summary: diff.summary,
    truncated: diff.players.length > listed.length,
    players: listed.map((p) => ({ ...p, name: names.get(p.playerId) ?? null })),
  };
}

async function playerNames(db: D1Database, ids: readonly number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const { results } = await db
    .prepare("SELECT id, name FROM players WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ id: number; name: string }>();
  return new Map(results.map((p) => [p.id, p.name]));
}
