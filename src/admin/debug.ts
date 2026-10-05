import { fail } from "../http";
import type { ParsedMatch } from "../parser/types";
import { fromStart, staleFromStatement } from "../rating/store";
import { isoSeconds } from "../time";
import { hostRegion, parseFile, rateLimit, readBody, result, sha256 } from "../upload/handler";
import { isRated, planUpload, type MatchPlan } from "../upload/plan";
import { findStoredCopies, findUploadByHash, type Host } from "../upload/store";
import { BadRequest, regionField, type Context } from "./request";
import { actionStatement, findHostById } from "./store";

/**
 * Debug tools for admins (#33, docs/api.md "Debug tools"): what the server makes of a log file,
 * writing nothing, and a recompute of one region's ratings. The dry-run recompute runs outside the
 * Worker: `npm run ratings:dry-run` (`src/rating/dryRun.ts`).
 */

/** `?name=1` / `true` on, `0` / `false` / left out off. */
function flag(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  if (value === null || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new BadRequest(`${name} must be 1 or 0`);
}

/** What the real endpoint would answer: its status, and its body's fields. */
type Simulated = { status: number } & Record<string, unknown>;

async function simulated(response: Response): Promise<Simulated> {
  return { status: response.status, ...((await response.json()) as Record<string, unknown>) };
}

/**
 * `POST /api/admin/parse?region=&host=&legacy=1`: the body is a log file, as with an upload (same
 * size limit). Writes nothing. Answers two things, kept apart:
 *
 * - `upload`: what `POST /api/upload` (or, with `legacy=1`, `legacy-import`) would answer for this
 *   file, checking in the same order as they do. With `host`, as that host (its revocation, region,
 *   rate limit, trust and stored copies); without, the host checks are skipped and it's judged as
 *   from a trusted host with nothing stored. `region` stands for the upload's `X-Region` (or the
 *   import's `region`).
 * - `parser`: what the parser read, even when the upload would stop before parsing (a file stored
 *   already, a revoked host): the parse error, or each match with its plan, and warnings.
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

  const bytes = await readBody(request, ctx.config);
  if (bytes instanceof Response) return bytes;
  const contentHash = await sha256(bytes);
  const duplicateOf = (await findUploadByHash(ctx.db, contentHash))?.id ?? null;

  // What the parser makes of it, whatever the upload would do.
  const parsed = parseFile(bytes, contentHash, legacy, ctx.config);
  const parseError = parsed instanceof Response ? await simulated(parsed) : null;
  const matches = parsed instanceof Response ? [] : parsed;
  // A legacy import is as from a trusted host; so is a dry run with no host.
  const trust = legacy || !host ? "trusted" : host.trust;
  const stored = host ? await findStoredCopies(ctx.db, host.id, matches.map((m) => m.matchKey).filter((key) => key !== "")) : [];
  const plans = planUpload(matches, stored, trust, ctx.config);

  // The region the upload would store new matches in, or the answer it stops at before that.
  let region: string | null = asked;
  let stop: Simulated | null = null;
  if (legacy) {
    if (!host) stop = { status: 400, error: "bad_request", message: "host=<host id> is required" };
    else if (!(region ??= host.region)) stop = { status: 400, error: "bad_request", message: "The host has no home region: add region=<region>" };
  } else if (host) {
    if (host.trust === "revoked") stop = { status: 403, error: "revoked", message: "This host token has been revoked" };
    else {
      const headers: Record<string, string> = asked ? { "X-Region": asked } : {};
      const found = hostRegion(new Request(request.url, { headers }), host, ctx.config, "the matches were hosted in");
      if (found instanceof Response) stop = await simulated(found);
      else {
        region = found.id;
        const limited = await rateLimit(ctx.db, host.id, ctx.now, ctx.config);
        if (limited) stop = await simulated(limited);
      }
    }
  }

  const storedRegion = new Map(stored.map((copy) => [copy.id, copy.region]));
  const regionOf = (plan: MatchPlan) => (plan.storedId === null ? region : (storedRegion.get(plan.storedId) ?? region));
  let upload: Simulated;
  if (stop) upload = stop;
  else if (duplicateOf !== null) upload = { status: 200, result: "duplicate", uploadId: duplicateOf, region, matches: [] };
  else if (parseError) upload = parseError;
  else {
    const writes = plans.some((p) => p.action === "insert" || p.action === "replace");
    upload = {
      status: 200,
      result: writes ? "stored" : "unchanged",
      uploadId: null,
      region,
      matches: plans.map((plan) => result(plan, regionOf(plan) ?? "")),
    };
  }

  ctx.log.debug("admin: dry-run parse", { admin: ctx.admin.id, bytes: bytes.length, upload: upload.status, matches: plans.length });
  return Response.json({
    dryRun: true,
    region,
    host: host && { id: host.id, name: host.name, trust: host.trust, region: host.region },
    legacy,
    bytes: bytes.length,
    duplicateOf,
    upload,
    parser: {
      error: parseError,
      matches: plans.map((plan) => describe(plan, regionOf(plan))),
      warnings: fileWarnings(matches, ctx.config.ratingIncompleteGraceHours),
    },
  });
}

/** A match of the dry-run parse: the plan an upload would make for it, and what the parser read. */
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
 * `POST /api/admin/ratings/recompute?region=eu` (`region` required): marks the region's ratings
 * stale from its first match, logged in `admin_actions`, in one batch. It doesn't rate anything
 * itself: the cron recomputes `ratingMatchesPerRun` matches a run, so a request never risks the
 * free plan's CPU time. The dry run is `npm run ratings:dry-run`, outside the Worker.
 */
export async function recomputeRegion(ctx: Context, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (params.has("dryRun")) throw new BadRequest("The dry run is a script now: npm run ratings:dry-run -- --region <region> (docs/api.md)");
  if (!params.has("region")) throw new BadRequest("region is required");
  const region = regionField(params.get("region"), ctx.config, "region");

  const at = isoSeconds(ctx.now);
  await ctx.db.batch([
    // A region never rated has no rating_state row yet.
    ctx.db.prepare("INSERT OR IGNORE INTO rating_state (board) VALUES (?)").bind(region),
    staleFromStatement(ctx.db, region, fromStart, at),
    actionStatement(ctx.db, { adminId: ctx.admin.id, action: "ratings_recompute", detail: { region }, at }),
  ]);
  ctx.log.info("admin: ratings recompute", { admin: ctx.admin.id, region });
  return Response.json({ region, ratingsStale: true });
}
