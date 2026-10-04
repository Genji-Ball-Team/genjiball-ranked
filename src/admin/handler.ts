import type { Config } from "../config";
import { fail } from "../http";
import type { Logger } from "../log";
import { readState, staleFromMatchesStatement } from "../rating/store";
import { updateRatings, type UpdateConfig } from "../rating/update";
import { isoSeconds } from "../time";
import { readBody, sha256, storeLog, type UploadConfig } from "../upload/handler";
import type { HostTrust, MatchStatus } from "../upload/plan";
import { matchActions, matchTransition, newToken, trustChange, type MatchAction } from "./plan";
import {
  actionStatement,
  createHost,
  findAdmin,
  findHostById,
  findMatch,
  isStale,
  listActions,
  listHosts,
  listMatches,
  setHostTrust,
  setMatchState,
  setTournament,
  type Admin,
} from "./store";

/**
 * `/api/admin/*`: hosts, the review queue, voiding matches, the action log (#7, docs/api.md) and the
 * legacy log import (#13).
 * Every request needs `Authorization: Bearer <admin token>`; every change is logged in
 * `admin_actions` in the same transaction.
 */

type AdminConfig = UpdateConfig & UploadConfig & Pick<Config, "hostTokenBytes" | "adminListLimit" | "adminTextMaxLength">;

interface Context {
  db: D1Database;
  config: AdminConfig;
  log: Logger;
  admin: Admin;
  now: Date;
}

const statuses: readonly MatchStatus[] = ["accepted", "review", "rejected", "void"];
const settableTrust: readonly HostTrust[] = ["trusted", "untrusted"];

export async function handleAdmin(request: Request, db: D1Database, config: AdminConfig, log: Logger): Promise<Response> {
  const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim();
  if (!token) return fail(401, "unauthorized", "Send your admin token as Authorization: Bearer <token>");
  const admin = await findAdmin(db, await sha256(token));
  if (!admin) return fail(401, "unauthorized", "Unknown or revoked admin token");

  const ctx: Context = { db, config, log, admin, now: new Date() };
  const path = new URL(request.url).pathname.replace(/^\/api\/admin\/?/, "").replace(/\/$/, "").split("/");
  const method = request.method;
  const id = path[1] !== undefined && /^[1-9]\d{0,15}$/.test(path[1]) ? Number(path[1]) : null;

  try {
    if (path.length === 1 && path[0] === "me") {
      return method === "GET" ? Response.json({ admin }) : notAllowed("GET");
    }
    if (path[0] === "hosts") {
      if (path.length === 1) {
        if (method === "GET") return Response.json({ hosts: await listHosts(db, config.adminListLimit) });
        if (method === "POST") return await addHost(ctx, await body(request));
        return notAllowed("GET, POST");
      }
      if (id !== null && path.length === 3 && (path[2] === "trust" || path[2] === "revoke")) {
        if (method !== "POST") return notAllowed("POST");
        const data = await body(request);
        return await changeTrust(ctx, id, path[2] === "revoke" ? "revoked" : data.trust);
      }
    }
    if (path[0] === "matches") {
      if (path.length === 1) {
        if (method !== "GET") return notAllowed("GET");
        const status = new URL(request.url).searchParams.get("status") ?? "review";
        if (!(statuses as string[]).includes(status)) return fail(400, "bad_request", `status must be one of ${statuses.join(", ")}`);
        return Response.json({ matches: await listMatches(db, status as MatchStatus, config.adminListLimit) });
      }
      if (id !== null && path.length === 2) {
        if (method !== "GET") return notAllowed("GET");
        const match = await findMatch(db, id);
        return match ? Response.json({ match }) : fail(404, "not_found", "No such match");
      }
      if (id !== null && path.length === 3 && path[2] === "tournament") {
        if (method !== "POST") return notAllowed("POST");
        return await changeTournament(ctx, id, await body(request));
      }
      if (id !== null && path.length === 3 && (matchActions as string[]).includes(path[2]!)) {
        if (method !== "POST") return notAllowed("POST");
        return await changeMatch(ctx, id, path[2] as MatchAction, await body(request));
      }
    }
    if (path.length === 1 && path[0] === "legacy-import") {
      return method === "POST" ? await importLegacy(ctx, request) : notAllowed("POST");
    }
    if (path.length === 1 && path[0] === "actions") {
      return method === "GET" ? Response.json({ actions: await listActions(db, config.adminListLimit) }) : notAllowed("GET");
    }
  } catch (error) {
    if (error instanceof BadRequest) return fail(400, "bad_request", error.message);
    throw error;
  }
  return fail(404, "not_found", "No such admin route");
}

