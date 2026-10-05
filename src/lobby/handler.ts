import type { Config } from "../config";
import { fail } from "../http";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import { authHost, hostRegion, readLimited } from "../upload/handler";
import { closeLobby, deleteStaleLobbies, upsertLobby } from "./store";

/**
 * `/api/host/lobby`: the host tool says a ranked lobby is open (#11, Genji-Ball-Team/genjiball-host-tool#6).
 * `Authorization: Bearer <host token>`, as for an upload.
 *
 * - `PUT`: a heartbeat, every `lobbyHeartbeatSeconds` while the lobby is open. Body
 *   `{ "players": 6, "name": "..." }` (`name` optional). `X-Region` as for an upload. One row written. At most one every
 *   `lobbyHeartbeatMinSeconds` (429 otherwise), counted from the last heartbeat or close.
 * - `DELETE`: the lobby closed (the match ended, the game closed, the host switched it off). The row
 *   stays, marked closed, so closing and reopening can't get round the rate limit.
 *
 * A lobby whose heartbeats stop is gone after `lobbyTtlSeconds`. The site lists them with
 * `GET /api/lobbies?region=` (src/site/handler.ts).
 *
 * Tourney lobbies (#25) will add an optional `tourneyLobbyId` to the body, checked against the
 * host's assigned lobbies, and the list's `tourney` will show its label. Not built yet: `tourney` is
 * always null.
 */

export type LobbyConfig = Pick<
  Config,
  | "regions"
  | "lobbyHeartbeatSeconds"
  | "lobbyHeartbeatMinSeconds"
  | "lobbyTtlSeconds"
  | "lobbyNameMaxLength"
  | "lobbyPlayersMax"
  | "lobbyBodyMaxBytes"
>;

export async function handleHostLobby(request: Request, db: D1Database, config: LobbyConfig, log: Logger, now = new Date()): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "DELETE") {
    return fail(405, "method_not_allowed", "Use PUT for a heartbeat, DELETE to close the lobby", { Allow: "PUT, DELETE" });
  }
  const host = await authHost(request, db);
  if (host instanceof Response) return host;

  if (request.method === "DELETE") {
    const closed = await closeLobby(db, host.id, isoSeconds(now));
    log.debug("lobby closed", { host: host.id, closed });
    return Response.json({ closed });
  }

  const region = hostRegion(request, host, config, "the lobby is hosted in");
  if (region instanceof Response) return region;
  const body = await readHeartbeat(request, config);
  if (typeof body === "string") return fail(400, "bad_request", body);

  const { lobby, rowsWritten } = await upsertLobby(db, {
    hostId: host.id,
    region: region.id,
    ...body,
    now: isoSeconds(now),
    staleBefore: secondsBefore(now, config.lobbyTtlSeconds),
    tooSoonAfter: secondsBefore(now, config.lobbyHeartbeatMinSeconds),
  });
  if (!lobby) {
    log.debug("lobby heartbeat too soon", { host: host.id });
    return fail(429, "rate_limited", `At most one heartbeat every ${config.lobbyHeartbeatMinSeconds} seconds`, {
      "Retry-After": String(config.lobbyHeartbeatMinSeconds),
    });
  }
  log.debug("lobby heartbeat", { host: host.id, rowsWritten, ...lobby });
  return Response.json({ lobby, heartbeatSeconds: config.lobbyHeartbeatSeconds, ttlSeconds: config.lobbyTtlSeconds });
}

/** On the cron: deletes the lobbies whose heartbeats stopped or that were closed, once past the TTL. */
export async function clearStaleLobbies(db: D1Database, config: Pick<Config, "lobbyTtlSeconds">, now: Date, log: Logger): Promise<void> {
  const deleted = await deleteStaleLobbies(db, secondsBefore(now, config.lobbyTtlSeconds));
  if (deleted) log.debug("stale lobbies deleted", { deleted });
}

/** A lobby last seen at or before this is past `seconds` old. */
export function secondsBefore(now: Date, seconds: number): string {
  return isoSeconds(new Date(now.getTime() - seconds * 1000));
}

/** The heartbeat's `{ players, name }`, or what's wrong with it. */
async function readHeartbeat(request: Request, config: LobbyConfig): Promise<{ players: number; name: string | null } | string> {
  const bytes = await readLimited(request, config.lobbyBodyMaxBytes);
  if (!bytes) return `The body is larger than ${config.lobbyBodyMaxBytes} bytes`;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return "The body must be JSON: { players, name? }";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "The body must be a JSON object: { players, name? }";
  const { players, name } = body as Record<string, unknown>;
  if (!Number.isInteger(players) || (players as number) < 0 || (players as number) > config.lobbyPlayersMax) {
    return `players must be a whole number from 0 to ${config.lobbyPlayersMax}`;
  }
  if (name !== undefined && name !== null && typeof name !== "string") return "name must be a string";
  const trimmed = name?.trim() || null;
  if (trimmed !== null && [...trimmed].length > config.lobbyNameMaxLength) {
    return `name is longer than ${config.lobbyNameMaxLength} characters`;
  }
  return { players: players as number, name: trimmed };
}
