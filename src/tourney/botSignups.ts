import type { Config } from "../config";
import { fail } from "../http";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import { readLimited, sha256 } from "../upload/handler";
import { nameKey } from "../upload/plan";
import { checkName, signupSummary } from "./signups";

/**
 * `/api/bot/tourneys/:id/signups`: the Discord bot's side of the tourney sign-ups (#31), so the
 * Tourneys page and Discord share one list (Genji-Ball-Team/Discord-Bot). Behind the bot's token
 * (`BOT_TOKEN`, a wrangler secret): `Authorization: Bearer <token>`.
 *
 * - `GET`: the sign-ups not removed, first come first, each with its Discord user (or `null`).
 * - `POST { signups: [{ discordUserId, name }] }`: signs Discord users up, at most
 *   `botSignupsPerRequest` at once. A name already signed up from the page with no Discord user is
 *   the same player: the Discord user claims it. Past capacity is fine, as on the page.
 * - `DELETE …/signups/:discordUserId`: the player unregistered in Discord. Their row goes (a removal
 *   by an admin stays: that name can't come back).
 *
 * Only while the tourney is `scheduled`, like the page's sign-up. Not rate-limited by IP.
 */

export type BotSignupConfig = Pick<
  Config,
  "playerNameMaxLength" | "tourneyLobbyCapacity" | "tourneySignupsMax" | "botSignupsPerRequest" | "botSignupBodyMaxBytes"
>;

/** What happened to one Discord user's sign-up. */
export type BotSignupStatus = "created" | "linked" | "exists" | "removed" | "name_taken" | "too_many" | "conflict";

/** Stored as their `ip_hash`: the bot's sign-ups aren't rate-limited by IP. */
const discordIpHash = "discord";
const snowflake = /^[1-9]\d{0,19}$/;

interface Item {
  discordUserId: string;
  name: string;
  nameKey: string;
}

interface ExistingRow {
  id: number;
  name: string;
  nameKey: string;
  discordUserId: string | null;
  removed: number;
}

interface TourneyState {
  status: string;
  stored: number;
  capacity: number;
}

export async function handleBotSignups(
  request: Request,
  db: D1Database,
  config: BotSignupConfig,
  botToken: string | undefined,
  log: Logger,
  now = new Date(),
): Promise<Response> {
  const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim();
  if (!token) return fail(401, "unauthorized", "Send the bot token as Authorization: Bearer <token>");
  // Compare hashes, not the strings: the time taken says nothing about the token.
  if (!botToken || (await sha256(token)) !== (await sha256(botToken))) return fail(401, "unauthorized", "Unknown bot token");

  const m = /^\/api\/bot\/tourneys\/([^/]+)\/signups(?:\/([^/]+))?\/?$/.exec(new URL(request.url).pathname);
  if (!m || !/^[1-9]\d{0,15}$/.test(m[1]!)) return fail(404, "not_found", "No such route");
  const tourneyId = Number(m[1]);

  if (m[2] !== undefined) {
    if (request.method !== "DELETE") return fail(405, "method_not_allowed", "Use DELETE", { Allow: "DELETE" });
    if (!snowflake.test(m[2])) return fail(404, "not_found", "Not a Discord user id");
    return unregister(db, config, tourneyId, m[2], log);
  }
  if (request.method === "GET") return list(db, config, tourneyId);
  if (request.method === "POST") return register(request, db, config, tourneyId, log, now);
  return fail(405, "method_not_allowed", "Use GET or POST", { Allow: "GET, POST" });
}

const stateQuery = `SELECT t.status,
    (SELECT count(*) FROM tourney_signups WHERE tourney_id = t.id) AS stored,
    (SELECT count(*) FROM tourney_signups WHERE tourney_id = t.id AND removed_at IS NULL) AS count,
    (SELECT coalesce(sum(coalesce(capacity, ?2)), 0) FROM tourney_lobbies WHERE tourney_id = t.id) AS capacity
  FROM tourneys t WHERE t.id = ?1`;

const listQuery = `SELECT name, discord_user_id AS discordUserId, signed_up_at AS signedUpAt FROM tourney_signups
  WHERE tourney_id = ? AND removed_at IS NULL ORDER BY signed_up_at, id`;