/** `POST /api/admin/hosts`: a new host token, shown once. Only its SHA-256 is stored. */
async function addHost(ctx: Context, data: Record<string, unknown>): Promise<Response> {
  const name = text(data.name, ctx.config, "name");
  if (!name) throw new BadRequest("name is required");
  const trust = data.trust ?? "untrusted";
  if (!(settableTrust as unknown[]).includes(trust)) throw new BadRequest(`trust must be one of ${settableTrust.join(", ")}`);

  const token = newToken(ctx.config.hostTokenBytes);
  const at = isoSeconds(ctx.now);
  const host = await createHost(ctx.db, name, trust as HostTrust, await sha256(token), {
    adminId: ctx.admin.id,
    action: "host_create",
    detail: { name, trust },
    at,
  });
  ctx.log.info("admin: host created", { admin: ctx.admin.id, host: host.id, trust });
  return Response.json({ host, token }, { status: 201 });
}

/** `POST /api/admin/hosts/:id/trust` and `/revoke`. */
async function changeTrust(ctx: Context, hostId: number, to: unknown): Promise<Response> {
  if (to !== "revoked" && !(settableTrust as unknown[]).includes(to)) {
    throw new BadRequest(`trust must be one of ${settableTrust.join(", ")}`);
  }
  const host = await findHostById(ctx.db, hostId);
  if (!host) return fail(404, "not_found", "No such host");
  const refused = trustChange(host.trust, to as HostTrust);
  if (refused) return fail(409, "conflict", refused);

  try {
    await setHostTrust(ctx.db, hostId, host.trust, to as HostTrust, {
      adminId: ctx.admin.id,
      action: to === "revoked" ? "host_revoke" : "host_trust",
      hostId,
      detail: { from: host.trust, to },
      at: isoSeconds(ctx.now),
    });
  } catch (error) {
    if (isStale(error)) return changedMeanwhile();
    throw error;
  }
  ctx.log.info("admin: host trust", { admin: ctx.admin.id, host: hostId, from: host.trust, to });
  return Response.json({ host: { ...host, trust: to } });
}

/**
 * `POST /api/admin/matches/:id/<accept|reject|void|unvoid>`. A void marks the ratings stale from the
 * match in the same transaction. Then the ratings are brought up to date as far as one run goes
 * (`updateRatings`, like the cron): a match that now counts is rated if it's the newest, and a short
 * stale tail is recomputed straight away. The cron finishes a longer one.
 */
async function changeMatch(ctx: Context, matchId: number, action: MatchAction, data: Record<string, unknown>): Promise<Response> {
  const reason = text(data.reason, ctx.config, "reason");
  const match = await findMatch(ctx.db, matchId);
  if (!match) return fail(404, "not_found", "No such match");
  const transition = matchTransition(action, match, reason);
  if (!transition.ok) return fail(409, "conflict", transition.message);

  const at = isoSeconds(ctx.now);
  // A rated match that stops counting: the ratings are stale from it.
  const extra = transition.to.status === "void" ? [staleFromMatchesStatement(ctx.db, [matchId], at, true)] : [];
  try {
    await setMatchState(
      ctx.db,
      matchId,
      match.status,
      transition.to,
      {
        adminId: ctx.admin.id,
        action: `match_${action}`,
        matchId,
        hostId: match.hostId,
        detail: { from: match.status, to: transition.to.status, ...(reason ? { reason } : {}) },
        at,
      },
      extra,
    );
  } catch (error) {
    if (isStale(error)) return changedMeanwhile();
    throw error;
  }
  ctx.log.info("admin: match", { admin: ctx.admin.id, match: matchId, action, from: match.status, to: transition.to.status });

  let ratingsStale = true;
  try {
    if (match.status === "accepted" || transition.to.status === "accepted") await updateRatings(ctx.db, ctx.config, ctx.now, ctx.log);
    ratingsStale = (await readState(ctx.db)).staleFrom !== null;
  } catch (error) {
    // The change is stored; the cron rates or recomputes.
    ctx.log.error("rating after admin action failed", { match: matchId, error: String(error) });
  }
  return Response.json({ match: { ...match, ...transition.to }, ratingsStale });
}

