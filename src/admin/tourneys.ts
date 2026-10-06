import { fail } from "../http";
import { anyStale, staleFromMatchesStatement } from "../rating/store";
import { updateRatings } from "../rating/update";
import { isoSeconds } from "../time";
import { capacityOf, newLobbyKey, roundLimitOf } from "../tourney/code";
import { countSignups, findSignup, isSignupChanged, listSignups, setSignupRemoved } from "../tourney/signupStore";
import { signupSummary } from "../tourney/signups";
import { flushScreenshotDeletions } from "../tourney/expiry";
import {
  createLobby,
  createTourney,
  deleteLobby,
  findLobby,
  findTourney,
  isLinkedElsewhere,
  isLobbyChanged,
  isLobbyKeyTaken,
  listAllTourneys,
  listLobbies,
  setVerified,
  tournamentStatement,
  tourneyStatuses,
  updateLobby,
  updateTourney,
  type LobbyFields,
  type LobbyRow,
  type TourneyFields,
  type TourneyStatus,
} from "../tourney/store";
import { deleteScreenshot, storeScreenshot } from "../tourney/upload";
import { BadRequest, body, changedMeanwhile, notAllowed, regionField, text, type Context } from "./request";
import { findHostById, findMatch, type ActionLog } from "./store";

/**
 * `/api/admin/tourneys` and `/api/admin/lobbies/:id` (#24, #28, docs/api.md "Admin"): schedule
 * tourneys, add their lobbies, link each lobby's match, upload and verify its screenshot.
 *
 * A tourney belongs to one region (#47), and so do its lobbies' matches.
 *
 * A lobby's match is a tournament (`matches.tournament`): it stays on its region's leaderboard, counts
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
    if (id !== null && path.length === 3 && path[2] === "signups") return method === "GET" ? signups(ctx, id) : notAllowed("GET");
    if (id !== null && path.length === 3 && path[2] === "lobbies") {
      return method === "POST" ? addLobby(ctx, id, await body(request)) : notAllowed("POST");
    }
  }
  if (path[0] === "signups" && id !== null && path.length === 2) return method === "POST" ? removeSignup(ctx, id, await body(request)) : notAllowed("POST");
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

/**
 * `GET /api/admin/tourneys`: every tourney, latest start first, with its lobbies, its capacity (the
 * sum of its lobbies') and its sign-ups, as the Tourneys page counts them.
 */
async function listTourneys(ctx: Context): Promise<Response> {
  const tourneys = await listAllTourneys(ctx.db, ctx.config.adminListLimit);
  const ids = tourneys.map((t) => t.id);
  const [lobbies, counts] = await Promise.all([listLobbies(ctx.db, ids), countSignups(ctx.db, ids)]);
  return Response.json({
    tourneys: tourneys.map((t) => {
      const own = lobbies.filter((l) => l.tourneyId === t.id).map((l) => lobbyView(ctx, l));
      const capacity = own.reduce((sum, l) => sum + l.capacity, 0);
      return { ...t, capacity, signups: signupSummary(t.status, counts.get(t.id) ?? 0, capacity), lobbies: own };
    }),
  });
}

/** `GET /api/admin/tourneys/:id/signups`: every sign-up, removed ones too, first come first. */
async function signups(ctx: Context, tourneyId: number): Promise<Response> {
  if (!(await findTourney(ctx.db, tourneyId))) return fail(404, "not_found", "No such tourney");
  return Response.json({ signups: await listSignups(ctx.db, tourneyId) });
}

/**
 * `POST /api/admin/signups/:id` with `{ "removed": true }` (or `false`): removes a sign-up (a joke
 * name, a double), or restores it. The row stays, marked removed by the admin: the name can't sign up
 * again, and it no longer counts.
 */
async function removeSignup(ctx: Context, id: number, data: Record<string, unknown>): Promise<Response> {
  if (typeof data.removed !== "boolean") throw new BadRequest("removed must be true or false");
  const signup = await findSignup(ctx.db, id);
  if (!signup) return fail(404, "not_found", "No such sign-up");
  if ((signup.removedAt !== null) === data.removed) return fail(409, "conflict", `The sign-up is ${data.removed ? "already" : "not"} removed`);
  try {
    await setSignupRemoved(
      ctx.db,
      id,
      data.removed,
      log(ctx, data.removed ? "signup_remove" : "signup_restore", { tourney: signup.tourneyId, signup: id, name: signup.name }),
    );
  } catch (error) {
    if (isSignupChanged(error)) return changedMeanwhile();
    throw error;
  }
  ctx.log.info("admin: sign-up", { admin: ctx.admin.id, signup: id, removed: data.removed });
  return Response.json({ signup: await findSignup(ctx.db, id) });
}

