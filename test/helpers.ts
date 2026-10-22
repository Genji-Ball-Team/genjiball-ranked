import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { queryBudget } from "../src/budget";
import { defaults } from "../src/config";
import { displayRating, recompute, type RatingMatch } from "../src/rating/engine";
import { readKills, readRounds, readState } from "../src/rating/store";
import { hourMs } from "../src/time";
import type { UploadResponse } from "../src/upload/handler";

/** Helpers for the tests: uploads, admin requests, and checking ratings in D1. */

const db = () => env.DB;

/** `hours` ago, in ISO 8601: an upload's `X-Log-Started-At`. */
export const hoursAgo = (hours: number) => new Date(Date.now() - hours * hourMs).toISOString();

/** `POST /api/upload` as the token's host, expecting a 200. `startedAt` is `X-Log-Started-At`. */
export async function uploadLog(body: string, token: string, startedAt?: string, headers: Record<string, string> = {}): Promise<UploadResponse> {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, ...(startedAt === undefined ? {} : { "X-Log-Started-At": startedAt }), ...headers },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

/** An admin request, `/api/admin/<path>`: `GET` without a body, else `POST` with it as JSON. No token with `null`. */
export function adminFetch(token: string | null, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return SELF.fetch(`https://example.com/api/admin/${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** `adminFetch`, expecting `status`, else any 2xx: the answer's JSON. */
export async function adminJson<T = Record<string, unknown>>(token: string | null, path: string, body?: unknown, method?: string, status?: number): Promise<T> {
  const res = await adminFetch(token, path, body, method);
  if (status === undefined) expect(res.status, await res.clone().text()).toBeLessThan(300);
  else expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
}

/**
 * A 4-player match of two rounds: `players[0]` wins round 1, `players[1]` round 2. `host`: the
 * index of the lobby host in `players` (`JOIN` `host` `1`), none if left out.
 */
export function matchLog({ key = "000000000001", players = ["Alpha", "Bravo", "Charlie", "Delta"], rounds = 2, end = true, host = -1 } = {}): string {
  const lines = [`GBR|1.00|1|1.3.3R|${key}`, "MATCH_START|1.00|workshop-island-night|Default|0|"];
  players.forEach((name, i) => lines.push(`JOIN|1.00|${i + 1}|${name}|${i === host ? "1" : ""}`));
  lines.push("ROUND_START|2.00|1|1,2,3,4", "ELIM|3.00|1|2|1|4", "ELIM|4.00|1|3|1|3", "ELIM|5.00|1|4|1|2", "ROUND_END|5.00|1|1|WIN");
  if (rounds >= 2) {
    lines.push("ROUND_START|6.00|2|1,2,3,4", "ELIM|7.00|2|1|2|4", "ELIM|8.00|2|3|2|3", "ELIM|9.00|2|4|2|2", "ROUND_END|9.00|2|2|WIN");
  }
  if (end) lines.push("MATCH_END|10.00|TIME");
  return lines.map((line) => `[00:00:01] ${line}`).join("\r\n");
}

/** GETs `/api/<path>` and returns the JSON, after checking the status. */
export async function get<T = Record<string, unknown>>(path: string, status = 200): Promise<T> {
  const res = await SELF.fetch(`https://example.com/api/${path}`);
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
}

export async function playerId(name: string): Promise<number> {
  return (await db().prepare("SELECT id FROM players WHERE name = ?").bind(name).first<{ id: number }>())!.id;
}

export async function matchId(key: string): Promise<number> {
  return (await db().prepare("SELECT id FROM matches WHERE match_key = ?").bind(key).first<{ id: number }>())!.id;
}

export async function ratingsTable() {
  const { results } = await db()
    .prepare(
      "SELECT player_id AS playerId, mu, sigma, display, rounds, wins, streak, best_streak AS bestStreak, last_played_at AS lastPlayedAt FROM ratings ORDER BY player_id",
    )
    .all();
  return results;
}

export async function historyTable() {
  const { results } = await db()
    .prepare(
      `SELECT player_id AS playerId, match_id AS matchId, played_at AS playedAt, mu, sigma, display, rounds, wins,
         streak, best_streak AS bestStreak
       FROM rating_history ORDER BY played_at, match_id, player_id`,
    )
    .all();
  return results;
}

/** What a recompute from scratch over the stored matches that count gives. */
export async function fromScratch() {
  const { results } = await db()
    .prepare("SELECT id, played_at AS playedAt, tournament FROM matches WHERE status = 'accepted' ORDER BY played_at, id")
    .all<{ id: number; playedAt: string; tournament: number }>();
  const rounds = await readRounds(db(), results.map((m) => m.id));
  const kills = await readKills(db(), results.map((m) => ({ ...m, complete: true, rated: true, tournament: m.tournament === 1 })));
  const matches: RatingMatch[] = results.map((m) => ({
    ...m,
    rounds: rounds.get(m.id)!,
    tournament: m.tournament === 1,
    ...(m.tournament === 1 ? { kills: kills.get(m.id) ?? new Map() } : {}),
  }));
  const { ratings, history } = recompute(matches, defaults);
  return {
    ratings: [...ratings]
      .sort(([a], [b]) => a - b)
      .map(([playerId, r]) => ({ playerId, mu: r.mu, sigma: r.sigma, display: displayRating(r, defaults), rounds: r.rounds, wins: r.wins, streak: r.streak, bestStreak: r.bestStreak, lastPlayedAt: r.lastPlayedAt })),
    history: [...history].sort((a, b) => (a.playedAt === b.playedAt ? a.matchId - b.matchId || a.playerId - b.playerId : a.playedAt < b.playedAt ? -1 : 1)),
  };
}

export async function expectUpToDate() {
  const expected = await fromScratch();
  expect(await ratingsTable()).toEqual(expected.ratings);
  expect(await historyTable()).toEqual(expected.history);
  expect((await readState(db(), "eu")).staleFrom).toBeNull();
}


/**
 * A D1 binding that counts queries the way D1 does for the per-invocation limit: one per `first`,
 * `all`, `run` or `raw`, and one per statement of a batch (`queryBudget` without a limit).
 */
export function countingDb(real: D1Database): { db: D1Database; queries: () => number } {
  const budget = queryBudget(real, Infinity);
  return { db: budget.db, queries: budget.used };
}