/**
 * `POST /api/admin/matches/:id/tournament` with `{"tournament": true}` (or `false`): marks a match as a
 * tournament. It counts `tournamentWeight` times as much and nobody gains or loses more than
 * `tournamentMaxChange` in it. A rated match makes the ratings stale from it, like a void.
 */
async function changeTournament(ctx: Context, matchId: number, data: Record<string, unknown>): Promise<Response> {
  if (typeof data.tournament !== "boolean") throw new BadRequest("tournament must be true or false");
  const match = await findMatch(ctx.db, matchId);
  if (!match) return fail(404, "not_found", "No such match");
  if (match.tournament === data.tournament) {
    return fail(409, "conflict", `The match is ${match.tournament ? "already" : "not"} a tournament`);
  }

  const at = isoSeconds(ctx.now);
  try {
    await setTournament(
      ctx.db,
      matchId,
      data.tournament,
      { adminId: ctx.admin.id, action: "match_tournament", matchId, hostId: match.hostId, detail: { tournament: data.tournament }, at },
      [staleFromMatchesStatement(ctx.db, [matchId], at, true)],
    );
  } catch (error) {
    if (isStale(error)) return changedMeanwhile();
    throw error;
  }
  ctx.log.info("admin: tournament", { admin: ctx.admin.id, match: matchId, tournament: data.tournament });

  let ratingsStale = true;
  try {
    if (match.status === "accepted") await updateRatings(ctx.db, ctx.config, ctx.now, ctx.log);
    ratingsStale = (await readState(ctx.db)).staleFrom !== null;
  } catch (error) {
    ctx.log.error("rating after admin action failed", { match: matchId, error: String(error) });
  }
  return Response.json({ match: { ...match, tournament: data.tournament }, ratingsStale });
}

/**
 * `POST /api/admin/legacy-import?host=<id>`: stores a v1.3.2 log file (body, as with an upload) as
 * the host's legacy match (#13, docs/legacy.md). The admin vouches for the file, so it's stored as
 * from a trusted host, with no upload rate limit. Answers like `POST /api/upload`.
 */
async function importLegacy(ctx: Context, request: Request): Promise<Response> {
  const hostParam = new URL(request.url).searchParams.get("host") ?? "";
  const hostId = /^[1-9]\d{0,15}$/.test(hostParam) ? Number(hostParam) : null;
  if (hostId === null) throw new BadRequest("host=<host id> is required");
  const host = await findHostById(ctx.db, hostId);
  if (!host) return fail(404, "not_found", "No such host");

  const bytes = await readBody(request, ctx.config);
  if (bytes instanceof Response) return bytes;
  const fileName = request.headers.get("X-Log-File")?.trim().slice(0, 255) || null;
  return storeLog(ctx.db, ctx.config, ctx.log, {
    host: { id: host.id, name: host.name, trust: "trusted" },
    bytes,
    request,
    now: ctx.now,
    legacy: true,
    extra: (db) => [
      actionStatement(db, { adminId: ctx.admin.id, action: "legacy_import", hostId, detail: { file: fileName }, at: isoSeconds(ctx.now) }),
    ],
  });
}

class BadRequest extends Error {}

/** The JSON object body, or `{}` when there's none. */
async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new BadRequest("The body must be JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new BadRequest("The body must be a JSON object");
  return data as Record<string, unknown>;
}

/** An optional text field, trimmed. `null` when it's missing or blank. */
function text(value: unknown, config: AdminConfig, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BadRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > config.adminTextMaxLength) throw new BadRequest(`${field} is longer than ${config.adminTextMaxLength} characters`);
  return trimmed || null;
}

function notAllowed(allow: string): Response {
  return fail(405, "method_not_allowed", `Use ${allow}`, { Allow: allow });
}

function changedMeanwhile(): Response {
  return fail(409, "conflict", "Another admin changed it at the same time. Reload and try again");
}