function summary(state: TourneyState & { count: number }) {
  return { capacity: state.capacity, signups: signupSummary(state.status, state.count, state.capacity) };
}

/** `GET`: every sign-up not removed, with its Discord user. */
async function list(db: D1Database, config: BotSignupConfig, tourneyId: number): Promise<Response> {
  const [state, rows] = await db.batch([
    db.prepare(stateQuery).bind(tourneyId, config.tourneyLobbyCapacity),
    db.prepare(listQuery).bind(tourneyId),
  ]);
  const s = state!.results[0] as (TourneyState & { count: number }) | undefined;
  if (!s) return fail(404, "not_found", "No such tourney");
  return Response.json({ status: s.status, ...summary(s), entries: rows!.results });
}

/**
 * `POST`: signs the Discord users up. Two round trips whatever the number: the state and the rows
 * the names or users already have, then one batch with the claims, the new rows and the re-read.
 */
async function register(request: Request, db: D1Database, config: BotSignupConfig, tourneyId: number, log: Logger, now: Date): Promise<Response> {
  const items = await readItems(request, config);
  if (!Array.isArray(items)) return fail(400, "bad_request", items.error);

  const [stateRes, rowsRes] = await db.batch([
    db.prepare(stateQuery).bind(tourneyId, config.tourneyLobbyCapacity),
    db
      .prepare(
        `SELECT id, name, name_key AS nameKey, discord_user_id AS discordUserId, removed_at IS NOT NULL AS removed FROM tourney_signups
         WHERE tourney_id = ?1 AND (name_key IN (SELECT value FROM json_each(?2)) OR discord_user_id IN (SELECT value FROM json_each(?3)))`,
      )
      .bind(tourneyId, JSON.stringify(items.map((i) => i.nameKey)), JSON.stringify(items.map((i) => i.discordUserId))),
  ]);
  const state = stateRes!.results[0] as TourneyState | undefined;
  if (!state) return fail(404, "not_found", "No such tourney");
  if (state.status !== "scheduled") return fail(409, "closed", "Sign-ups are closed: the tourney has started, ended or been cancelled");

  const rows = rowsRes!.results as unknown as ExistingRow[];
  const byUser = new Map(rows.filter((r) => r.discordUserId !== null).map((r) => [r.discordUserId!, r]));
  const byName = new Map(rows.map((r) => [r.nameKey, r]));
  const planned = new Map<string, BotSignupStatus>();
  const claims: { id: number; discordUserId: string }[] = [];
  const creates: Item[] = [];
  const takenKeys = new Set<string>();
  for (const item of items) {
    const own = byUser.get(item.discordUserId);
    const named = byName.get(item.nameKey);
    let status: BotSignupStatus;
    if (own) status = own.removed ? "removed" : "exists";
    else if (named?.removed) status = "removed";
    else if (named || takenKeys.has(item.nameKey)) {
      status = named && named.discordUserId === null && !takenKeys.has(item.nameKey) ? "linked" : "name_taken";
      if (status === "linked") claims.push({ id: named!.id, discordUserId: item.discordUserId });
    } else if (state.stored + creates.length >= config.tourneySignupsMax) status = "too_many";
    else {
      status = "created";
      creates.push(item);
    }
    takenKeys.add(item.nameKey);
    planned.set(item.discordUserId, status);
  }

  const users = JSON.stringify(items.map((i) => i.discordUserId));
  const [, , mineRes, afterRes] = await db.batch([
    db
      .prepare(
        `UPDATE tourney_signups
         SET discord_user_id = (SELECT json_extract(value, '$.discordUserId') FROM json_each(?2) WHERE json_extract(value, '$.id') = tourney_signups.id)
         WHERE tourney_id = ?1 AND discord_user_id IS NULL AND removed_at IS NULL
           AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`,
      )
      .bind(tourneyId, JSON.stringify(claims)),
    db
      .prepare(
        `INSERT INTO tourney_signups (tourney_id, name, name_key, ip_hash, signed_up_at, discord_user_id)
         SELECT ?1, json_extract(value, '$.name'), json_extract(value, '$.nameKey'), ?3, ?4, json_extract(value, '$.discordUserId')
         FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM tourneys WHERE id = ?1 AND status = 'scheduled')
         ON CONFLICT DO NOTHING`,
      )
      .bind(tourneyId, JSON.stringify(creates), discordIpHash, isoSeconds(now)),
    db
      .prepare(
        `SELECT name, discord_user_id AS discordUserId, signed_up_at AS signedUpAt FROM tourney_signups
         WHERE tourney_id = ?1 AND discord_user_id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(tourneyId, users),
    db.prepare(stateQuery).bind(tourneyId, config.tourneyLobbyCapacity),
  ]);

  const mine = new Map((mineRes!.results as { name: string; discordUserId: string; signedUpAt: string }[]).map((r) => [r.discordUserId, r]));
  const results = items.map((item) => {
    let status = planned.get(item.discordUserId)!;
    const row = mine.get(item.discordUserId);
    // A planned write that didn't land: the list changed between the read and the write.
    if ((status === "created" || status === "linked") && !row) status = "conflict";
    const signedUp = row && status !== "removed" ? { name: row.name, signedUpAt: row.signedUpAt } : null;
    return { discordUserId: item.discordUserId, status, signup: signedUp };
  });
  const written = results.filter((r) => r.status === "created" || r.status === "linked").length;
  if (written) log.info("bot sign-ups", { tourney: tourneyId, written });
  return Response.json({ results, ...summary(afterRes!.results[0] as TourneyState & { count: number }) }, { status: written ? 201 : 200 });
}

/** `DELETE`: the player unregistered in Discord. */
async function unregister(db: D1Database, config: BotSignupConfig, tourneyId: number, discordUserId: string, log: Logger): Promise<Response> {
  const [gone, stateRes] = await db.batch([
    db
      .prepare(
        `DELETE FROM tourney_signups WHERE tourney_id = ?1 AND discord_user_id = ?2 AND removed_at IS NULL
           AND EXISTS (SELECT 1 FROM tourneys WHERE id = ?1 AND status = 'scheduled')
         RETURNING name`,
      )
      .bind(tourneyId, discordUserId),
    db.prepare(stateQuery).bind(tourneyId, config.tourneyLobbyCapacity),
  ]);
  const state = stateRes!.results[0] as (TourneyState & { count: number }) | undefined;
  if (!state) return fail(404, "not_found", "No such tourney");
  const name = (gone!.results[0] as { name: string } | undefined)?.name ?? null;
  if (!name && state.status !== "scheduled") return fail(409, "closed", "Sign-ups are closed: the tourney has started, ended or been cancelled");
  if (name) log.info("bot sign-up removed", { tourney: tourneyId, name });
  return Response.json({ removed: name !== null, name, ...summary(state) });
}

/** The body's sign-ups, checked, or what's wrong with them. */
async function readItems(request: Request, config: BotSignupConfig): Promise<Item[] | { error: string }> {
  const bytes = await readLimited(request, config.botSignupBodyMaxBytes);
  if (!bytes) return { error: `The body is larger than ${config.botSignupBodyMaxBytes} bytes` };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: "The body must be JSON: { signups: [{ discordUserId, name }] }" };
  }
  const signups = (body as { signups?: unknown } | null)?.signups;
  if (!Array.isArray(signups) || !signups.length) return { error: "signups must be a list of { discordUserId, name }" };
  if (signups.length > config.botSignupsPerRequest) return { error: `At most ${config.botSignupsPerRequest} sign-ups at once` };
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const [i, s] of signups.entries()) {
    const { discordUserId, name } = (s ?? {}) as Record<string, unknown>;
    if (typeof discordUserId !== "string" || !snowflake.test(discordUserId)) return { error: `signups[${i}].discordUserId must be a Discord user id` };
    if (seen.has(discordUserId)) return { error: `signups[${i}]: ${discordUserId} is listed twice` };
    seen.add(discordUserId);
    const checked = checkName(name, config);
    if (typeof checked !== "string") return { error: `signups[${i}]: ${checked.error}` };
    items.push({ discordUserId, name: checked, nameKey: nameKey(checked) });
  }
  return items;
}