/** `POST /api/admin/tourneys` with `{ name, region, startsAt, notes?, status? }`. */
async function addTourney(ctx: Context, data: Record<string, unknown>): Promise<Response> {
  const fields = tourneyFields(ctx, data, null);
  const tourney = await createTourney(
    ctx.db,
    fields,
    log(ctx, "tourney_create", { name: fields.name, region: fields.region, startsAt: fields.startsAt }),
  );
  ctx.log.info("admin: tourney created", { admin: ctx.admin.id, tourney: tourney.id });
  return Response.json({ tourney: { ...tourney, lobbies: [] } }, { status: 201 });
}

/** `POST /api/admin/tourneys/:id`: changes the fields that are sent. The region only while no lobby has a match. */
async function editTourney(ctx: Context, id: number, data: Record<string, unknown>): Promise<Response> {
  const tourney = await findTourney(ctx.db, id);
  if (!tourney) return fail(404, "not_found", "No such tourney");
  const fields = tourneyFields(ctx, data, tourney);
  if (fields.region !== tourney.region && (await listLobbies(ctx.db, [id])).some((l) => l.matchId !== null)) {
    return fail(409, "conflict", "Unlink the lobbies' matches before moving the tourney to another region");
  }
  await updateTourney(ctx.db, id, fields, log(ctx, "tourney_edit", { tourney: id, ...changes(tourney, fields) }));
  ctx.log.info("admin: tourney edited", { admin: ctx.admin.id, tourney: id });
  return Response.json({ tourney: { ...tourney, ...fields, lobbies: (await listLobbies(ctx.db, [id])).map((l) => lobbyView(ctx, l)) } });
}

/**
 * `POST /api/admin/tourneys/:id/lobbies` with `{ label, hostId?, roundLimit? }`. The lobby gets a new
 * random `lobbyKey`. Link its match with `POST /api/admin/lobbies/:id`.
 */
async function addLobby(ctx: Context, tourneyId: number, data: Record<string, unknown>): Promise<Response> {
  const label = text(data.label, ctx.config, "label");
  if (!label) throw new BadRequest("label is required");
  if (!(await findTourney(ctx.db, tourneyId))) return fail(404, "not_found", "No such tourney");
  const fields = await lobbyFields(ctx, data, { label, hostId: null, roundLimit: null, capacity: null });
  if (fields instanceof Response) return fields;
  let id: number | null = null;
  for (let attempt = 1; id === null; attempt++) {
    try {
      id = await createLobby(
        ctx.db,
        tourneyId,
        fields,
        newLobbyKey(ctx.config.tourneyLobbyKeyDigits),
        { ...log(ctx, "lobby_create", { tourney: tourneyId, ...fields }), hostId: fields.hostId },
      );
    } catch (error) {
      // A random key already taken: nothing was written, try another.
      if (!isLobbyKeyTaken(error) || attempt >= ctx.config.tourneyLobbyKeyAttempts) throw error;
      ctx.log.info("admin: lobby key taken, retrying", { tourney: tourneyId, attempt });
    }
  }
  ctx.log.info("admin: lobby created", { admin: ctx.admin.id, tourney: tourneyId, lobby: id });
  return Response.json({ lobby: await lobbyJson(ctx, id) }, { status: 201 });
}

/**
 * `POST /api/admin/lobbies/:id` with `{ label?, hostId?, roundLimit?, matchId? }`: renames the lobby,
 * assigns its host (`null`: none), sets its round limit (`null`: `tourneyRoundLimit`), or links its
 * match (`matchId` a match id, `null` to unlink). A new match clears the verification.
 */
async function editLobby(ctx: Context, id: number, data: Record<string, unknown>): Promise<Response> {
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  const label = data.label === undefined ? lobby.label : text(data.label, ctx.config, "label");
  if (!label) throw new BadRequest("label can't be blank");
  const fields = await lobbyFields(ctx, data, { label, hostId: lobby.hostId, roundLimit: lobby.roundLimit, capacity: lobby.capacity });
  if (fields instanceof Response) return fields;
  let matchId = lobby.matchId;
  if (data.matchId !== undefined) {
    if (data.matchId !== null && !(typeof data.matchId === "number" && Number.isSafeInteger(data.matchId) && data.matchId > 0)) {
      throw new BadRequest("matchId must be a match id or null");
    }
    matchId = data.matchId;
  }

  const at = isoSeconds(ctx.now);
  const tourney = await findTourney(ctx.db, lobby.tourneyId);
  const relink = await relinkStatements(ctx, tourney!.region, lobby.matchId, matchId, at);
  if (relink instanceof Response) return relink;
  // The log keeps the match that left the lobby too: unlinking moves it back to ranked.
  const fromMatchId = lobby.matchId !== matchId ? lobby.matchId : undefined;
  try {
    await updateLobby(
      ctx.db,
      lobby,
      { ...fields, matchId },
      { ...log(ctx, "lobby_edit", { lobby: id, tourney: lobby.tourneyId, ...fields, matchId, fromMatchId }), matchId: matchId ?? lobby.matchId, hostId: fields.hostId },
      relink.statements,
    );
  } catch (error) {
    if (isLobbyChanged(error)) return changedMeanwhile();
    if (isLinkedElsewhere(error)) return fail(409, "conflict", `Match ${matchId} is already another lobby's`);
    throw error;
  }
  ctx.log.info("admin: lobby edited", { admin: ctx.admin.id, lobby: id, match: matchId, host: fields.hostId });
  return Response.json({ lobby: await lobbyJson(ctx, id), ratingsStale: await rerate(ctx, relink.rated, id) });
}

