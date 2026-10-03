import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { handleSite } from "../src/site/handler";
import { nextTier, standing } from "../src/site/standing";
import { sha256 } from "../src/upload/handler";
import { matchId, matchLog } from "./helpers";

const db = () => env.DB;
const token = "trusted-token";
const players = ["Alpha", "Bravo", "Charlie", "Delta"];

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = ["events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts"];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust) VALUES (1, 'trusted', ?, 'trusted')").bind(await sha256(token)),
  ]);
});

let played = 0;
beforeEach(() => {
  played = 0;
});

/**
 * Uploads `count` complete matches (2 rated rounds each), keys 000000000001 on, an hour apart and
 * ending recently, so no one is inactive. Rated on upload.
 */
async function playMatches(count: number) {
  for (let i = 0; i < count; i++) {
    played += 1;
    const key = String(played).padStart(12, "0");
    const startedAt = new Date(Date.now() - (24 - played) * 60 * 60 * 1000).toISOString();
    const res = await SELF.fetch("https://example.com/api/upload", {
      method: "POST",
      body: matchLog({ key }),
      headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": startedAt },
    });
    expect(res.status).toBe(200);
  }
}

async function get<T = Record<string, unknown>>(path: string): Promise<T> {
  const res = await SELF.fetch(`https://example.com/api/${path}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function playerId(name: string): Promise<number> {
  return (await db().prepare("SELECT id FROM players WHERE name = ?").bind(name).first<{ id: number }>())!.id;
}

interface Board {
  page: number;
  hasMore: boolean;
  players: { rank: number; id: number; name: string; rating: number; rounds: number; wins: number; inactiveSince: string | null }[];
}

describe("standing", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  const config = { ...defaults, minRankedRounds: 10, inactiveAfterDays: 30 };

  it("gives the tier only from minRankedRounds rated rounds", () => {
    expect(standing({ display: 1700, rounds: 9, lastPlayedAt: null }, config, now).tier).toBeNull();
    expect(standing({ display: 1700, rounds: 10, lastPlayedAt: null }, config, now).tier).toEqual({ label: "Grandmaster", color: [255, 140, 0], threshold: 1600 });
    expect(standing({ display: 1299, rounds: 10, lastPlayedAt: null }, config, now).tier).toBeNull();
  });

  it("gives the next tier up, none at the top", () => {
    expect(nextTier(0, config.tiers)).toEqual({ label: "Master", color: [255, 215, 0], threshold: 1300 });
    expect(nextTier(1600, config.tiers)?.label).toBe("Ascendant");
    expect(nextTier(1599, config.tiers)?.label).toBe("Grandmaster");
    expect(nextTier(2600, config.tiers)).toBeNull();
  });

  it("marks a player inactive after inactiveAfterDays, since their last match", () => {
    const at = (lastPlayedAt: string) => standing({ display: 1000, rounds: 10, lastPlayedAt }, config, now).inactiveSince;
    expect(at("2026-09-03T00:00:00Z")).toBeNull();
    expect(at("2026-09-02T23:59:59Z")).toBe("2026-09-02T23:59:59Z");
  });
});

describe("leaderboard", () => {
  it("lists players once they have minRankedRounds rated rounds, best first", async () => {
    await playMatches(defaults.minRankedRounds / 2 - 1);
    expect((await get<Board>("leaderboard")).players).toEqual([]);

    await playMatches(1);
    const res = await SELF.fetch("https://example.com/api/leaderboard");
    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.publicCacheSeconds}`);
    const board = (await res.json()) as Board;
    expect(board.page).toBe(1);
    expect(board.hasMore).toBe(false);
    expect(board.players.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
    expect(board.players.map((p) => p.name).sort()).toEqual([...players].sort());
    const ratings = board.players.map((p) => p.rating);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
    expect(board.players.every((p) => p.rounds === defaults.minRankedRounds && p.inactiveSince === null)).toBe(true);
  });

  it("keeps inactive players on the board, marked", async () => {
    await playMatches(defaults.minRankedRounds / 2);
    const alpha = await playerId("Alpha");
    await db().prepare("UPDATE ratings SET last_played_at = '2020-01-01T00:00:00Z' WHERE player_id = ?").bind(alpha).run();
    const board = await get<Board>("leaderboard");
    expect(board.players).toHaveLength(4);
    expect(board.players.find((p) => p.id === alpha)!.inactiveSince).toBe("2020-01-01T00:00:00Z");
  });

  it("pages, and ranks across pages", async () => {
    await playMatches(defaults.minRankedRounds / 2);
    const config = { ...defaults, leaderboardPageSize: 3 };
    const page = async (n: string | null) => {
      const res = await handleSite(new Request(`https://example.com/api/leaderboard${n ? `?page=${n}` : ""}`), db(), config);
      return (await res!.json()) as Board;
    };
    const first = await page(null);
    expect(first.players.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(first.hasMore).toBe(true);
    const second = await page("2");
    expect(second.players.map((p) => p.rank)).toEqual([4]);
    expect(second.hasMore).toBe(false);
    expect((await page("nonsense")).page).toBe(1);
  });

  it("only answers GET", async () => {
    const res = await SELF.fetch("https://example.com/api/leaderboard", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("player", () => {
  it("has the rating, rank, aliases and recent matches with the rating change", async () => {
    await playMatches(defaults.minRankedRounds / 2);
    const alpha = await playerId("Alpha");
    const { player, matches } = await get<{
      player: { id: number; name: string; aliases: string[]; rating: { rank: number; rating: number; rounds: number; wins: number; nextTier: { label: string } | null } };
      matches: { id: number; ratingBefore: number | null; ratingAfter: number | null; void: boolean; legacy: boolean }[];
    }>(`players/${alpha}`);

    expect(player).toMatchObject({ id: alpha, name: "Alpha", aliases: ["Alpha"] });
    expect(player.rating).toMatchObject({ rounds: defaults.minRankedRounds, wins: defaults.minRankedRounds / 2 });
    const board = await get<Board>("leaderboard");
    expect(player.rating.rank).toBe(board.players.find((p) => p.id === alpha)!.rank);
    expect(player.rating.nextTier).toEqual(nextTier(player.rating.rating, defaults.tiers));

    expect(matches).toHaveLength(defaults.minRankedRounds / 2);
    expect(matches[0]!.id).toBeGreaterThan(matches[1]!.id);
    expect(matches.at(-1)!.ratingBefore).toBeNull();
    expect(matches[0]!.ratingBefore).toBe(matches[1]!.ratingAfter);
    expect(matches[0]!.ratingAfter).toBe(player.rating.rating);
  });

  it("has no rank below minRankedRounds", async () => {
    await playMatches(1);
    const { player } = await get<{ player: { rating: { rank: number | null; rounds: number } } }>(`players/${await playerId("Alpha")}`);
    expect(player.rating).toMatchObject({ rank: null, rounds: 2 });
  });

  it("leaves out matches that aren't public", async () => {
    await playMatches(1);
    await db().prepare("UPDATE matches SET status = 'review'").run();
    const { matches } = await get<{ matches: unknown[] }>(`players/${await playerId("Alpha")}`);
    expect(matches).toEqual([]);
  });

  it("is a 404 for an unknown or malformed id", async () => {
    expect((await SELF.fetch("https://example.com/api/players/999")).status).toBe(404);
    expect((await SELF.fetch("https://example.com/api/players/abc")).status).toBe(404);
  });
});

describe("match", () => {
  type MatchBody = {
    match: {
      id: number;
      void: boolean;
      complete: boolean;
      players: { id: number; name: string; rounds: number; wins: number; ratingBefore: number | null; ratingAfter: number | null }[];
      rounds: { number: number; result: string; rated: boolean; winner: number | null; placements: { playerId: number; name: string; position: number | null; left: boolean }[] }[];
    };
  };

  it("has the players, the rounds and their finishing order, in player ids", async () => {
    await playMatches(1);
    const id = await matchId("000000000001");
    const ids = Object.fromEntries(await Promise.all(players.map(async (n) => [n, await playerId(n)] as const)));
    const { match } = await get<MatchBody>(`matches/${id}`);

    expect(match).toMatchObject({ id, void: false, complete: true });
    expect(match.rounds.map((r) => [r.number, r.result, r.rated, r.winner])).toEqual([
      [1, "WIN", true, ids.Alpha],
      [2, "WIN", true, ids.Bravo],
    ]);
    // matchLog: the first one out finishes last.
    expect(match.rounds[0]!.placements.map((p) => p.name)).toEqual(["Alpha", "Delta", "Charlie", "Bravo"]);
    expect(match.rounds[1]!.placements.map((p) => p.name)).toEqual(["Bravo", "Delta", "Charlie", "Alpha"]);
    expect(match.rounds[1]!.placements.map((p) => p.position)).toEqual([1, 2, 3, 4]);

    const alpha = match.players.find((p) => p.name === "Alpha")!;
    expect(alpha).toMatchObject({ id: ids.Alpha, rounds: 2, wins: 1, ratingBefore: null });
    expect(alpha.ratingAfter).toEqual(expect.any(Number));
  });

  it("marks a void match, and hides one in review", async () => {
    await playMatches(2);
    const [first, second] = [await matchId("000000000001"), await matchId("000000000002")];
    await db().prepare("UPDATE matches SET status = 'void' WHERE id = ?").bind(first).run();
    await db().prepare("UPDATE matches SET status = 'review' WHERE id = ?").bind(second).run();
    expect((await get<MatchBody>(`matches/${first}`)).match.void).toBe(true);
    expect((await SELF.fetch(`https://example.com/api/matches/${second}`)).status).toBe(404);
  });
});

describe("pages", () => {
  it.each([
    ["/", "data-page=\"leaderboard\""],
    ["/player?id=1", "data-page=\"player\""],
    ["/match?id=1", "data-page=\"match\""],
  ])("serves %s", async (path, marker) => {
    const res = await SELF.fetch(`https://example.com${path}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(marker);
  });
});
