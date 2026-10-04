import { fail } from "../http";
import { readState, staleFromMatchesStatement } from "../rating/store";
import { updateRatings } from "../rating/update";
import { isoSeconds } from "../time";
import { expireOverCaps } from "../tourney/expiry";
import { imageType, screenshotKey } from "../tourney/screenshot";
import {
  createLobby,
  createTourney,
  deleteLobby,
  findLobby,
  findTourney,
  isLinkedElsewhere,
  listAllTourneys,
  listLobbies,
  setScreenshot,
  setVerified,
  tournamentStatement,
  tourneyStatuses,
  updateLobby,
  updateTourney,
  type LobbyRow,
  type TourneyFields,
  type TourneyStatus,
} from "../tourney/store";
import { readLimited } from "../upload/handler";
import { BadRequest, body, notAllowed, text, type Context } from "./request";
import { findMatch, type ActionLog } from "./store";

/**
 * `/api/admin/tourneys` and `/api/admin/lobbies/:id` (#24, #28, docs/api.md "Admin"): schedule
 * tourneys, add their lobbies, link each lobby's match, upload and verify its screenshot.
 *
 * A lobby's match is a tournament (`matches.tournament`): it stays on the one leaderboard, counts
 * `tournamentWeight` times as much, and nobody moves more than `tournamentMaxChange` in it. Linking
 * or unlinking a rated match makes the ratings stale from it, like the tournament flag does.
 */

/** Answers a tourney route, or returns null when the path isn't one. */
export async function handleTourneyAdmin(ctx: Context, request: Request, path: string[]): Promise<Response | null> {
  const method = request.method;
  const id = path[1] !== undefined && /^[1-9]\d{0,15}$/.test(path[1]) ? Number(path[1]) : null;
  if (path[0] === "tourneys") {
    if (path.length === 1) {
      if (method === "GET") return listTourneys(ctx);
      if (method === "POST") return addTourney(ctx, await body(request));
      return notAllowed("GET, POST");
    }
    if (id !== null && path.length === 2) return method === "POST" ? editTourney(ctx, id, await body(request)) : notAllowed("POST");
    if (id !== null && path.length === 3 && path[2] === "lobbies") {
      return method === "POST" ? addLobby(ctx, id, await body(request)) : notAllowed("POST");
    }
  }
  if (path[0] === "lobbies" && id !== null) {
    if (path.length === 2) {
      if (method === "POST") return editLobby(ctx, id, await body(request));
      if (method === "DELETE") return removeLobby(ctx, id);
      return notAllowed("POST, DELETE");
    }
    if (path.length === 3 && path[2] === "screenshot") {
      if (method === "PUT") return putScreenshot(ctx, id, request);
      if (method === "DELETE") return removeScreenshot(ctx, id);
      return notAllowed("PUT, DELETE");
    }
    if (path.length === 3 && path[2] === "verify") return method === "POST" ? verify(ctx, id, await body(request)) : notAllowed("POST");
  }
  return null;
}

/** `GET /api/admin/tourneys`: every tourney, latest start first, with its lobbies. */
async function listTourneys(ctx: Context): Promise<Response> {
  const tourneys = await listAllTourneys(ctx.db, ctx.config.adminListLimit);
  const lobbies = await listLobbies(
    ctx.db,
    tourneys.map((t) => t.id),
  );
  return Response.json({ tourneys: tourneys.map((t) => ({ ...t, lobbies: lobbies.filter((l) => l.tourneyId === t.id) })) });
}

/** `POST /api/admin/tourneys` with `{ name, startsAt, notes?, status? }`. */
async function addTourney(ctx: Context, data: Record<string, unknown>): Promise<Response> {
  const fields = tourneyFields(ctx, data, null);
  const tourney = await createTourney(ctx.db, fields, log(ctx, "tourney_create", { name: fields.name, startsAt: fields.startsAt }));
  ctx.log.info("admin: tourney created", { admin: ctx.admin.id, tourney: tourney.id });
  return Response.json({ tourney: { ...tourney, lobbies: [] } }, { status: 201 });
}

