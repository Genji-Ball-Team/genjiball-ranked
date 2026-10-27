import type { Config } from "../config";
import { fail, notAllowed, readJsonObject } from "../http";
import type { Logger } from "../log";
import { isoSeconds, secondsBefore } from "../time";
import { authHost, hostRegion } from "../upload/handler";
import { closeLobby, deleteStaleLobbies, upsertLobby } from "./store";

/**
 * `/api/host/lobby`: the host tool says a ranked lobby is open (#11, Genji-Ball-Team/genjiball-host-tool#6).
 * `Authorization: Bearer <host token>`, as for an upload.
 *
 * - `PUT`: a heartbeat, every `lobbyHeartbeatSeconds` while the lobby is open. Body
 *   `{ "players": 6, "name": "...", "names": [...] }` (`name` and `names` optional; `names` lists the
 *   `players`, in the order they joined). `X-Region` as for an upload. One row written. At most one every
 *   `lobbyHeartbeatMinSeconds` (429 otherwise), counted from the last heartbeat or close.
 * - `DELETE`: the lobby closed (the match ended, the game closed, the host switched it off). The row
 *   stays, marked closed, so closing and reopening can't get round the rate limit.
 *
 * A lobby whose heartbeats stop is gone after `lobbyTtlSeconds`. The site lists them with
 * `GET /api/lobbies?region=` (src/site/handler.ts).
 *
 * The list's `tourney` is reserved for the tourney lobby a heartbeat is for, and always null: a host
 * finds their tourney lobbies through `GET /api/host/tourneys` (#25, src/tourney/host.ts) instead.
 */

export type LobbyConfig = Pick<
  Config,
  | "regions"
  | "lobbyHeartbeatSeconds"
  | "lobbyHeartbeatMinSeconds"
  | "lobbyTtlSeconds"
  | "lobbyNameMaxLength"
  | "lobbyPlayersMax"
  | "lobbyPlayerNameMaxLength"
  | "lobbyBodyMaxBytes"
>;

export async function handleHostLobby(request: Request, db: D1Database, config: LobbyConfig, log: Logger, now = new Date()): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "DELETE") {
    return notAllowed("PUT, DELETE", "Use PUT for a heartbeat, DELETE to close the lobby");
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

/** The heartbeat's `{ players, name, names }`, or what's wrong with it. */
async function readHeartbeat(
  request: Request,
  config: LobbyConfig,
): Promise<{ players: number; name: string | null; names: string[] | null } | string> {
  const body = await readJsonObject(request, config.lobbyBodyMaxBytes, "{ players, name?, names? }");
  if (typeof body === "string") return body;
  const { players, name, names } = body;
  if (!Number.isInteger(players) || (players as number) < 0 || (players as number) > config.lobbyPlayersMax) {
    return `players must be a whole number from 0 to ${config.lobbyPlayersMax}`;
  }
  if (name !== undefined && name !== null && typeof name !== "string") return "name must be a string";
  const trimmed = name?.trim() || null;
  if (trimmed !== null && [...trimmed].length > config.lobbyNameMaxLength) {
    return `name is longer than ${config.lobbyNameMaxLength} characters`;
  }
  const list = readNames(names, players as number, config);
  if (typeof list === "string") return list;
  return { players: players as number, name: trimmed, names: list };
}

/**
 * The heartbeat's `names`: one per player, so the list and the count never disagree. Left out or
 * null: `null` (a host tool from before names were sent), and the site shows only the count.
 */
function readNames(names: unknown, players: number, config: LobbyConfig): string[] | null | string {
  if (names === undefined || names === null) return null;
  if (!Array.isArray(names) || names.length !== players) return "names must list one name for each of the players";
  const trimmed: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) return "each of names must be a name";
    if ([...name.trim()].length > config.lobbyPlayerNameMaxLength) {
      return `a name in names is longer than ${config.lobbyPlayerNameMaxLength} characters`;
    }
    trimmed.push(name.trim());
  }
  return trimmed;
}
