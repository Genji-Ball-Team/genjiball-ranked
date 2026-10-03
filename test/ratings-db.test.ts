import { createScheduledController, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import worker from "../src/index";
import { createLogger } from "../src/log";
import { readState } from "../src/rating/store";
import { markAllStale, markMatchesChanged, rateNewMatches, recomputeRatings } from "../src/rating/update";
import { sha256, type UploadResponse } from "../src/upload/handler";
import { expectUpToDate, historyTable, matchId, matchLog, ratingsTable } from "./helpers";

const db = () => env.DB;
const log = createLogger("error");
const token = "trusted-token";

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = ["events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts"];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust) VALUES (1, 'host', ?, 'trusted')").bind(await sha256(token)),
  ]);
});

async function upload(body: string, startedAt: string): Promise<UploadResponse> {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": startedAt },
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function recomputeUntilDone(budget = defaults.ratingMatchesPerRun): Promise<number> {
  let runs = 0;
  for (;;) {
    runs++;
    const result = await recomputeRatings(db(), defaults, new Date(), log, budget);
    if (result.done) return runs;
    expect(runs).toBeLessThan(100);
  }
}

/** A database that counts the statements of every batch, to check what a recompute writes. */
function counting() {
  const batches: number[] = [];
  const proxy = new Proxy(db(), {
    get(target, prop) {
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          batches.push(statements.length);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, batches };
}

const others = ["Echo", "Foxtrot", "Golf", "Hotel"];

describe("ratings: new matches", () => {
  it("rates an accepted, complete match as it's uploaded", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    expect(await ratingsTable()).toHaveLength(4);
    expect(await historyTable()).toHaveLength(4);
    const match = await db().prepare("SELECT rated_at FROM matches").first<{ rated_at: string | null }>();
    expect(match!.rated_at).not.toBeNull();
    await expectUpToDate();
  });

  it("rates each newer match on top, the same as a recompute", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    await upload(matchLog({ key: "000000000002", players: ["Bravo", "Alpha", "Echo", "Delta"] }), "2026-09-02T20:00:00Z");
    await upload(matchLog({ key: "000000000003" }), "2026-09-03T20:00:00Z");
    expect(await historyTable()).toHaveLength(12);
    await expectUpToDate();
  });

  it("doesn't rate a rejected match", async () => {
    await upload(matchLog().replace("JOIN|1.00|4|Delta", "JOIN|1.00|4|Delta\r\n[00:00:01] UNRANKED|1.00|BOT"), "2026-09-01T20:00:00Z");
    expect(await ratingsTable()).toEqual([]);
    expect((await readState(db())).staleFrom).toBeNull();
  });

  it("marks the ratings stale for a late upload, and the recompute puts it in its place", async () => {
    await upload(matchLog(), "2026-09-02T20:00:00Z");
    await upload(matchLog({ key: "000000000002", players: ["Bravo", "Alpha", "Echo", "Delta"] }), "2026-09-01T20:00:00Z");
    const late = await matchId("000000000002");
    expect(await historyTable()).toHaveLength(4);
    expect((await readState(db())).staleFrom).toEqual({ id: late, playedAt: "2026-09-01T20:00:00Z" });

    await recomputeUntilDone();
    await expectUpToDate();
    const rated = await db().prepare("SELECT count(*) AS n FROM matches WHERE rated_at IS NOT NULL").first<{ n: number }>();
    expect(rated!.n).toBe(2);
  });

  it("keeps rating newer matches while the ratings are stale", async () => {
    await upload(matchLog(), "2026-09-02T20:00:00Z");
    await upload(matchLog({ key: "000000000002", players: others }), "2026-09-01T20:00:00Z");
    await upload(matchLog({ key: "000000000003" }), "2026-09-03T20:00:00Z");
    expect(await historyTable()).toHaveLength(8);
    await recomputeUntilDone();
    await expectUpToDate();
  });
});

describe("ratings: incomplete matches", () => {
  it("rates a match with no MATCH_END once its grace period has passed", async () => {
    const started = new Date(Date.now() - 60 * 60 * 1000);
    await upload(matchLog({ end: false }), started.toISOString());
    expect(await ratingsTable()).toEqual([]);

    const beforeGrace = new Date(started.getTime() + (defaults.ratingIncompleteGraceHours - 0.5) * 3600_000);
    expect(await rateNewMatches(db(), defaults, beforeGrace, log)).toMatchObject({ rated: 0 });
    const afterGrace = new Date(started.getTime() + (defaults.ratingIncompleteGraceHours + 0.5) * 3600_000);
    expect(await rateNewMatches(db(), defaults, afterGrace, log)).toMatchObject({ rated: 1 });
    expect(await ratingsTable()).toHaveLength(4);
  });

  it("rates an incomplete match uploaded after its grace period straight away", async () => {
    await upload(matchLog({ end: false }), "2026-09-01T20:00:00Z");
    expect(await ratingsTable()).toHaveLength(4);
  });
});

describe("ratings: changed matches", () => {
  it("marks the ratings stale when a longer copy replaces a rated match", async () => {
    await upload(matchLog({ rounds: 1, end: false }), "2026-09-01T20:00:00Z");
    await upload(matchLog({ key: "000000000002", players: others }), "2026-09-02T20:00:00Z");
    expect(await historyTable()).toHaveLength(8);
    expect((await readState(db())).staleFrom).toBeNull();

    await upload(matchLog(), "2026-09-01T20:00:00Z");
    expect((await readState(db())).staleFrom).toEqual({ id: await matchId("000000000001"), playedAt: "2026-09-01T20:00:00Z" });
    await recomputeUntilDone();
    await expectUpToDate();
    const alpha = await db().prepare("SELECT rounds FROM ratings r JOIN players p ON p.id = r.player_id WHERE p.name = 'Alpha'").first();
    expect(alpha).toEqual({ rounds: 2 });
  });

  it("takes a voided match out, and the rating of a player who only played in it", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    await upload(matchLog({ key: "000000000002", players: ["Alpha", "Bravo", "Charlie", "Echo"] }), "2026-09-02T20:00:00Z");
    await upload(matchLog({ key: "000000000003" }), "2026-09-03T20:00:00Z");
    expect(await ratingsTable()).toHaveLength(5);

    const voided = await matchId("000000000002");
    await db().prepare("UPDATE matches SET status = 'void' WHERE id = ?").bind(voided).run();
    await markMatchesChanged(db(), [voided], new Date());
    await recomputeUntilDone();
    await expectUpToDate();
    expect(await ratingsTable()).toHaveLength(4);
    const match = await db().prepare("SELECT rated_at FROM matches WHERE id = ?").bind(voided).first();
    expect(match).toEqual({ rated_at: null });
  });

  it("writes only the rows that changed", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    await upload(matchLog({ key: "000000000002", players: others }), "2026-09-02T20:00:00Z");
    await upload(matchLog({ key: "000000000003" }), "2026-09-03T20:00:00Z");

    // Nothing changed: the recompute writes no history and no ratings, only its own state.
    await markAllStale(db(), new Date());
    const unchanged = counting();
    await recomputeRatings(unchanged.db, defaults, new Date(), log);
    expect(unchanged.batches).toEqual([2]);
    await expectUpToDate();

    // A late match of the others' players leaves Alpha's matches alone.
    const before = await historyTable();
    await upload(matchLog({ key: "000000000004", players: others }), "2026-09-01T21:00:00Z");
    await recomputeUntilDone();
    await expectUpToDate();
    const after = await historyTable();
    const alphaMatches = [await matchId("000000000001"), await matchId("000000000003")];
    expect(after.filter((row) => alphaMatches.includes(row.matchId as number))).toEqual(
      before.filter((row) => alphaMatches.includes(row.matchId as number)),
    );
  });

  it("spreads a long recompute over several runs", async () => {
    for (let i = 1; i <= 5; i++) {
      const players = i % 2 ? ["Alpha", "Bravo", "Charlie", "Delta"] : ["Delta", "Echo", "Alpha", "Foxtrot"];
      await upload(matchLog({ key: `00000000000${i}`, players }), `2026-09-0${i}T20:00:00Z`);
    }
    await markAllStale(db(), new Date());
    expect(await recomputeUntilDone(2)).toBe(3);
    await expectUpToDate();
  });

  it("writes nothing when another rating write came first", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    await markAllStale(db(), new Date());
    const racing = new Proxy(db(), {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await markAllStale(target, new Date());
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const history = await historyTable();
    await db().prepare("DELETE FROM rating_history").run();
    expect(await recomputeRatings(racing, defaults, new Date(), log)).toMatchObject({ conflict: true, done: false });
    expect(await historyTable()).toEqual([]);
    await recomputeUntilDone();
    expect(await historyTable()).toEqual(history);
  });
});

describe("ratings: cron", () => {
  it("recomputes stale ratings on the scheduled run", async () => {
    await upload(matchLog(), "2026-09-02T20:00:00Z");
    await upload(matchLog({ key: "000000000002", players: others }), "2026-09-01T20:00:00Z");
    expect((await readState(db())).staleFrom).not.toBeNull();

    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), env);
    await expectUpToDate();
  });
});