/** `POST /api/admin/tourneys/:id`: changes the fields that are sent. */
async function editTourney(ctx: Context, id: number, data: Record<string, unknown>): Promise<Response> {
  const tourney = await findTourney(ctx.db, id);
  if (!tourney) return fail(404, "not_found", "No such tourney");
  const fields = tourneyFields(ctx, data, tourney);
  await updateTourney(ctx.db, id, fields, log(ctx, "tourney_edit", { tourney: id, ...changes(tourney, fields) }));
  ctx.log.info("admin: tourney edited", { admin: ctx.admin.id, tourney: id });
  return Response.json({ tourney: { ...tourney, ...fields, lobbies: await listLobbies(ctx.db, [id]) } });
}

/** `POST /api/admin/tourneys/:id/lobbies` with `{ label }`. Link its match with `POST /api/admin/lobbies/:id`. */
async function addLobby(ctx: Context, tourneyId: number, data: Record<string, unknown>): Promise<Response> {
  const label = text(data.label, ctx.config, "label");
  if (!label) throw new BadRequest("label is required");
  if (!(await findTourney(ctx.db, tourneyId))) return fail(404, "not_found", "No such tourney");
  const id = await createLobby(ctx.db, tourneyId, label, log(ctx, "lobby_create", { tourney: tourneyId, label }));
  ctx.log.info("admin: lobby created", { admin: ctx.admin.id, tourney: tourneyId, lobby: id });
  return Response.json({ lobby: await findLobby(ctx.db, id) }, { status: 201 });
}

/**
 * `POST /api/admin/lobbies/:id` with `{ label?, matchId? }`: renames the lobby, or links its match
 * (`matchId` a match id, `null` to unlink). A new match clears the verification.
 */
async function editLobby(ctx: Context, id: number, data: Record<string, unknown>): Promise<Response> {
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  const label = data.label === undefined ? lobby.label : text(data.label, ctx.config, "label");
  if (!label) throw new BadRequest("label can't be blank");
  let matchId = lobby.matchId;
  if (data.matchId !== undefined) {
    if (data.matchId !== null && !(typeof data.matchId === "number" && Number.isSafeInteger(data.matchId) && data.matchId > 0)) {
      throw new BadRequest("matchId must be a match id or null");
    }
    matchId = data.matchId;
  }

  const at = isoSeconds(ctx.now);
  const relink = await relinkStatements(ctx, lobby.matchId, matchId, at);
  if (relink instanceof Response) return relink;
  try {
    await updateLobby(
      ctx.db,
      id,
      label,
      matchId,
      { ...log(ctx, "lobby_edit", { lobby: id, tourney: lobby.tourneyId, label, matchId }), matchId },
      relink.statements,
    );
  } catch (error) {
    if (isLinkedElsewhere(error)) return fail(409, "conflict", `Match ${matchId} is already another lobby's`);
    throw error;
  }
  ctx.log.info("admin: lobby edited", { admin: ctx.admin.id, lobby: id, match: matchId });
  return Response.json({ lobby: await findLobby(ctx.db, id), ratingsStale: await rerate(ctx, relink.rated, id) });
}

/** `DELETE /api/admin/lobbies/:id`: its match is no longer a tournament, and its screenshot is deleted. */
async function removeLobby(ctx: Context, id: number): Promise<Response> {
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  const relink = await relinkStatements(ctx, lobby.matchId, null, isoSeconds(ctx.now));
  if (relink instanceof Response) return relink;
  await deleteLobby(
    ctx.db,
    id,
    { ...log(ctx, "lobby_delete", { lobby: id, tourney: lobby.tourneyId, label: lobby.label }), matchId: lobby.matchId },
    relink.statements,
  );
  if (lobby.screenshotKey) await ctx.proofs.delete(lobby.screenshotKey);
  ctx.log.info("admin: lobby deleted", { admin: ctx.admin.id, lobby: id });
  return Response.json({ ratingsStale: await rerate(ctx, relink.rated, id) });
}