/** `DELETE /api/admin/lobbies/:id`: its match is no longer a tournament, and its screenshot is deleted. */
async function removeLobby(ctx: Context, id: number): Promise<Response> {
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  const relink = await relinkStatements(ctx, null, lobby.matchId, null, isoSeconds(ctx.now));
  if (relink instanceof Response) return relink;
  try {
    await deleteLobby(
      ctx.db,
      lobby,
      { ...log(ctx, "lobby_delete", { lobby: id, tourney: lobby.tourneyId, label: lobby.label }), matchId: lobby.matchId },
      relink.statements,
    );
  } catch (error) {
    if (isLobbyChanged(error)) return changedMeanwhile();
    throw error;
  }
  await flushScreenshotDeletions(ctx.db, ctx.proofs, ctx.config, ctx.log);
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
  const stored = await storeScreenshot(ctx, lobby, request, (image) => log(ctx, "lobby_screenshot", { lobby: id, tourney: lobby.tourneyId, ...image }));
  if (stored instanceof Response) return stored;
  ctx.log.info("admin: screenshot", { admin: ctx.admin.id, lobby: id, bytes: stored.bytes, type: stored.type });
  return Response.json({ lobby: await lobbyJson(ctx, id), expired: stored.expired });
}

/** `DELETE /api/admin/lobbies/:id/screenshot`. */
async function removeScreenshot(ctx: Context, id: number): Promise<Response> {
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  const failed = await deleteScreenshot(ctx, lobby, log(ctx, "lobby_screenshot_delete", { lobby: id, tourney: lobby.tourneyId }));
  if (failed) return failed;
  ctx.log.info("admin: screenshot deleted", { admin: ctx.admin.id, lobby: id });
  return Response.json({ lobby: await lobbyJson(ctx, id) });
}

/**
 * `POST /api/admin/lobbies/:id/verify` with `{ "verified": true }` (or `false`): an admin checked the
 * screenshot against the standings and the match. Needs a match and a screenshot.
 */
