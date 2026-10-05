import { createScheduledController, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { downsample, peakOf, recentForm, type HistoryPoint } from "../src/site/history";
import { listFormRounds, listHistory } from "../src/site/store";
import { handleSite } from "../src/site/handler";
import worker from "../src/index";
import { sha256 } from "../src/upload/handler";
import { matchId, matchLog } from "./helpers";

const db = () => env.DB;
const tokens = { eu: "history-eu", na: "history-na" };
const adminToken = "history-admin";

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = ["admin_actions", "admins", "events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts"];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'eu host', ?, 'trusted', 'eu')").bind(await sha256(tokens.eu)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (2, 'na host', ?, 'trusted', 'na')").bind(await sha256(tokens.na)),
  ]);
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

async function upload(key: string, hours: number, token = tokens.eu, body = matchLog({ key })) {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": hoursAgo(hours) },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function playerId(name: string): Promise<number> {
  return (await db().prepare("SELECT id FROM players WHERE name = ?").bind(name).first<{ id: number }>())!.id;
}

interface History {
  region: string;
  player: { id: number; name: string };
  matches: number;
  points: { matchId: number; playedAt: string; rating: number }[];
  peak: { matchId: number; playedAt: string; rating: number } | null;
  streak: number;
  bestStreak: number;
  form: { rounds: number; wins: number; averagePosition: number | null; results: { matchId: number; round: number; position: number; players: number }[] };
}

async function history(id: number, query = ""): Promise<History> {
  const res = await SELF.fetch(`https://example.com/api/players/${id}/history${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.publicCacheSeconds}`);
  return res.json();
}

const point = (matchId: number, rating: number): HistoryPoint => ({ matchId, playedAt: `2026-10-${String(matchId).padStart(2, "0")}`, rating });

/** Complete four-player matches, Alpha winning each round. */
function longLog(key: string, rounds: number): string {
  const lines = [`GBR|1.00|1|1.3.3R|${key}`, "MATCH_START|1.00|workshop-island-night|Default|0|"];
  ["Alpha", "Bravo", "Charlie", "Delta"].forEach((name, i) => lines.push(`JOIN|1.00|${i + 1}|${name}`));
  for (let round = 1; round <= rounds; round++) {
    const time = round * 5;
    lines.push(`ROUND_START|${time}|${round}|1,2,3,4`, `ELIM|${time + 1}|${round}|2|1|4`,
      `ELIM|${time + 2}|${round}|3|1|3`, `ELIM|${time + 3}|${round}|4|1|2`, `ROUND_END|${time + 3}|${round}|1|WIN`);
  }
  lines.push(`MATCH_END|${rounds * 5 + 4}|TIME`);
  return lines.map((line) => `[00:00:01] ${line}`).join("\r\n");
}

describe("rating history: graph", () => {
  it("keeps a short history whole", () => {
    const points = [point(1, 1000), point(2, 1010)];
    expect(downsample(points, 200)).toEqual(points);
  });

  it("thins a long one to the max, keeping the first, the last and the peak", () => {
    const points = Array.from({ length: 1000 }, (_, i) => point(i + 1, 1000 + (i === 333 ? 500 : i % 7)));
    const thinned = downsample(points, 50);
    expect(thinned).toHaveLength(50);
    expect(thinned[0]).toBe(points[0]);
    expect(thinned.at(-1)).toBe(points.at(-1));
    expect(thinned).toContain(points[333]);
    expect(thinned.map((p) => p.matchId)).toEqual([...thinned.map((p) => p.matchId)].sort((a, b) => a - b));
  });

  it("finds the peak, the first time it was reached", () => {
    expect(peakOf([point(1, 1000), point(2, 1200), point(3, 1200), point(4, 1100)])?.matchId).toBe(2);
    expect(peakOf([])).toBeNull();
  });
});

describe("rating history: recent form", () => {
  it("takes the newest rounds first, and counts wins and the average place", () => {
    const rounds = [
      { matchId: 3, round: 2, position: 3, players: 4 },
      { matchId: 3, round: 1, position: 1, players: 4 },
      { matchId: 2, round: 2, position: 2, players: 4 },
    ];
    expect(recentForm(rounds)).toEqual({
      rounds: 3,
      wins: 1,
      averagePosition: 2,
      results: rounds,
    });
    expect(recentForm([])).toEqual({ rounds: 0, wins: 0, averagePosition: null, results: [] });
  });
});

