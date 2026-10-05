import { findRegion, type Config, type Region } from "../config";
import { fail } from "../http";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import { authHost } from "../upload/handler";
import type { Host } from "../upload/store";
import { codeFrom, roundLimitOf, tourneyCode, type CodeConfig } from "./code";
import { screenshotUrl } from "./screenshot";
import { findHostLobby, listHostLobbies, type HostActionLog, type HostLobbyRow } from "./store";
import { deleteScreenshot, storeScreenshot, type ScreenshotConfig } from "./upload";

/**
 * The host API for tourneys (#25, #28, docs/api.md): `GET /api/host/tourneys` lists the lobbies an
 * admin assigned to the token's host, with the tourney code values in their window, and
 * `PUT`/`DELETE /api/host/lobbies/:id/screenshot` is the assigned host's verify screenshot.
 *
 * A lobby is played in its tourney's region (#47): every lobby in an answer says which, and a host
 * who sends a region (`?region=` or `X-Region`) only sees, and only uploads to, lobbies there.
 */

export type HostTourneyConfig = ScreenshotConfig & CodeConfig & Pick<Config, "regions">;

/** `GET /api/host/tourneys[?region=eu]`. */
export async function handleHostTourneys(request: Request, db: D1Database, config: HostTourneyConfig, now: Date): Promise<Response> {
  if (request.method !== "GET") return fail(405, "method_not_allowed", "Use GET", { Allow: "GET" });
  const host = await authHost(request, db);
  if (host instanceof Response) return host;
  const region = requestedRegion(request, config);
  if (region instanceof Response) return region;
  const lobbies = await listHostLobbies(db, host.id, region?.id ?? null);
  return Response.json({
    region: region?.id ?? null,
    codeLeadMinutes: config.tourneyCodeLeadMinutes,
    lobbies: lobbies.map((l) => hostLobbyView(l, config, now)),
  });
}

/**
 * `/api/host/lobbies/:id/screenshot`: `PUT` the image, or `DELETE` it, until an admin has verified it.
 * The checks below are repeated inside the write's transaction (`setScreenshot`), so a revocation,
 * reassignment, verification, cancellation or region move during the R2 upload makes it a 409 and
 * the uploaded object is queued for deletion.
 */
export async function handleHostTourneyLobby(request: Request, db: D1Database, proofs: R2Bucket, config: HostTourneyConfig, log: Logger): Promise<Response> {
  const path = /^\/api\/host\/lobbies\/([1-9]\d{0,15})\/screenshot\/?$/.exec(new URL(request.url).pathname);
  if (!path) return fail(404, "not_found", "No such host route");
  if (request.method !== "PUT" && request.method !== "DELETE") return fail(405, "method_not_allowed", "Use PUT or DELETE", { Allow: "PUT, DELETE" });
  const host = await authHost(request, db);
  if (host instanceof Response) return host;
  const region = requestedRegion(request, config);
  if (region instanceof Response) return region;

  const id = Number(path[1]);
  const lobby = await findHostLobby(db, id);
  if (!lobby) return fail(404, "not_found", "No such lobby");
  const refused = refuse(lobby, host, region);
  if (refused) return refused;

  const now = new Date();
  const c = { db, proofs, config, log, now };
  const action = (name: string, detail: Record<string, unknown> = {}): HostActionLog => ({
    hostId: host.id,
    action: name,
    region: lobby.region,
    detail: { lobby: id, tourney: lobby.tourneyId, ...detail },
    at: isoSeconds(now),
  });
  if (request.method === "PUT") {
    const stored = await storeScreenshot(c, lobby, request, (image) => action("lobby_screenshot", image));
    if (stored instanceof Response) return stored;
    log.info("host: screenshot", { host: host.id, lobby: id, bytes: stored.bytes, type: stored.type });
  } else {
    const failed = await deleteScreenshot(c, lobby, action("lobby_screenshot_delete"));
    if (failed) return failed;
    log.info("host: screenshot deleted", { host: host.id, lobby: id });
  }
  // Only while it's still this host's, with an unrevoked token: a lobby reassigned since shows them nothing.
  const after = await findHostLobby(db, id, host.id);
  return Response.json({ lobby: after && hostLobbyView(after, config, now) });
}

/** Why this host can't change the lobby's screenshot, or null when it can. */
function refuse(lobby: HostLobbyRow, host: Host, region: Region | null): Response | null {
  if (lobby.hostId !== host.id) return fail(403, "not_assigned", "This lobby isn't assigned to you");
  if (region && region.id !== lobby.region) {
    return fail(409, "wrong_region", `This lobby is played in ${lobby.region}, not ${region.id}`);
  }
  if (lobby.tourneyStatus === "cancelled") return fail(409, "conflict", "The tourney was cancelled");
  if (lobby.verifiedAt !== null) return fail(409, "verified", "An admin has verified this screenshot: ask an admin to change it");
  return null;
}

/** The region the host asked for (`?region=`, else `X-Region`), null for none, or a 400 for an unknown one. */
function requestedRegion(request: Request, config: Pick<Config, "regions">): Region | null | Response {
  const asked = new URL(request.url).searchParams.get("region") ?? request.headers.get("X-Region");
  if (asked === null) return null;
  return findRegion(config.regions, asked) ?? fail(400, "bad_request", `region must be one of ${config.regions.map((r) => r.id).join(", ")}`);
}

/** A lobby as its host sees it. `code` is null outside the code window. */
export function hostLobbyView(l: HostLobbyRow, config: CodeConfig, now: Date) {
  return {
    id: l.id,
    label: l.label,
    region: l.region,
    roundLimit: roundLimitOf(l.roundLimit, config),
    tourney: { id: l.tourneyId, name: l.tourneyName, region: l.region, startsAt: l.tourneyStartsAt, status: l.tourneyStatus },
    matchId: l.matchId,
    screenshot: screenshotUrl(l.screenshotKey),
    screenshotExpired: l.screenshotKey === null && l.screenshotExpiredAt !== null,
    verified: l.verifiedAt !== null,
    codeFrom: codeFrom(l.tourneyStartsAt, config),
    code: tourneyCode(l, config, now),
  };
}