/**
 * `PUT /api/admin/lobbies/:id/screenshot`: the body is the image (PNG, JPEG or WebP, at most
 * `screenshotMaxBytes`). Replaces the old one, which is deleted from R2, and needs verifying again.
 */
async function putScreenshot(ctx: Context, id: number, request: Request): Promise<Response> {
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  const max = ctx.config.screenshotMaxBytes;
  const tooLarge = () => fail(413, "too_large", `The image is larger than ${max} bytes`);
  if (Number(request.headers.get("Content-Length") ?? 0) > max) return tooLarge();
  const bytes = await readLimited(request, max);
  if (!bytes) return tooLarge();
  if (!bytes.length) return fail(400, "empty", "The body is empty: send the image");
  const type = imageType(bytes);
  if (!type) return fail(415, "unsupported_type", "Send a PNG, JPEG or WebP image");

  const key = screenshotKey(id, type);
  await ctx.proofs.put(key, bytes, { httpMetadata: { contentType: type } });
  try {
    await setScreenshot(ctx.db, id, key, bytes.length, log(ctx, "lobby_screenshot", { lobby: id, tourney: lobby.tourneyId, bytes: bytes.length, type }));
  } catch (error) {
    await ctx.proofs.delete(key);
    throw error;
  }
  if (lobby.screenshotKey) await ctx.proofs.delete(lobby.screenshotKey);
  ctx.log.info("admin: screenshot", { admin: ctx.admin.id, lobby: id, bytes: bytes.length, type });
  let expired: string[] = [];
  try {
    expired = await expireOverCaps(ctx.db, ctx.proofs, ctx.config, ctx.now, ctx.log);
  } catch (error) {
    // The upload is stored; the next upload tries again.
    ctx.log.error("screenshot expiry failed", { lobby: id, error: String(error) });
  }
  return Response.json({ lobby: await findLobby(ctx.db, id), expired: expired.length });
}

/** `DELETE /api/admin/lobbies/:id/screenshot`. */
async function removeScreenshot(ctx: Context, id: number): Promise<Response> {
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  if (!lobby.screenshotKey) return fail(409, "conflict", "The lobby has no screenshot");
  await setScreenshot(ctx.db, id, null, null, log(ctx, "lobby_screenshot_delete", { lobby: id, tourney: lobby.tourneyId }));
  await ctx.proofs.delete(lobby.screenshotKey);
  ctx.log.info("admin: screenshot deleted", { admin: ctx.admin.id, lobby: id });
  return Response.json({ lobby: await findLobby(ctx.db, id) });
}

/**
 * `POST /api/admin/lobbies/:id/verify` with `{ "verified": true }` (or `false`): an admin checked the
 * screenshot against the standings and the match. Needs a match and a screenshot.
 */
async function verify(ctx: Context, id: number, data: Record<string, unknown>): Promise<Response> {
  if (typeof data.verified !== "boolean") throw new BadRequest("verified must be true or false");
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  if (data.verified && (!lobby.matchId || !lobby.screenshotKey)) {
    return fail(409, "conflict", "Link the lobby's match and upload its screenshot before verifying it");
  }
  if ((lobby.verifiedAt !== null) === data.verified) return fail(409, "conflict", `The lobby is ${data.verified ? "already" : "not"} verified`);
  await setVerified(ctx.db, id, data.verified, {
    ...log(ctx, "lobby_verify", { lobby: id, tourney: lobby.tourneyId, verified: data.verified }),
    matchId: lobby.matchId,
  });
  ctx.log.info("admin: lobby verified", { admin: ctx.admin.id, lobby: id, verified: data.verified });
  return Response.json({ lobby: await findLobby(ctx.db, id) });
}

