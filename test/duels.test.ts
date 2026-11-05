import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/bytes";
import { defaults, loadConfig } from "../src/config";
import { checkDuels, duelStats, type PlayerDuelRow } from "../src/duels/plan";
import { createLogger } from "../src/log";
import { displayRating, duelChange, newRating, rateDuel, type Ratings } from "../src/rating/engine";
import { readState } from "../src/rating/store";
import { recomputeRatings } from "../src/rating/update";
import { adminFetch, adminJson, get, historyTable, hoursAgo, matchLog, playerId, ratingsTable, uploadLog } from "./helpers";

const db = () => env.DB;
const log = createLogger("error");
const adminToken = "admin-token";
const hostToken = "host-token";

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = [
    "admin_actions", "duels", "events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases",
    "players", "admins", "hosts",
  ];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'eu host', ?, 'trusted', 'eu')").bind(await sha256(hostToken)),
  ]);
});

const admin = <T = Record<string, unknown>>(path: string, body?: unknown, status?: number) => adminJson<T>(adminToken, path, body, undefined, status);
const duel = (winner: string, loser: string, winnerScore = 15, loserScore = 10) => ({ winner, loser, winnerScore, loserScore });

interface Saved {
  duels: { id: number; rated: boolean; winnerBefore: number; winnerAfter: number; loserBefore: number; loserAfter: number }[];
  newPlayers: string[];
  ratingsStale: boolean;
}

async function save(region: string, duels: unknown[], newPlayers: string[] = []): Promise<Saved> {
  return admin<Saved>("duels", { region, duels, newPlayers }, 201);
}

const display = async (name: string) =>
  (await db().prepare("SELECT display FROM ratings WHERE player_id = ? AND board = 'eu'").bind(await playerId(name)).first<{ display: number }>())?.display;

describe("duelChange", () => {
  it("gives equal ratings 15-10 about ten each way", () => {
    expect(duelChange(1500, 1500, 15, 10, defaults)).toEqual({ gain: 10, loss: 10 });
  });

  it("gives the winner at least duelMinGain, and the loser only the normal loss", () => {
    // 2200 beats 1900 15-14: about 4 either way, so the winner gets the minimum 5.
    expect(duelChange(2200, 1900, 15, 14, defaults)).toEqual({ gain: 5, loss: 4 });
  });

  it("never moves more than duelMaxChange", () => {
    expect(duelChange(1900, 2200, 15, 0, defaults)).toEqual({ gain: 25, loss: 25 });
  });

  it("gives a bigger margin more", () => {
    const close = duelChange(1500, 1500, 15, 14, defaults);
    const wide = duelChange(1500, 1500, 15, 3, defaults);
    expect(wide.gain).toBeGreaterThan(close.gain);
  });
});

describe("rateDuel", () => {
  const playedAt = "2026-11-05T12:00:00Z";
  const match = { id: 1, playedAt, rounds: [], tournament: false };

  it("moves the two displays by the change, and leaves sigma, rounds and streaks", () => {
    const ratings: Ratings = new Map([
      [1, newRating(defaults, playedAt)],
      [2, newRating(defaults, playedAt)],
    ]);
    ratings.get(1)!.rounds = 7;
    const before = { a: displayRating(ratings.get(1)!, defaults), b: displayRating(ratings.get(2)!, defaults), sigma: ratings.get(1)!.sigma };
    const history = rateDuel(ratings, match, { winner: 1, loser: 2, winnerScore: 15, loserScore: 10, rated: true }, defaults);
    expect(history.map((h) => h.playerId).sort()).toEqual([1, 2]);
    const after = { a: displayRating(ratings.get(1)!, defaults), b: displayRating(ratings.get(2)!, defaults) };
    expect(after.a).toBeGreaterThan(before.a);
    expect(after.b).toBeLessThanOrEqual(before.b);
    expect(ratings.get(1)!.sigma).toBe(before.sigma);
    expect(ratings.get(1)!.rounds).toBe(7);
  });

  it("changes nothing for a duel that isn't rated", () => {
    const ratings: Ratings = new Map();
    expect(rateDuel(ratings, match, { winner: 1, loser: 2, winnerScore: 15, loserScore: 10, rated: false }, defaults)).toEqual([]);
    expect(ratings.size).toBe(0);
  });

  it("never takes a loser below the floor", () => {
    const ratings: Ratings = new Map([
      [1, newRating(defaults, playedAt)],
      [2, newRating(defaults, playedAt)],
    ]);
    for (let i = 0; i < 40; i++) rateDuel(ratings, match, { winner: 1, loser: 2, winnerScore: 15, loserScore: 0, rated: true }, defaults);
    expect(displayRating(ratings.get(2)!, defaults)).toBeGreaterThanOrEqual(defaults.displayFloor);
  });
});