async function verify(ctx: Context, id: number, data: Record<string, unknown>): Promise<Response> {
  if (typeof data.verified !== "boolean") throw new BadRequest("verified must be true or false");
  const lobby = await findLobby(ctx.db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  if (data.verified && data.version === undefined) return fail(409, "conflict", "Reload the lobby and send the version of the screenshot and result you checked");
  if (data.version !== undefined) {
    if (typeof data.version !== "number" || !Number.isSafeInteger(data.version) || data.version < 0) throw new BadRequest("version must be a non-negative integer");
    if (data.version !== lobby.version) return changedMeanwhile();
  }
  if (data.verified && (!lobby.matchId || !lobby.screenshotKey)) {
    return fail(409, "conflict", "Link the lobby's match and upload its screenshot before verifying it");
  }
  if ((lobby.verifiedAt !== null) === data.verified) return fail(409, "conflict", `The lobby is ${data.verified ? "already" : "not"} verified`);
  try {
    await setVerified(ctx.db, lobby, data.verified, {
      ...log(ctx, "lobby_verify", { lobby: id, tourney: lobby.tourneyId, verified: data.verified }),
      matchId: lobby.matchId,
    });
  } catch (error) {
    if (isLobbyChanged(error)) return changedMeanwhile();
    throw error;
  }
  ctx.log.info("admin: lobby verified", { admin: ctx.admin.id, lobby: id, verified: data.verified });
  return Response.json({ lobby: await lobbyJson(ctx, id) });
}

/**
 * A lobby as the admin API shows it: `roundLimit` is the one it plays, its own or `tourneyRoundLimit`,
 * and `capacity` the players it holds, its own or `tourneyLobbyCapacity`.
 */
function lobbyView(ctx: Context, lobby: LobbyRow) {
  return {
    ...lobby,
    roundLimit: roundLimitOf(lobby.roundLimit, ctx.config),
    roundLimitDefault: lobby.roundLimit === null,
    capacity: capacityOf(lobby.capacity, ctx.config),
    capacityDefault: lobby.capacity === null,
  };
}

async function lobbyJson(ctx: Context, id: number) {
  const lobby = await findLobby(ctx.db, id);
  return lobby && lobbyView(ctx, lobby);
}

/**
 * The host, round limit and capacity sent for a lobby, else `from`'s. `hostId`: any host whose token
 * isn't revoked, whatever its home region (the lobby is played in its tourney's region). `roundLimit`:
 * 1 to `tourneyRoundLimitMax`, or null for `tourneyRoundLimit`. `capacity`: 1 to
 * `tourneyLobbyCapacityMax` players, or null for `tourneyLobbyCapacity`.
 */
async function lobbyFields(ctx: Context, data: Record<string, unknown>, from: LobbyFields): Promise<LobbyFields | Response> {
  const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  let hostId = from.hostId;
  if (data.hostId !== undefined) {
    if (data.hostId !== null && !isId(data.hostId)) throw new BadRequest("hostId must be a host id or null");
    if (data.hostId !== null && data.hostId !== from.hostId) {
      const host = await findHostById(ctx.db, data.hostId);
      if (!host) return fail(404, "not_found", "No such host");
      if (host.trust === "revoked") return fail(409, "conflict", `${host.name}'s token is revoked: make them a new one first`);
    }
    hostId = data.hostId;
  }
  let roundLimit = from.roundLimit;
  if (data.roundLimit !== undefined) {
    const max = ctx.config.tourneyRoundLimitMax;
    if (data.roundLimit !== null && !(isId(data.roundLimit) && data.roundLimit <= max)) throw new BadRequest(`roundLimit must be 1 to ${max}, or null for the default`);
    roundLimit = data.roundLimit;
  }
  let capacity = from.capacity;
  if (data.capacity !== undefined) {
    const max = ctx.config.tourneyLobbyCapacityMax;
    if (data.capacity !== null && !(isId(data.capacity) && data.capacity <= max)) throw new BadRequest(`capacity must be 1 to ${max} players, or null for the default`);
    capacity = data.capacity;
  }
  return { label: from.label, hostId, roundLimit, capacity };
}

// Helpers

function log(ctx: Context, action: string, detail: Record<string, unknown>): ActionLog {
  return { adminId: ctx.admin.id, action, detail, at: isoSeconds(ctx.now) };
}

/** The fields of a new tourney (`from` null) or an edited one: what's sent, else what it was. */
function tourneyFields(ctx: Context, data: Record<string, unknown>, from: TourneyFields | null): TourneyFields {
  const name = data.name === undefined && from ? from.name : text(data.name, ctx.config, "name");
  if (!name) throw new BadRequest("name is required");
  const region = data.region === undefined && from ? from.region : regionField(data.region, ctx.config, "region");
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
  return { name, region, startsAt: startsAt!, status: status as TourneyStatus, notes };
}

/** What an edit changed, for the action log. */
function changes(from: TourneyFields, to: TourneyFields): Record<string, unknown> {
  const keys = (["name", "region", "startsAt", "status", "notes"] as const).filter((k) => from[k] !== to[k]);
  return Object.fromEntries(keys.map((k) => [k, { from: from[k], to: to[k] }]));
}

/**
 * Moving a lobby from match `from` to match `to`: `from` is no longer a tournament and `to` is one,
 * and the ratings are stale from whichever of them was rated. `to` has to be from the tourney's
 * `region` (null when only unlinking). `rated`: whether an accepted match changed, so the ratings need bringing up to date.
 */
async function relinkStatements(
  ctx: Context,
  region: string | null,
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
    if (region !== null && match.region !== region) return fail(409, "conflict", `The match was played in ${match.region}, the tourney is in ${region}`);
    changed.push(to);
    rated ||= match.status === "accepted";
    statements.push(tournamentStatement(ctx.db, [to], true));
  }
  if (from !== null) {
    const match = await findMatch(ctx.db, from);
    changed.push(from);
    rated ||= match?.status === "accepted";
    statements.push(tournamentStatement(ctx.db, [from], false));
  }
  if (changed.length) statements.push(staleFromMatchesStatement(ctx.db, changed, at, true));
  // Also invalidate a rating run that read an as-yet-unrated match before this flag changed.
  if (changed.length) statements.push(ctx.db.prepare("UPDATE rating_state SET version = version + 1"));
  return { statements, rated };
}

/** Brings the ratings up to date as far as one run goes, like a void. Returns whether they're still stale. */
async function rerate(ctx: Context, rated: boolean, lobby: LobbyRow["id"]): Promise<boolean> {
  try {
    if (rated) await updateRatings(ctx.db, ctx.config, ctx.now, ctx.log);
    return await anyStale(ctx.db);
  } catch (error) {
    // The change is stored; the cron rates or recomputes.
    ctx.log.error("rating after admin action failed", { lobby, error: String(error) });
    return true;
  }
}