// Helpers

function log(ctx: Context, action: string, detail: Record<string, unknown>): ActionLog {
  return { adminId: ctx.admin.id, action, detail, at: isoSeconds(ctx.now) };
}

/** The fields of a new tourney (`from` null) or an edited one: what's sent, else what it was. */
function tourneyFields(ctx: Context, data: Record<string, unknown>, from: TourneyFields | null): TourneyFields {
  const name = data.name === undefined && from ? from.name : text(data.name, ctx.config, "name");
  if (!name) throw new BadRequest("name is required");
  let startsAt = from?.startsAt;
  if (data.startsAt !== undefined || !from) {
    // A time zone is required: `2026-10-10T19:00` alone would be read in the server's zone.
    const ms = typeof data.startsAt === "string" && /(Z|[+-]\d\d:\d\d)$/.test(data.startsAt) ? Date.parse(data.startsAt) : NaN;
    if (Number.isNaN(ms)) throw new BadRequest("startsAt must be an ISO 8601 time with a time zone, like 2026-10-10T19:00:00Z");
    startsAt = isoSeconds(new Date(ms));
  }
  const status = data.status === undefined ? (from?.status ?? "scheduled") : data.status;
  if (!(tourneyStatuses as unknown[]).includes(status)) throw new BadRequest(`status must be one of ${tourneyStatuses.join(", ")}`);
  const notes = data.notes === undefined && from ? from.notes : text(data.notes, ctx.config, "notes", ctx.config.tourneyNotesMaxLength);
  return { name, startsAt: startsAt!, status: status as TourneyStatus, notes };
}

/** What an edit changed, for the action log. */
function changes(from: TourneyFields, to: TourneyFields): Record<string, unknown> {
  const keys = (["name", "startsAt", "status", "notes"] as const).filter((k) => from[k] !== to[k]);
  return Object.fromEntries(keys.map((k) => [k, { from: from[k], to: to[k] }]));
}

/**
 * Moving a lobby from match `from` to match `to`: `from` is no longer a tournament and `to` is one,
 * and the ratings are stale from whichever of them was rated. `rated`: whether an accepted match
 * changed, so the ratings need bringing up to date.
 */
async function relinkStatements(
  ctx: Context,
  from: number | null,
  to: number | null,
  at: string,
): Promise<Response | { statements: D1PreparedStatement[]; rated: boolean }> {
  if (from === to) return { statements: [], rated: false };
  const statements: D1PreparedStatement[] = [];
  let rated = false;
  const changed: number[] = [];
  if (to !== null) {
    const match = await findMatch(ctx.db, to);
    if (!match) return fail(404, "not_found", "No such match");
    if (!match.tournament) changed.push(to);
    rated ||= match.status === "accepted" && !match.tournament;
    statements.push(tournamentStatement(ctx.db, [to], true));
  }
  if (from !== null) {
    const match = await findMatch(ctx.db, from);
    if (match?.tournament) changed.push(from);
    rated ||= match?.status === "accepted" && match.tournament;
    statements.push(tournamentStatement(ctx.db, [from], false));
  }
  if (changed.length) statements.push(staleFromMatchesStatement(ctx.db, changed, at, true));
  return { statements, rated };
}

/** Brings the ratings up to date as far as one run goes, like a void. Returns whether they're still stale. */
async function rerate(ctx: Context, rated: boolean, lobby: LobbyRow["id"]): Promise<boolean> {
  try {
    if (rated) await updateRatings(ctx.db, ctx.config, ctx.now, ctx.log);
    return (await readState(ctx.db)).staleFrom !== null;
  } catch (error) {
    // The change is stored; the cron rates or recomputes.
    ctx.log.error("rating after admin action failed", { lobby, error: String(error) });
    return true;
  }
}