describe("checkDuels", () => {
  it("takes a list of duels", () => {
    expect(checkDuels([duel("A", "B")], defaults)).toEqual([duel("A", "B")]);
  });

  it("refuses a draw, a loser ahead, a self duel and an empty list", () => {
    expect(checkDuels([duel("A", "B", 10, 10)], defaults)).toBeTypeOf("string");
    expect(checkDuels([duel("A", "B", 10, 15)], defaults)).toBeTypeOf("string");
    expect(checkDuels([duel("Nachos", "nachos")], defaults)).toBeTypeOf("string");
    expect(checkDuels([], defaults)).toBeTypeOf("string");
  });
});

describe("duelStats", () => {
  const row = (id: number, won: boolean, opponent: number, score: number, opponentScore: number, change: number): PlayerDuelRow => ({
    id,
    playedAt: `2026-11-05T12:00:${String(60 - id).padStart(2, "0")}Z`,
    won,
    score,
    opponentScore,
    opponent: { id: opponent, name: `P${opponent}` },
    ratingBefore: 1000,
    ratingAfter: 1000 + change,
  });

  it("sums the record and finds who they beat most and who beat them most", () => {
    // Newest first.
    const s = duelStats([row(1, true, 2, 15, 3, 12), row(2, true, 2, 15, 9, 8), row(3, false, 3, 12, 15, -9), row(4, true, 3, 15, 14, 5)], 30);
    expect(s).toMatchObject({ wins: 3, losses: 1, score: 57, opponentScore: 41, ratingChange: 16, streak: { won: true, length: 2 } });
    expect(s.beatMost).toMatchObject({ id: 2, wins: 2, losses: 0, change: 20 });
    expect(s.beatenByMost).toMatchObject({ id: 3, wins: 1, losses: 1 });
    expect(s.bestWin).toMatchObject({ id: 1, score: 15, opponentScore: 3 });
  });
});

