import { env } from "cloudflare:test";
import { expect } from "vitest";
import { defaults } from "../src/config";
import { displayRating, recompute, type RatingMatch } from "../src/rating/engine";
import { readRounds, readState } from "../src/rating/store";

/** Helpers for the tests that check ratings in D1. */

const db = () => env.DB;

/** A 4-player match of two rounds: `players[0]` wins round 1, `players[1]` round 2. */
export function matchLog({ key = "000000000001", players = ["Alpha", "Bravo", "Charlie", "Delta"], rounds = 2, end = true } = {}): string {
  const lines = [`GBR|1.00|1|1.3.3R|${key}`, "MATCH_START|1.00|workshop-island-night|Default|0|"];
  players.forEach((name, i) => lines.push(`JOIN|1.00|${i + 1}|${name}`));
  lines.push("ROUND_START|2.00|1|1,2,3,4", "ELIM|3.00|1|2|1|4", "ELIM|4.00|1|3|1|3", "ELIM|5.00|1|4|1|2", "ROUND_END|5.00|1|1|WIN");
  if (rounds >= 2) {
    lines.push("ROUND_START|6.00|2|1,2,3,4", "ELIM|7.00|2|1|2|4", "ELIM|8.00|2|3|2|3", "ELIM|9.00|2|4|2|2", "ROUND_END|9.00|2|2|WIN");
  }
  if (end) lines.push("MATCH_END|10.00|TIME");
  return lines.map((line) => `[00:00:01] ${line}`).join("\r\n");
}

export async function matchId(key: string): Promise<number> {
  return (await db().prepare("SELECT id FROM matches WHERE match_key = ?").bind(key).first<{ id: number }>())!.id;
}

export async function ratingsTable() {
  const { results } = await db()
    .prepare("SELECT player_id AS playerId, mu, sigma, display, rounds, wins, last_played_at AS lastPlayedAt FROM ratings ORDER BY player_id")
    .all();
  return results;
}

export async function historyTable() {
  const { results } = await db()
    .prepare(
      `SELECT player_id AS playerId, match_id AS matchId, played_at AS playedAt, mu, sigma, display, rounds, wins
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
  const matches: RatingMatch[] = results.map((m) => ({ ...m, rounds: rounds.get(m.id)!, tournament: m.tournament === 1 }));
  const { ratings, history } = recompute(matches, defaults);
  return {
    ratings: [...ratings]
      .sort(([a], [b]) => a - b)
      .map(([playerId, r]) => ({ playerId, mu: r.mu, sigma: r.sigma, display: displayRating(r, defaults), rounds: r.rounds, wins: r.wins, lastPlayedAt: r.lastPlayedAt })),
    history: [...history].sort((a, b) => (a.playedAt === b.playedAt ? a.matchId - b.matchId || a.playerId - b.playerId : a.playedAt < b.playedAt ? -1 : 1)),
  };
}

export async function expectUpToDate() {
  const expected = await fromScratch();
  expect(await ratingsTable()).toEqual(expected.ratings);
  expect(await historyTable()).toEqual(expected.history);
  expect((await readState(db(), "eu")).staleFrom).toBeNull();
}

