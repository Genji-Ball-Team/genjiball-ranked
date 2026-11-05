import { fail, notAllowed } from "../http";
import { checkDuels, planDuels, type DuelInput, type DuelPlayer } from "../duels/plan";
import { countRatedToday, findPlayersByName, writeDuels } from "../duels/store";
import { regionRatingConfig } from "../rating/engine";
import { anyStale, readRatings } from "../rating/store";
import { rateNewMatches } from "../rating/update";
import { isoSeconds } from "../time";
import { nameKey } from "../upload/plan";
import { BadRequest, body, regionField, type Context } from "./request";

/**
 * `/api/admin/duels` (docs/api.md, "Duels"): an admin enters 1v1 results by hand.
 *
 * - `POST /api/admin/duels/preview` with `{ region, duels: [{ winner, loser, winnerScore, loserScore }] }`:
 *   what saving would do, duel by duel, from the region's ratings now. Writes nothing.
 * - `POST /api/admin/duels` with the same and `newPlayers` (names): saves them, played now, one
 *   second apart, and rates them straight away. A name no player has is refused unless it's in
 *   `newPlayers`: then it becomes a new player, with that name as their alias, so their lobbies later
 *   count for the same player.
 *
 * Undo a duel by voiding its match (`POST /api/admin/matches/:id/void`): the ratings are recomputed
 * from it, as for any match.
 */
export async function handleDuelAdmin(ctx: Context, request: Request, path: readonly string[]): Promise<Response | null> {
  if (path.length === 2 && path[1] === "preview") {
    return request.method === "POST" ? await preview(ctx, await body(request)) : notAllowed("POST");
  }
  if (path.length === 1) {
    return request.method === "POST" ? await save(ctx, await body(request)) : notAllowed("POST");
  }
  return null;
}

/** The entry checked and previewed from the region's ratings now. */
async function plan(ctx: Context, data: Record<string, unknown>) {
  const region = regionField(data.region, ctx.config, "region");
  const duels = checkDuels(data.duels, ctx.config);
  if (typeof duels === "string") throw new BadRequest(duels);
  const keys = duels.flatMap((d) => [nameKey(d.winner), nameKey(d.loser)]);
  const dayStart = `${isoSeconds(ctx.now).slice(0, 10)}T00:00:00Z`;
  const [known, ratedToday] = await Promise.all([findPlayersByName(ctx.db, keys), countRatedToday(ctx.db, region, dayStart)]);
  samePlayer(duels, known);
  const ids = [...new Set([...known.values()].map((p) => p.id))];
  const ratings = await readRatings(ctx.db, region, ids);
  const config = regionRatingConfig(ctx.config, region);
  const planned = planDuels(duels, known as ReadonlyMap<string, DuelPlayer>, ratings, ratedToday, config, isoSeconds(ctx.now));
  const newPlayers = [...new Map(keys.filter((k) => !known.has(k)).map((k) => [k, nameOf(duels, k)])).values()];
  return { region, planned, newPlayers };
}

/** Two names of one player (two aliases of theirs) can't duel. */
function samePlayer(duels: readonly DuelInput[], known: ReadonlyMap<string, { id: number }>): void {
  duels.forEach((d, i) => {
    const winner = known.get(nameKey(d.winner))?.id;
    if (winner !== undefined && winner === known.get(nameKey(d.loser))?.id) {
      throw new BadRequest(`Duel ${i + 1}: ${d.winner} and ${d.loser} are the same player`);
    }
  });
}

/** The name as typed the first time the entry has it. */
function nameOf(duels: readonly DuelInput[], key: string): string {
  for (const d of duels) {
    if (nameKey(d.winner) === key) return d.winner;
    if (nameKey(d.loser) === key) return d.loser;
  }
  return key;
}

async function preview(ctx: Context, data: Record<string, unknown>): Promise<Response> {
  const { region, planned, newPlayers } = await plan(ctx, data);
  return Response.json({ region, duels: planned, newPlayers });
}

async function save(ctx: Context, data: Record<string, unknown>): Promise<Response> {
  const { region, planned, newPlayers } = await plan(ctx, data);
  const allowed = new Set(
    (Array.isArray(data.newPlayers) ? data.newPlayers : []).filter((n): n is string => typeof n === "string").map((n) => nameKey(n.trim())),
  );
  const unconfirmed = newPlayers.filter((name) => !allowed.has(nameKey(name)));
  if (unconfirmed.length) {
    return fail(409, "conflict", `No player has the name ${unconfirmed.join(", ")}. Check the spelling, or add them as new players`);
  }

  const at = isoSeconds(ctx.now);
  const playedAt = planned.map((_, i) => isoSeconds(new Date(ctx.now.getTime() + i * 1000)));
  const ids = await writeDuels(ctx.db, {
    region,
    playedAt,
    duels: planned,
    stamp: `${ctx.now.getTime()}-${crypto.randomUUID().slice(0, 8)}`,
    adminId: ctx.admin.id,
    at,
  });
  ctx.log.info("admin: duels added", { admin: ctx.admin.id, region, matches: ids, newPlayers });

  // Rated now, on top of the ratings: they're the newest matches. The cron does it if this fails.
  let ratingsStale = true;
  try {
    if (ctx.queries.left() > 1) await rateNewMatches(ctx.db, ctx.config, ctx.now, ctx.log, region, ids.length);
    ratingsStale = await anyStale(ctx.db);
  } catch (error) {
    ctx.log.error("rating after duels failed", { region, error: String(error) });
  }
  return Response.json({ region, duels: planned.map((d, i) => ({ id: ids[i] ?? null, ...d })), newPlayers, ratingsStale }, { status: 201 });
}
