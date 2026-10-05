import { fail } from "../http";
import { searchPlayers } from "../site/store";
import { isoSeconds } from "../time";
import { nameKey } from "../upload/plan";
import {
  activeMergeOf,
  aliasOwner,
  findMerge,
  findPlayers,
  listAliasNames,
  listMerges,
  publicMerge,
  sharedRound,
  writeMerge,
  writeName,
  writeUndo,
  type AdminPlayer,
  type MergeRow,
} from "./playerStore";
import { BadRequest, body, changedMeanwhile, notAllowed, text, type Context } from "./request";
import { isStale } from "./store";

/**
 * `/api/admin/players*` and `/api/admin/merges*` (#8): find players, merge two names that are one
 * player (a name change), undo a merge, and set a display name. Merges fix name changes; they don't
 * tell who is behind an account. Returns null for a path that isn't one of these.
 */
export async function handlePlayerAdmin(ctx: Context, request: Request, path: string[], id: number | null): Promise<Response | null> {
  const method = request.method;
  if (path[0] === "players") {
    if (path.length === 1) return method === "GET" ? await search(ctx, request) : notAllowed("GET");
    if (id === null) return null;
    if (path.length === 2) return method === "GET" ? await detail(ctx, id) : notAllowed("GET");
    if (path.length === 3 && path[2] === "merge") return method === "POST" ? await merge(ctx, id, await body(request)) : notAllowed("POST");
    if (path.length === 3 && path[2] === "name") return method === "POST" ? await rename(ctx, id, await body(request)) : notAllowed("POST");
  }
  if (path[0] === "merges") {
    if (path.length === 1) return method === "GET" ? Response.json({ merges: await listMerges(ctx.db, null, ctx.config.adminListLimit) }) : notAllowed("GET");
    if (id !== null && path.length === 3 && path[2] === "undo") return method === "POST" ? await undo(ctx, id) : notAllowed("POST");
  }
  return null;
}

/**
 * `GET /api/admin/players?search=` : the site's name search (current and old names, ignoring case),
 * every region, merged players left out (they have no names), each with all their names.
 */
async function search(ctx: Context, request: Request): Promise<Response> {
  const term = (new URL(request.url).searchParams.get("search") ?? "").trim();
  if (term.length < ctx.config.playerSearchMinLength) {
    throw new BadRequest(`search needs at least ${ctx.config.playerSearchMinLength} characters`);
  }
  // The board only orders the hits by rating; every player is listed.
  const rows = await searchPlayers(ctx.db, nameKey(term), ctx.config.regions[0]!.id, false, ctx.config.adminListLimit);
  const aliases = await listAliasNames(ctx.db, rows.map((row) => row.id));
  return Response.json({
    players: rows.map((row) => ({ id: row.id, name: row.name, matchedAlias: row.matchedAlias, aliases: aliases.get(row.id) ?? [] })),
  });
}

/** `GET /api/admin/players/:id`: names, ratings per region, match count, and the merges they were in. */
async function detail(ctx: Context, playerId: number): Promise<Response> {
  const [players, merges] = await Promise.all([findPlayers(ctx.db, [playerId]), listMerges(ctx.db, playerId, ctx.config.adminListLimit)]);
  const player = players.get(playerId);
  return player ? Response.json({ player, merges }) : fail(404, "not_found", "No such player");
}

/** A player id in a body field. */
function playerIdField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new BadRequest(`${field} must be a player id`);
  return value;
}

/**
 * `POST /api/admin/players/:id/merge` with `{ "into": <player id> }`: the player's names and matches
 * become `into`'s, who keeps their id. Their ratings are rebuilt from the first match the merged
 * player played in each region, by the cron.
 */