describe("GET /api/players/:id/history", () => {
  it.each(["review", "region"])("checks current visibility when a %s change lands between history and form reads", async (change) => {
    await upload("000000000001", 3);
    await upload("000000000002", 2, tokens.eu, matchLog({ key: "000000000002", rounds: 1 }));
    const alpha = await playerId("Alpha");
    const second = await matchId("000000000002");
    // The graph was read while both matches were public in EU.
    expect((await listHistory(db(), "eu", alpha)).map((p) => p.matchId)).toContain(second);
    if (change === "review") {
      await upload("000000000002", 2, tokens.eu, matchLog({ key: "000000000002", players: ["Alpha", "Bravo", "Charlie", "Charlie"] }));
      expect(await db().prepare("SELECT status FROM matches WHERE id = ?").bind(second).first("status")).toBe("review");
    } else {
      const res = await SELF.fetch(`https://example.com/api/admin/matches/${second}/region`, {
        method: "POST", body: JSON.stringify({ region: "na" }), headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const rounds = await listFormRounds(db(), "eu", alpha, defaults.recentFormRounds);
    expect(rounds).toHaveLength(2);
    expect(rounds.map((r) => r.matchId)).not.toContain(second);
  });

  it("finds twenty rounds across a deleted history row before recomputing the remaining cumulative counts", async () => {
    await upload("000000000001", 4, tokens.eu, longLog("000000000001", 10));
    await upload("000000000002", 3, tokens.eu, longLog("000000000002", 20));
    // Other players' matches keep C beyond the admin's single recompute batch.
    const filler = Array.from({ length: 11 }, (_, i) => matchLog({ key: String(i + 100).padStart(12, "0"), players: ["Echo", "Foxtrot", "Golf", "Hotel"] }));
    await upload("000000000100", 2.5, tokens.eu, filler.join("\r\n"));
    await upload("000000000003", 2, tokens.eu, longLog("000000000003", 10));
    for (let run = 0; run < 3; run++) await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), env);
    const alpha = await playerId("Alpha");
    const [first, second, third] = await Promise.all([1, 2, 3].map((i) => matchId(String(i).padStart(12, "0"))));
    const res = await SELF.fetch(`https://example.com/api/admin/matches/${second}/region`, {
      method: "POST", body: JSON.stringify({ region: "na" }), headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    // B's history is deleted immediately, while C's cumulative count still includes it.
    expect(await db().prepare("SELECT rounds FROM rating_history WHERE board = 'eu' AND match_id = ? AND player_id = ?").bind(third, alpha).first("rounds")).toBe(40);
    expect(await db().prepare("SELECT count(*) FROM rating_history WHERE board = 'eu' AND match_id = ?").bind(second).first("count(*)")).toBe(0);
    const body = await history(alpha);
    expect(body.form.rounds).toBe(defaults.recentFormRounds);
    expect(body.form.results.map((r) => [r.matchId, r.round])).toEqual([
      ...Array.from({ length: 10 }, (_, i) => [third, 10 - i]),
      ...Array.from({ length: 10 }, (_, i) => [first, 10 - i]),
    ]);
  });

  it("thins a long history to the graph's points, keeping the full count, the ends and the earliest peak", async () => {
    const keys = Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(12, "0"));
    // One upload avoids the host's per-hour file limit.
    await upload(keys[0]!, 3, tokens.eu, keys.map((key) => matchLog({ key })).join("\r\n"));
    const alpha = await playerId("Alpha");
    // Finish rating the upload's tail through the same cron as production.
    for (let run = 0; run < 3; run++) await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), env);
    const full = (await db().prepare("SELECT match_id AS matchId, played_at AS playedAt, display AS rating FROM rating_history WHERE board = 'eu' AND player_id = ? ORDER BY played_at, match_id").bind(alpha).all<HistoryPoint>()).results;
    expect(full).toHaveLength(keys.length);
    const peakId = full[7]!.matchId;
    await db().prepare("UPDATE rating_history SET display = 2000 WHERE board = 'eu' AND match_id IN (?1, ?2)").bind(peakId, full[8]!.matchId).run();
    for (const p of full) if (p.matchId === peakId || p.matchId === full[8]!.matchId) p.rating = 2000;
    expect(await listHistory(db(), "eu", alpha)).toHaveLength(keys.length);
    const res = await handleSite(new Request(`https://example.com/api/players/${alpha}/history`), db(), { ...defaults, ratingHistoryMaxPoints: 5 });
    const body = await res!.json() as History;
    expect(body.matches).toBe(keys.length);
    expect(body.points).toHaveLength(5);
    expect(body.peak!.matchId).toBe(peakId);
    expect(body.points.map((p) => p.matchId)).toContain(peakId);
    expect(body.form.rounds).toBe(defaults.recentFormRounds);
  });

  it("answers the player's rating after each match, the peak, streaks and form", async () => {
    await upload("000000000001", 3);
    await upload("000000000002", 2);
    const alpha = await playerId("Alpha");
    const body = await history(alpha);
    expect(body).toMatchObject({ region: "eu", player: { id: alpha, name: "Alpha" }, matches: 2 });
    const stored = await db()
      .prepare("SELECT match_id AS matchId, played_at AS playedAt, display AS rating FROM rating_history WHERE board = 'eu' AND player_id = ? ORDER BY played_at")
      .bind(alpha)
      .all();
    expect(body.points).toEqual(stored.results);
    const top = Math.max(...body.points.map((p) => p.rating));
    expect(body.peak).toEqual(body.points.find((p) => p.rating === top));
    // matchLog: Alpha wins round 1 and goes out first in round 2, in each match.
    expect(body).toMatchObject({ streak: 0, bestStreak: 1 });
    expect(body.form).toMatchObject({ rounds: 4, wins: 2, averagePosition: 2.5 });
    expect(body.form.results.map((r) => [r.round, r.position, r.players])).toEqual([[2, 4, 4], [1, 1, 4], [2, 4, 4], [1, 1, 4]]);
    expect(body.form.results[0]!.matchId).toBe(body.points[1]!.matchId);
  });

  it("keeps the regions apart: an NA match isn't in the EU history", async () => {
    await upload("000000000001", 3);
    await upload("000000000002", 2, tokens.na);
    const alpha = await playerId("Alpha");
    const eu = await history(alpha);
    const na = await history(alpha, "?region=na");
    expect(eu.matches).toBe(1);
    expect(na).toMatchObject({ region: "na", matches: 1 });
    expect(na.points[0]!.matchId).not.toBe(eu.points[0]!.matchId);
    expect(na.form.rounds).toBe(2);
  });

  it("answers an empty history for a player not rated in the region", async () => {
    await upload("000000000001", 3);
    const body = await history(await playerId("Alpha"), "?region=na");
    expect(body).toMatchObject({ region: "na", matches: 0, points: [], peak: null, streak: 0, bestStreak: 0, form: { rounds: 0, results: [] } });
  });

  it("follows the ratings: a voided match leaves it", async () => {
    await upload("000000000001", 3);
    await upload("000000000002", 2);
    const id = (await db().prepare("SELECT id FROM matches WHERE match_key = '000000000002'").first<number>("id"))!;
    const res = await SELF.fetch(`https://example.com/api/admin/matches/${id}/void`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await history(await playerId("Alpha"));
    expect(body.matches).toBe(1);
    expect(body.points.map((p) => p.matchId)).not.toContain(id);
    expect(body.form.rounds).toBe(2);
  });

  it("leaves out a match back in review, or moved to the other region, before the recompute", async () => {
    await upload("000000000001", 3);
    await upload("000000000002", 2);
    await upload("000000000003", 1);
    const alpha = await playerId("Alpha");
    const second = (await db().prepare("SELECT id FROM matches WHERE match_key = '000000000002'").first<number>("id"))!;
    const third = (await db().prepare("SELECT id FROM matches WHERE match_key = '000000000003'").first<number>("id"))!;
    await db().batch([
      db().prepare("UPDATE matches SET status = 'review' WHERE id = ?").bind(second),
      db().prepare("UPDATE matches SET region = 'na' WHERE id = ?").bind(third),
    ]);
    const body = await history(alpha);
    expect(body.matches).toBe(1);
    expect(body.points.map((p) => p.matchId)).not.toContain(second);
    expect(body.points.map((p) => p.matchId)).not.toContain(third);
    expect(body.form.results.map((r) => r.matchId)).not.toContain(second);
    expect(body.form.rounds).toBe(2);
    expect((await history(alpha, "?region=na")).matches).toBe(0);
  });

  it("is a 404 for an unknown player, a 400 for an unknown region", async () => {
    expect((await SELF.fetch("https://example.com/api/players/999/history")).status).toBe(404);
    expect((await SELF.fetch("https://example.com/api/players/abc/history")).status).toBe(404);
    await upload("000000000001", 3);
    const res = await SELF.fetch(`https://example.com/api/players/${await playerId("Alpha")}/history?region=mars`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
  });
});