describe("admin duels", () => {
  it("previews without writing, and refuses an unknown name unless it's added", async () => {
    await uploadLog(matchLog(), hostToken, hoursAgo(2));
    const preview = await admin<{ duels: { rated: boolean }[]; newPlayers: string[] }>("duels/preview", { region: "eu", duels: [duel("Alpha", "Nachos")] });
    expect(preview.newPlayers).toEqual(["Nachos"]);
    expect(preview.duels[0]!.rated).toBe(true);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM duels").first()).toEqual({ n: 0 });
    expect((await adminFetch(adminToken, "duels", { region: "eu", duels: [duel("Alpha", "Nachos")] })).status).toBe(409);
  });

  it("saves duels, rates them, and lists them on the Duels tab and the player's stats", async () => {
    await uploadLog(matchLog(), hostToken, hoursAgo(2));
    const alpha = await display("Alpha");
    const res = await save("eu", [duel("Alpha", "Nachos", 15, 12), duel("Bravo", "Alpha", 15, 3)], ["Nachos"]);
    expect(res.ratingsStale).toBe(false);
    expect(res.duels).toHaveLength(2);
    // The new player starts where a new EU player does, and keeps the name as their alias.
    const nachos = await playerId("Nachos");
    expect(await db().prepare("SELECT name_key FROM aliases WHERE player_id = ?").bind(nachos).first()).toEqual({ name_key: "nachos" });
    const first = res.duels[0]!;
    expect(first.winnerBefore).toBe(alpha);
    expect(await display("Alpha")).toBe(res.duels[1]!.loserAfter);

    const list = await get<{ duels: { id: number; winner: { name: string }; winnerScore: number; loserScore: number }[]; hasMore: boolean }>("duels?region=eu");
    expect(list.duels.map((d) => [d.winner.name, d.winnerScore, d.loserScore])).toEqual([
      ["Bravo", 15, 3],
      ["Alpha", 15, 12],
    ]);
    const stats = await get<{ duels: number; wins: number; losses: number; score: number; opponentScore: number }>(`players/${await playerId("Alpha")}/duels?region=eu`);
    expect(stats).toMatchObject({ duels: 2, wins: 1, losses: 1, score: 18, opponentScore: 27 });
    const vs = await get<{ duels: number }>(`players/${await playerId("Alpha")}/duels?region=eu&vs=${nachos}`);
    expect(vs.duels).toBe(1);
    // Other regions don't see them.
    expect((await get<{ duels: unknown[] }>("duels?region=na")).duels).toEqual([]);
  });

  it("keeps duels out of matches, the feed, records and match pages", async () => {
    await uploadLog(matchLog(), hostToken, hoursAgo(2));
    const res = await save("eu", [duel("Alpha", "Bravo")]);
    const id = res.duels[0]!.id;
    expect((await get<{ matches: { id: number }[] }>("recent?region=eu")).matches.map((m) => m.id)).not.toContain(id);
    expect((await get<{ matches: { id: number }[] }>(`players/${await playerId("Alpha")}/matches?region=eu`)).matches.map((m) => m.id)).not.toContain(id);
    await get(`matches/${id}?region=eu`, 404);
    expect(await db().prepare("SELECT feed_seq FROM matches WHERE id = ?").bind(id).first()).toEqual({ feed_seq: null });
    // The history marks the point as a duel.
    const history = await get<{ points: { matchId: number; duel?: boolean }[] }>(`players/${await playerId("Alpha")}/history?region=eu`);
    expect(history.points.find((p) => p.matchId === id)?.duel).toBe(true);
    // The duel host isn't listed with the hosts.
    const hosts = await admin<{ hosts: { name: string }[] }>("hosts");
    expect(hosts.hosts.map((h) => h.name)).not.toContain("Duels (entered by admins)");
  });

  it("rates only the first duelPairDailyRatedLimit duels of a pair a day", async () => {
    await uploadLog(matchLog(), hostToken, hoursAgo(2));
    const limit = defaults.duelPairDailyRatedLimit;
    const res = await save("eu", Array.from({ length: limit + 1 }, () => duel("Alpha", "Bravo")));
    expect(res.duels.map((d) => d.rated)).toEqual([...Array(limit).fill(true), false]);
    const again = await save("eu", [duel("Bravo", "Alpha"), duel("Alpha", "Charlie")]);
    expect(again.duels.map((d) => d.rated)).toEqual([false, true]);
  });

  it("keeps duels through a recompute, and undo re-rates without them", async () => {
    await uploadLog(matchLog(), hostToken, hoursAgo(2));
    const before = { ratings: await ratingsTable(), history: await historyTable() };
    const res = await save("eu", [duel("Alpha", "Bravo", 15, 2)]);
    const rated = { ratings: await ratingsTable(), history: await historyTable() };
    expect(rated.ratings).not.toEqual(before.ratings);

    const config = loadConfig(env);
    await db().prepare("UPDATE rating_state SET stale_played_at = '', stale_match_id = 0, stale_since = '2026-01-01T00:00:00Z' WHERE board = 'eu'").run();
    while (!(await recomputeRatings(db(), config, new Date(), log, "eu")).done);
    expect({ ratings: await ratingsTable(), history: await historyTable() }).toEqual(rated);

    await admin(`matches/${res.duels[0]!.id}/void`, { reason: "Duel undone" });
    while (!(await recomputeRatings(db(), config, new Date(), log, "eu")).done);
    expect((await readState(db(), "eu")).staleFrom).toBeNull();
    expect({ ratings: await ratingsTable(), history: await historyTable() }).toEqual(before);
    expect((await get<{ duels: unknown[] }>("duels?region=eu")).duels).toEqual([]);
  });

  it("refuses a duel as a tournament", async () => {
    const res = await save("eu", [duel("Alpha", "Bravo")], ["Alpha", "Bravo"]);
    expect((await adminFetch(adminToken, `matches/${res.duels[0]!.id}/tournament`, { tournament: true })).status).toBe(409);
  });
});