async function merge(ctx: Context, fromId: number, data: Record<string, unknown>): Promise<Response> {
  const intoId = playerIdField(data.into, "into");
  if (intoId === fromId) throw new BadRequest("A player can't be merged into themselves");
  const players = await findPlayers(ctx.db, [fromId, intoId]);
  const from = players.get(fromId);
  const into = players.get(intoId);
  if (!from || !into) return fail(404, "not_found", "No such player");
  const merged = (p: AdminPlayer) => fail(409, "conflict", `${p.name} (${p.id}) was merged into player ${p.mergedInto}. Use that player`);
  if (from.mergedInto !== null) return merged(from);
  if (into.mergedInto !== null) return merged(into);
  const together = await sharedRound(ctx.db, fromId, intoId);
  if (together) {
    return fail(409, "conflict", `${from.name} and ${into.name} played round ${together.round} of match ${together.matchId} together: they're two players`);
  }

  const at = isoSeconds(ctx.now);
  const names = from.aliases.map((a) => a.name);
  let mergeId: number;
  try {
    mergeId = await writeMerge(ctx.db, {
      from: fromId,
      into: intoId,
      adminId: ctx.admin.id,
      at,
      detail: { from: fromId, into: intoId, fromName: from.name, intoName: into.name, aliases: names },
    });
  } catch (error) {
    if (isStale(error)) return changedMeanwhile();
    throw error;
  }
  ctx.log.info("admin: player merge", { admin: ctx.admin.id, merge: mergeId, from: fromId, into: intoId });
  const row: MergeRow = {
    id: mergeId,
    from: { id: fromId, name: from.name },
    into: { id: intoId, name: into.name },
    aliases: names,
    mergedBy: ctx.admin.name,
    mergedAt: at,
    undoneBy: null,
    undoneAt: null,
  };
  return Response.json({ merge: row, ratingsStale: true });
}

/**
 * `POST /api/admin/merges/:id/undo`: the merged player gets their names back, with every match
 * played under them (matches uploaded since the merge too), and the ratings are rebuilt like after
 * the merge. Merges are undone newest first: if the player was merged on since, undo that first.
 */
async function undo(ctx: Context, mergeId: number): Promise<Response> {
  const found = await findMerge(ctx.db, mergeId);
  if (!found) return fail(404, "not_found", "No such merge");
  if (found.undoneAt) return fail(409, "conflict", "The merge is already undone");
  if (found.movedSince) {
    const later = await activeMergeOf(ctx.db, found.into.id);
    return fail(409, "conflict", `${found.into.name} was merged into another player since: undo merge ${later ?? "?"} first`);
  }

  const keys = new Set(found.aliasKeys);
  const at = isoSeconds(ctx.now);
  try {
    await writeUndo(ctx.db, { merge: found, unfixInto: keys.has(nameKey(found.into.name)), adminId: ctx.admin.id, at });
  } catch (error) {
    if (isStale(error)) return changedMeanwhile();
    throw error;
  }
  ctx.log.info("admin: player merge undone", { admin: ctx.admin.id, merge: mergeId, from: found.from.id, into: found.into.id });
  return Response.json({
    merge: { ...publicMerge(found), undoneBy: ctx.admin.name, undoneAt: at },
    ratingsStale: true,
  });
}

/**
 * `POST /api/admin/players/:id/name` with `{ "name": "..." }`: the display name, which uploads then
 * leave alone. Old names stay aliases; a new one becomes one. `{ "name": null }`: the display name
 * follows the logs again.
 */
async function rename(ctx: Context, playerId: number, data: Record<string, unknown>): Promise<Response> {
  if (data.name === undefined) throw new BadRequest("name is required (null to follow the logs)");
  const name = data.name === null ? null : text(data.name, ctx.config, "name", ctx.config.playerNameMaxLength);
  if (data.name !== null && !name) throw new BadRequest("name can't be blank");
  const player = (await findPlayers(ctx.db, [playerId])).get(playerId);
  if (!player) return fail(404, "not_found", "No such player");
  if (player.mergedInto !== null) return fail(409, "conflict", `The player was merged into player ${player.mergedInto}. Rename that one`);
  const key = name === null ? null : nameKey(name);
  if (key !== null) {
    const owner = await aliasOwner(ctx.db, key);
    if (owner !== null && owner !== playerId) return fail(409, "conflict", `${name} is player ${owner}'s name. Merge the two players instead`);
  }

  try {
    await writeName(ctx.db, playerId, name === null ? null : { name, key: key! }, {
      adminId: ctx.admin.id,
      detail: { player: playerId, from: player.name, to: name },
      at: isoSeconds(ctx.now),
    });
  } catch (error) {
    if (isStale(error)) return changedMeanwhile();
    throw error;
  }
  ctx.log.info("admin: player name", { admin: ctx.admin.id, player: playerId, from: player.name, to: name });
  return Response.json({ player: (await findPlayers(ctx.db, [playerId])).get(playerId) });
}
