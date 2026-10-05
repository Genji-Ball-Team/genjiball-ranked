import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0017_match_stats.sql?raw";
import { handleAdmin } from "../src/admin/handler";
import { defaults } from "../src/config";
import { parseLegacyLog } from "../src/parser/legacy";
import type { ParsedMatch } from "../src/parser/types";
import { createLogger } from "../src/log";
import { rateNewMatches, rateNewMatchesMaxQueries } from "../src/rating/update";
import { matchView } from "../src/site/handler";
import type { MatchDetail } from "../src/site/store";
import { handleUpload, sha256 } from "../src/upload/handler";
import { matchStats } from "../src/upload/plan";
import { rebuildPairsStatements, rebuildTotalsStatements } from "../src/upload/pairs";
import { jsonChunks, RowTooLarge, utf8Length } from "../src/upload/store";
import { countingDb, matchId } from "./helpers";

/** Match stats (#15) and head-to-head records (#18). */

const db = () => env.DB;
const adminToken = "admin-token";
const token = "eu-host";

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = [
    "admin_actions", "player_merges", "admins", "tourney_lobbies", "tourneys", "match_pairs", "pair_stats", "events", "round_players", "rounds",
    "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts",
  ];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'eu host', ?, 'trusted', 'eu')").bind(await sha256(token)),
  ]);
});

/**
 * Alpha (1), Bravo (2) and Charlie (3), four rounds, each ELIM with its KILL:
 * 1. Alpha deflects twice, Bravo once. Bravo eliminates Charlie, Alpha eliminates Bravo: Alpha, Bravo, Charlie.
 *    Between rounds, Bravo kills Alpha: a KILL with no ELIM.
 * 2. Alpha falls (no killer); Bravo deflects and eliminates Charlie: Bravo, Charlie, Alpha.
 * 3. Alpha deflects and eliminates Charlie, then Bravo: Alpha, Bravo, Charlie.
 * 4. Alpha eliminates Bravo, then Charlie: Alpha, Charlie, Bravo.
 * `extra` adds a fifth round (a longer copy): Charlie wins, eliminating both. `lateKill`: Delta (4)
 * joins after the rounds and kills Alpha, so they never share a round.
 */
function statsLog(key: string, { extra = false, lateKill = false } = {}): string {
  const lines = [
    `GBR|1.00|1|1.3.3R|${key}`,
    "MATCH_START|1.00|workshop-island-night|Default|0|",
    "JOIN|1.00|1|Alpha",
    "JOIN|1.00|2|Bravo",
    "JOIN|1.00|3|Charlie",
    "ROUND_START|2.00|1|1,2,3",
    "DEFLECT|3.00|1|1|20|2",
    "DEFLECT|4.00|1|2|25|3",
    "ELIM|5.00|1|3|2|3",
    "KILL|5.00|Bravo|Charlie|2|3",
    "DEFLECT|6.00|1|1|30|2",
    "KILL|7.00|Alpha|Bravo|1|2",
    "ELIM|7.00|1|2|1|2",
    "ROUND_END|7.00|1|1|WIN",
    "KILL|8.00|Bravo|Alpha|2|1",
    "ROUND_START|10.00|2|1,2,3",
    "ELIM|11.00|2|1||3",
    "KILL|11.00||Alpha||1",
    "DEFLECT|12.00|2|2|20|3",
    "ELIM|13.00|2|3|2|2",
    "KILL|13.00|Bravo|Charlie|2|3",
    "ROUND_END|13.00|2|2|WIN",
    "ROUND_START|20.00|3|1,2,3",
    "DEFLECT|21.00|3|1|20|3",
    "ELIM|22.00|3|3|1|3",
    "KILL|22.00|Alpha|Charlie|1|3",
    "ELIM|23.00|3|2|1|2",
    "KILL|23.00|Alpha|Bravo|1|2",
    "ROUND_END|23.00|3|1|WIN",
    "ROUND_START|30.00|4|1,2,3",
    "ELIM|31.00|4|2|1|3",
    "KILL|31.00|Alpha|Bravo|1|2",
    "ELIM|32.00|4|3|1|2",
    "KILL|32.00|Alpha|Charlie|1|3",
    "ROUND_END|32.00|4|1|WIN",
  ];
  if (extra) {
    lines.push(
      "ROUND_START|40.00|5|1,2,3",
      "ELIM|41.00|5|1|3|3",
      "KILL|41.00|Charlie|Alpha|3|1",
      "ELIM|42.00|5|2|3|2",
      "KILL|42.00|Charlie|Bravo|3|2",
      "ROUND_END|42.00|5|3|WIN",
    );
  }
  if (lateKill) lines.push("JOIN|45.00|4|Delta", "KILL|46.00|Delta|Alpha|4|1");
  lines.push("MATCH_END|50.00|TIME");
  return lines.map((line) => `[00:00:01] ${line}`).join("\r\n");
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

async function upload(body: string, hours: number, region?: string) {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": hoursAgo(hours), ...(region ? { "X-Region": region } : {}) },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

function admin(path: string, body: unknown = {}) {
  return SELF.fetch(`https://example.com/api/admin/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

async function get<T = Record<string, unknown>>(path: string, status = 200): Promise<T> {
  const res = await SELF.fetch(`https://example.com/api/${path}`);
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
}

async function ids(): Promise<Record<string, number>> {
  const { results } = await db().prepare("SELECT id, name FROM players").all<{ id: number; name: string }>();
  return Object.fromEntries(results.map((p) => [p.name, p.id]));
}

interface HeadToHead {
  region: string;
  rounds: number;
  a: { id: number; name: string; ahead: number; kills: number };
  b: { id: number; name: string; ahead: number; kills: number };
}

const pairColumns = "region, player_id AS playerId, opponent_id AS opponentId, rounds, ahead, kills, deaths";

async function pairStats() {
  const { results } = await db().prepare(`SELECT ${pairColumns} FROM pair_stats ORDER BY region, player_id, opponent_id`).all();
  return results;
}

/** The invariant the triggers keep: pair_stats is the sum of match_pairs over accepted matches, by region. */
async function expectTotalsMatchPairs() {
  const { results } = await db()
    .prepare(
      `SELECT m.region, p.player_id AS playerId, p.opponent_id AS opponentId, sum(p.rounds) AS rounds, sum(p.ahead) AS ahead,
         sum(p.kills) AS kills, sum(p.deaths) AS deaths
       FROM match_pairs p JOIN matches m ON m.id = p.match_id WHERE m.status = 'accepted'
       GROUP BY m.region, p.player_id, p.opponent_id HAVING sum(p.rounds) + sum(p.kills) + sum(p.deaths) > 0
       ORDER BY m.region, p.player_id, p.opponent_id`,
    )
    .all();
  expect(await pairStats()).toEqual(results);
}

type MatchView = ReturnType<typeof matchView>;

describe("match stats (#15)", () => {
  it("counts kills from KILL lines, deflects, touches and the longest win streak, per round and for the match", async () => {
    await upload(statsLog("000000000001"), 2);
    const { match } = await get<{ match: MatchView }>(`matches/${await matchId("000000000001")}`);
    const { Alpha, Bravo, Charlie } = await ids();
    expect(
      match.players.map(({ id, kills, deflects, touches, longestStreak, wins, roundWins, place }) => ({ id, kills, deflects, touches, longestStreak, wins, roundWins, place })),
    ).toEqual([
      // Touches: deflects, plus times a ball someone sent eliminated them. Alpha's fall isn't one.
      { id: Alpha, kills: 5, deflects: 3, touches: 3, longestStreak: 2, wins: 3, roundWins: 3, place: 1 },
      // Bravo's kill of Alpha between rounds has no ELIM, and counts.
      { id: Bravo, kills: 3, deflects: 2, touches: 5, longestStreak: 1, wins: 1, roundWins: 1, place: 2 },
      { id: Charlie, kills: 0, deflects: 0, touches: 4, longestStreak: 0, wins: 0, roundWins: 0, place: 3 },
    ]);
    expect(match.rounds[0]!.placements.map(({ playerId, kills, deflects, touches }) => ({ playerId, kills, deflects, touches }))).toEqual([
      { playerId: Alpha, kills: 1, deflects: 2, touches: 2 },
      { playerId: Bravo, kills: 1, deflects: 1, touches: 2 },
      { playerId: Charlie, kills: 0, deflects: 0, touches: 1 },
    ]);
    // Alpha's fall in round 2 is a KILL with no attacker: no one's kill.
    expect(match.rounds[1]!.placements.map((p) => p.kills)).toEqual([1, 0, 0]);
  });

  it("shows only what a legacy log has: deflects and touches are null", async () => {
    const legacy = ["KILL|10.00|Alpha|Charlie", "KILL|11.00|Alpha|Bravo", "KILL|30.00|Bravo|Charlie", "KILL|31.00|Bravo|Alpha"]
      .map((line) => `[00:00:01] ${line}`)
      .join("\n");
    const res = await SELF.fetch("https://example.com/api/admin/legacy-import?host=1", {
      method: "POST",
      body: legacy,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const id = (await db().prepare("SELECT id FROM matches WHERE legacy = 1").first<{ id: number }>())!.id;
    const { match } = await get<{ match: MatchView }>(`matches/${id}`);
    expect(match.legacy).toBe(true);
    expect(match.players.map(({ name, kills, deflects, touches, longestStreak }) => ({ name, kills, deflects, touches, longestStreak }))).toEqual([
      { name: "Alpha", kills: 2, deflects: null, touches: null, longestStreak: 1 },
      { name: "Charlie", kills: 0, deflects: null, touches: null, longestStreak: 0 },
      { name: "Bravo", kills: 2, deflects: null, touches: null, longestStreak: 1 },
    ]);
    expect(match.rounds[0]!.placements.every((p) => p.deflects === null && p.touches === null)).toBe(true);
  });

  const detailOf = (players: MatchDetail["players"], rounds: MatchDetail["rounds"], roundPlayers: MatchDetail["roundPlayers"]): MatchDetail => ({
    match: { id: 1, region: "eu", playedAt: "", map: null, preset: null, gameVersion: "", legacy: false, void: false, complete: true, tournament: false, tourney: null },
    players,
    rounds,
    roundPlayers,
  });
  const player = (logId: number, playerId: number, kills: number) => ({ logId, playerId, name: String(playerId), kills, ratingBefore: null, ratingAfter: null });
  const entry = (roundId: number, logId: number, position: number | null, left = false) =>
    ({ roundId, logId, position, place: null, left, killerId: null, kills: 0, deflects: 1 });

  it("adds up a player who rejoined under a new log id; a round they left doesn't break a streak", () => {
    const view = matchView(
      detailOf(
        [player(1, 10, 1), player(2, 20, 0), player(3, 10, 1)],
        [1, 2, 3].map((n) => ({ id: n, number: n, result: "WIN" as const, winnerId: n === 2 ? 2 : n, rated: true, broken: null })),
        [entry(1, 1, 1), entry(1, 2, 2), entry(2, 1, null, true), entry(2, 2, 1), entry(3, 3, 1), entry(3, 2, 2)],
      ),
    );
    expect(view.players.map(({ id, kills, deflects, longestStreak }) => ({ id, kills, deflects, longestStreak }))).toEqual([
      { id: 10, kills: 2, deflects: 3, longestStreak: 2 },
      { id: 20, kills: 0, deflects: 3, longestStreak: 1 },
    ]);
  });

  it("places players by every WIN round won, rated or not, then kills", () => {
    // Round 1 is rated (A wins). In rounds 2 and 3 A leaves and B wins alone: WIN, not rated.
    const rounds = [1, 2, 3].map((n) => ({ id: n, number: n, result: "WIN" as const, winnerId: n === 1 ? 1 : 2, rated: n === 1, broken: null }));
    const view = matchView(
      detailOf([player(1, 10, 5), player(2, 20, 0)], rounds, [entry(1, 1, 1), entry(1, 2, 2), entry(2, 1, null, true), entry(2, 2, null), entry(3, 1, null, true), entry(3, 2, null)]),
    );
    expect(view.players.map(({ id, wins, roundWins, place }) => ({ id, wins, roundWins, place }))).toEqual([
      { id: 10, wins: 1, roundWins: 1, place: 2 },
      { id: 20, wins: 0, roundWins: 2, place: 1 },
    ]);
    // The same round wins: kills break the tie; the same kills share the place.
    const tied = matchView(detailOf([player(1, 10, 2), player(2, 20, 3), player(3, 30, 3)], [], []));
    expect(tied.players.map((p) => p.place)).toEqual([3, 1, 1]);
  });
});

describe("head-to-head (#18)", () => {
  it("answers two players' record in a region, and zeros when they never met", async () => {
    await upload(statsLog("000000000001"), 2);
    const { Alpha, Bravo } = await ids();
    expect(await get<HeadToHead>(`head-to-head?a=${Alpha}&b=${Bravo}`)).toEqual({
      region: "eu",
      rounds: 4,
      a: { id: Alpha, name: "Alpha", ahead: 3, kills: 3 },
      // Bravo's kill between rounds counts: every KILL line.
      b: { id: Bravo, name: "Bravo", ahead: 1, kills: 1 },
    });
    expect(await get<HeadToHead>(`head-to-head?a=${Bravo}&b=${Alpha}&region=eu`)).toMatchObject({ a: { ahead: 1, kills: 1 }, b: { ahead: 3, kills: 3 } });
    expect(await get<HeadToHead>(`head-to-head?a=${Alpha}&b=${Bravo}&region=na`)).toMatchObject({ region: "na", rounds: 0, a: { kills: 0 }, b: { kills: 0 } });
  });

  it("keeps a pair with kills but no rated round together, until its match stops counting", async () => {
    await upload(statsLog("000000000001", { lateKill: true }), 2);
    const { Alpha, Delta } = await ids();
    expect(await get<HeadToHead>(`head-to-head?a=${Delta}&b=${Alpha}`)).toMatchObject({ rounds: 0, a: { ahead: 0, kills: 1 }, b: { ahead: 0, kills: 0 } });
    expect((await admin(`matches/${await matchId("000000000001")}/void`)).status).toBe(200);
    expect(await pairStats()).toEqual([]);
    await expectTotalsMatchPairs();
  });

  it("refuses a bad region, missing or equal players, and unknown players", async () => {
    await upload(statsLog("000000000001"), 2);
    const { Alpha, Bravo } = await ids();
    expect(await get(`head-to-head?a=${Alpha}&b=${Bravo}&region=asia`, 400)).toMatchObject({ error: "bad_request" });
    expect(await get(`head-to-head?a=${Alpha}`, 400)).toMatchObject({ error: "bad_request" });
    expect(await get(`head-to-head?a=${Alpha}&b=${Alpha}`, 400)).toMatchObject({ error: "bad_request" });
    expect(await get(`head-to-head?a=${Alpha}&b=x`, 400)).toMatchObject({ error: "bad_request" });
    expect(await get(`head-to-head?a=${Alpha}&b=99999`, 404)).toMatchObject({ error: "not_found" });
    const res = await SELF.fetch(`https://example.com/api/head-to-head?a=${Alpha}&b=${Bravo}`);
    expect(res.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+$/);
    expect((await SELF.fetch(`https://example.com/api/head-to-head?a=${Alpha}&b=${Bravo}`, { method: "POST" })).status).toBe(405);
  });

  it("lists a player's most eliminated and most eliminated by, in the region", async () => {
    await upload(statsLog("000000000001"), 2);
    const { Alpha, Bravo, Charlie } = await ids();
    type Rivals = { region: string; mostEliminated: { id: number; kills: number; rounds: number }[]; mostEliminatedBy: { id: number; kills: number }[] };
    const alpha = await get<Rivals>(`players/${Alpha}`);
    expect(alpha.mostEliminated).toEqual([
      { id: Bravo, name: "Bravo", kills: 3, rounds: 4 },
      { id: Charlie, name: "Charlie", kills: 2, rounds: 4 },
    ]);
    expect(alpha.mostEliminatedBy).toEqual([{ id: Bravo, name: "Bravo", kills: 1, rounds: 4 }]);
    const charlie = await get<Rivals>(`players/${Charlie}`);
    expect(charlie.mostEliminated).toEqual([]);
    // A tie: the lower player id first.
    expect(charlie.mostEliminatedBy.map((r) => [r.id, r.kills])).toEqual([[Alpha, 2], [Bravo, 2]]);
    const na = await get<Rivals>(`players/${Alpha}?region=na`);
    expect(na).toMatchObject({ region: "na", mostEliminated: [], mostEliminatedBy: [] });
  });

  it("totals a player's rated rounds for compare (#16): kills, deflects, touches and average place", async () => {
    await upload(statsLog("000000000001"), 2);
    const { Alpha, Bravo } = await ids();
    type Stats = { player: { id: number }; stats: Record<string, number | null> };
    expect((await get<Stats>(`players/${Alpha}/stats`)).stats).toEqual({ rounds: 4, kills: 5, deflectRounds: 4, deflects: 3, touches: 3, averagePosition: 1.5 });
    // Bravo's kill between rounds isn't in a round. Touches: 2 deflects, eliminated by Alpha's ball 3 times.
    expect((await get<Stats>(`players/${Bravo}/stats`)).stats).toEqual({ rounds: 4, kills: 2, deflectRounds: 4, deflects: 2, touches: 5, averagePosition: 2 });
    expect((await get<Stats>(`players/${Alpha}/stats?region=na`)).stats).toEqual({ rounds: 0, kills: 0, deflectRounds: 0, deflects: 0, touches: 0, averagePosition: null });
    expect(await get("players/99999/stats", 404)).toMatchObject({ error: "not_found" });
    // A void match doesn't count, as in the head-to-head.
    expect((await admin(`matches/${await matchId("000000000001")}/void`)).status).toBe(200);
    expect((await get<Stats>(`players/${Alpha}/stats`)).stats).toMatchObject({ rounds: 0, averagePosition: null });
  });

  it("keeps the regions apart, follows a match moved to the other region, a void and a longer copy", async () => {
    await upload(statsLog("000000000001"), 3);
    await upload(statsLog("000000000002"), 2, "na");
    const { Alpha, Bravo } = await ids();
    const record = async (region: string) => (await get<HeadToHead>(`head-to-head?a=${Alpha}&b=${Bravo}&region=${region}`)).rounds;
    expect([await record("eu"), await record("na")]).toEqual([4, 4]);

    // Moved: out of NA, into EU.
    const moved = await admin(`matches/${await matchId("000000000002")}/region`, { region: "eu" });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect([await record("eu"), await record("na")]).toEqual([8, 0]);
    expect((await pairStats()).filter((r) => r.region === "na")).toEqual([]);
    await expectTotalsMatchPairs();

    // Voided: out of the totals; unvoided: back.
    const first = await matchId("000000000001");
    expect((await admin(`matches/${first}/void`)).status).toBe(200);
    expect(await record("eu")).toBe(4);
    expect((await admin(`matches/${first}/unvoid`)).status).toBe(200);
    expect(await record("eu")).toBe(8);

    // A longer copy replaces the match's pairs instead of adding to them.
    await upload(statsLog("000000000001", { extra: true }), 3);
    expect(await record("eu")).toBe(9);
    expect(await get<HeadToHead>(`head-to-head?a=${Alpha}&b=${Bravo}`)).toMatchObject({ a: { kills: 6 }, b: { kills: 2 } });
    await expectTotalsMatchPairs();
  });

  it("leaves matches in review out until they're accepted", async () => {
    await db().prepare("UPDATE hosts SET trust = 'untrusted'").run();
    await upload(statsLog("000000000001"), 2);
    expect(await pairStats()).toEqual([]);
    expect((await admin(`matches/${await matchId("000000000001")}/accept`)).status).toBe(200);
    expect(await pairStats()).toHaveLength(6);
    await expectTotalsMatchPairs();
  });

  it("takes a deleted match out of the totals", async () => {
    await upload(statsLog("000000000001"), 3);
    await upload(statsLog("000000000002"), 2);
    await db().prepare("DELETE FROM matches WHERE id = ?").bind(await matchId("000000000001")).run();
    expect(await db().prepare("SELECT count(*) AS n FROM match_pairs").first("n")).toBe(6);
    await expectTotalsMatchPairs();
    const { Alpha, Bravo } = await ids();
    expect(await get<HeadToHead>(`head-to-head?a=${Alpha}&b=${Bravo}`)).toMatchObject({ rounds: 4 });
  });

  it("changes a match's totals by key, without reading the region's other pairs", async () => {
    await upload(statsLog("000000000001"), 2);
    // 3,000 other pairs in the region: a scan of the region would read them all.
    await db()
      .prepare(
        `INSERT INTO players (id, name) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3001)
         SELECT 100000 + i, 'Filler ' || i FROM n`,
      )
      .run();
    await db()
      .prepare(
        `INSERT INTO pair_stats (region, player_id, opponent_id, rounds, ahead, kills, deaths)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
         SELECT 'eu', 100000 + i, 100001 + i, 1, 0, 1, 0 FROM n`,
      )
      .run();
    const id = await matchId("000000000001");
    for (const change of ["UPDATE matches SET status = 'void' WHERE id = ?", "UPDATE matches SET status = 'accepted' WHERE id = ?", "UPDATE matches SET region = 'na' WHERE id = ?"]) {
      const { meta } = await db().prepare(change).bind(id).run();
      expect(meta.rows_read, change).toBeLessThan(200);
    }
    expect((await pairStats()).filter((r) => r.region === "na")).toHaveLength(6);
  });

  it("is rebuilt to the same totals by the rebuild, a range at a time", async () => {
    await upload(statsLog("000000000001"), 4);
    await upload(statsLog("000000000002", { lateKill: true }), 3, "na");
    await upload(statsLog("000000000003"), 2);
    await admin(`matches/${await matchId("000000000003")}/void`);
    await upload(statsLog("000000000001", { extra: true }), 4);
    const before = await pairStats();
    expect(before.length).toBeGreaterThan(0);
    const matches = [await matchId("000000000001"), await matchId("000000000002"), await matchId("000000000003")].sort((a, b) => a - b);
    const run = (statements: string[]) => db().batch(statements.map((s) => db().prepare(s)));

    // Pairs re-derived in place, one range of matches at a time: the totals are right after each.
    await run(rebuildPairsStatements(matches[0]!, matches[1]!));
    expect(await pairStats()).toEqual(before);
    await run(rebuildPairsStatements(matches[2]!, matches[2]!));
    expect(await pairStats()).toEqual(before);

    // Totals that went wrong: recomputed one range of players at a time; each range is right once it ran.
    await db().prepare("UPDATE pair_stats SET kills = kills + 7").run();
    const players = Object.values(await ids()).sort((a, b) => a - b);
    const middle = players[1]!;
    await run(rebuildTotalsStatements(players[0]!, middle));
    const fixed = (rows: Record<string, unknown>[]) => rows.filter((r) => (r.playerId as number) <= middle);
    expect(fixed(await pairStats())).toEqual(fixed(before));
    expect(await pairStats()).not.toEqual(before);
    await run(rebuildTotalsStatements(middle + 1, players.at(-1)!));
    expect(await pairStats()).toEqual(before);
    await expectTotalsMatchPairs();
    expect(() => rebuildPairsStatements(5, 2)).toThrow();
    expect(() => rebuildTotalsStatements(0, 2)).toThrow();
  });
});

describe("a KILL after its round's ROUND_END in the same tick", () => {
  // Round 1 ends on Bravo's ELIM, and Alpha's KILL of Bravo comes after the ROUND_END, in the same tick.
  const lateKillLog = [
    "GBR|1.00|1|1.3.3R|000000000009",
    "MATCH_START|1.00|workshop-island-night|Default|0|",
    "JOIN|1.00|1|Alpha",
    "JOIN|1.00|2|Bravo",
    "ROUND_START|2.00|1|1,2",
    "ELIM|5.00|1|2|1|2",
    "ROUND_END|5.00|1|1|WIN",
    "KILL|5.00|Alpha|Bravo|1|2",
    "MATCH_END|10.00|TIME",
  ].map((line) => `[00:00:01] ${line}`).join("\r\n");

  it("counts in the round of the ELIM with the same victim and time", async () => {
    await upload(lateKillLog, 2);
    const { match } = await get<{ match: MatchView }>(`matches/${await matchId("000000000009")}`);
    expect(match.players.map((p) => [p.name, p.kills])).toEqual([["Alpha", 1], ["Bravo", 0]]);
    expect(match.rounds[0]!.placements.map((p) => [p.name, p.kills])).toEqual([["Alpha", 1], ["Bravo", 0]]);
    // The event itself keeps no round, as logged.
    expect(await db().prepare("SELECT round FROM events WHERE type = 'KILL'").first("round")).toBeNull();
  });

  const backfill = () =>
    migration
      .replaceAll("\r\n", "\n")
      .split(";\n")
      .map((s) => s.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim())
      .find((s) => s.startsWith("UPDATE round_players SET kills"))!;
  const roundKills = async () =>
    (await db().prepare("SELECT r.number AS round, rp.log_id AS logId, rp.kills FROM round_players rp JOIN rounds r ON r.id = rp.round_id ORDER BY r.number, rp.log_id").all()).results;

  it("isn't guessed by migration 0017's backfill, which counts only the kills the parser put in a round", async () => {
    await upload(statsLog("000000000001"), 3);
    const uploaded = await roundKills();
    await db().prepare("UPDATE round_players SET kills = 0").run();
    await db().prepare(backfill()).run();
    expect(await roundKills()).toEqual(uploaded);

    // The same-tick KILL has no round in the events: a match stored before 0017 counts it in no round.
    await db().batch([db().prepare("DELETE FROM matches"), db().prepare("DELETE FROM uploads")]);
    await upload(lateKillLog, 2);
    await db().prepare("UPDATE round_players SET kills = 0").run();
    await db().prepare(backfill()).run();
    expect(await roundKills()).toEqual([{ round: 1, logId: 1, kills: 0 }, { round: 1, logId: 2, kills: 0 }]);
  });

  it("leaves a legacy log's round kills as its parser put them", async () => {
    // Round 1 Alpha wins, round 2 Bravo; the file ends in a round with no winner, whose kill has no round.
    const lines = ["10.00|Alpha|Charlie", "11.00|Alpha|Bravo", "30.00|Bravo|Charlie", "31.00|Bravo|Alpha", "50.00|Alpha|Bravo"];
    const text = lines.map((line) => `[00:00:01] KILL|${line}`).join("\n");
    const parsed = parseLegacyLog(text, {
      botNames: defaults.legacyBotNames,
      gameVersion: defaults.legacyGameVersion,
      roundGapSeconds: defaults.legacyRoundGapSeconds,
      resurrectSeconds: defaults.legacyResurrectSeconds,
    })!;
    const expected = new Map<string, number>();
    for (const k of parsed.kills) {
      if (k.round !== null && k.attackerId !== null) expected.set(`${k.round}:${k.attackerId}`, (expected.get(`${k.round}:${k.attackerId}`) ?? 0) + 1);
    }
    const res = await SELF.fetch("https://example.com/api/admin/legacy-import?host=1", {
      method: "POST",
      body: text,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await roundKills();
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored as { round: number; logId: number; kills: number }[]) {
      expect(row.kills, `round ${row.round}, player ${row.logId}`).toBe(expected.get(`${row.round}:${row.logId}`) ?? 0);
    }
    // The last kill counts in the match total, not in a round.
    const alpha = await db().prepare("SELECT kills FROM match_players WHERE name = 'Alpha'").first("kills");
    expect(alpha).toBe(3);
  });
});

describe("matchStats", () => {
  it("counts a round-less KILL in its ELIM's round only for new logs, never for legacy ones", () => {
    const round = {
      number: 1, startTime: 2, endTime: 5, result: "WIN" as const, playerIds: [1, 2], leftIds: [], winnerId: 1, finishingOrder: [1, 2], broken: [],
      elims: [{ time: 5, id: 2, killerId: 1, place: 2 }],
    };
    const kill = { time: 5, attackerName: "Alpha", victimName: "Bravo", attackerId: 1, victimId: 2, round: null };
    const match = { format: 1, rounds: [round], kills: [kill], deflects: [] } as unknown as ParsedMatch;
    expect(matchStats(match).roundKills.get("1:1")).toBe(1);
    const legacy = matchStats({ ...match, format: 0 });
    expect(legacy.roundKills.get("1:1")).toBeUndefined();
    expect(legacy.kills.get(1)).toBe(1);
  });
});

describe("bulk insert chunks", () => {
  it("are measured in UTF-8 bytes, and a row too large for one is refused", () => {
    const name = "😀".repeat(60); // 120 UTF-16 units, 240 UTF-8 bytes
    expect(utf8Length(name)).toBe(240);
    expect(utf8Length("aé€😀")).toBe(new TextEncoder().encode("aé€😀").length);
    const rows = Array.from({ length: 10 }, (_, i) => ({ i, name }));
    const chunks = jsonChunks(rows, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(600);
    expect(chunks.flatMap((c) => JSON.parse(c) as unknown[])).toEqual(rows);
    expect(() => jsonChunks(rows, 200)).toThrow(RowTooLarge);
  });

  it("refuse an upload with a row over insertChunkBytes in UTF-8 (though not in UTF-16), writing nothing", async () => {
    const name = "😀".repeat(60);
    const log = statsLog("000000000021").replace(/\|Alpha/g, `|${name}`);
    const request = new Request("https://example.com/api/upload", {
      method: "POST",
      body: log,
      headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": hoursAgo(1) },
    });
    // The player row is about 330 UTF-16 units but about 570 bytes.
    const res = await handleUpload(request, db(), { ...defaults, insertChunkBytes: 450 }, createLogger("error"));
    expect(res.status, await res.clone().text()).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_large" });
    expect(await db().prepare("SELECT count(*) AS n FROM matches").first("n")).toBe(0);
    // With room, the same file is stored.
    const ok = await handleUpload(new Request(request.url, { method: "POST", body: log, headers: request.headers }), db(), defaults, createLogger("error"));
    expect(ok.status).toBe(200);
  });
});

describe("upload query budget", () => {
  /** A valid 4-player match: one rated round, then `aborts` ABORT rounds, which each write a round and 4 players. */
  function longLog(key: string, aborts: number): string {
    const lines = [`GBR|1.00|1|1.3.3R|${key}`, "MATCH_START|1.00|workshop-island-night|Default|0|"];
    ["Alpha", "Bravo", "Charlie", "Delta"].forEach((name, i) => lines.push(`JOIN|1.00|${i + 1}|${name}`));
    lines.push("ROUND_START|2.00|1|1,2,3,4", "ELIM|3.00|1|2|1|4", "ELIM|4.00|1|3|1|3", "ELIM|5.00|1|4|1|2", "ROUND_END|5.00|1|1|WIN");
    for (let n = 2; n <= aborts + 1; n++) lines.push(`ROUND_START|${n}.00|${n}|1,2,3,4`, `ROUND_END|${n}.50|${n}||ABORT`);
    lines.push(`MATCH_END|${aborts + 9}.00|TIME`);
    return lines.map((line) => `[00:00:01] ${line}`).join("\r\n");
  }

  const send = (body: string, config: typeof defaults) => {
    const counting = countingDb(db());
    const request = new Request("https://example.com/api/upload", {
      method: "POST",
      body,
      headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": hoursAgo(1) },
    });
    return handleUpload(request, counting.db, config, createLogger("error")).then((res) => ({ res, queries: counting.queries() }));
  };
  const ratedAt = async (key: string) => db().prepare("SELECT rated_at FROM matches WHERE match_key = ?").bind(key).first("rated_at");

  it("stores and rates a 5,000-round log within the free plan's queries", async () => {
    const body = longLog("000000000011", 4999);
    expect(body.length).toBeLessThanOrEqual(defaults.maxUploadBytes);
    const { res, queries } = await send(body, defaults);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(queries).toBeLessThanOrEqual(defaults.queriesPerRequest);
    expect(await db().prepare("SELECT count(*) AS n FROM rounds").first("n")).toBe(5000);
    expect(await db().prepare("SELECT count(*) AS n FROM round_players").first("n")).toBe(20000);
    expect(await ratedAt("000000000011")).not.toBeNull();
  });

  it("leaves rating to the cron when the queries left can't hold it", async () => {
    const first = await send(longLog("000000000012", 10), defaults);
    expect(first.res.status).toBe(200);
    const writesAndReads = first.queries - rateNewMatchesMaxQueries;
    const tight = { ...defaults, queriesPerRequest: writesAndReads + rateNewMatchesMaxQueries - 1 };
    const { res, queries } = await send(longLog("000000000013", 10), tight);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(queries).toBeLessThanOrEqual(tight.queriesPerRequest);
    expect(await ratedAt("000000000013")).toBeNull();
    expect(await db().prepare("SELECT status FROM matches WHERE match_key = '000000000013'").first("status")).toBe("accepted");
  });

  it("refuses a file that would need more statements than the queries allow, writing nothing", async () => {
    const { res, queries } = await send(longLog("000000000014", 200), { ...defaults, insertChunkBytes: 500 });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_large" });
    expect(queries).toBeLessThanOrEqual(defaults.queriesPerRequest);
    expect(await db().prepare("SELECT count(*) AS n FROM matches").first("n")).toBe(0);
  });

  it("rates within rateNewMatchesMaxQueries, even for a region with no rating state yet", async () => {
    await db().prepare("UPDATE hosts SET trust = 'untrusted'").run();
    await upload(statsLog("000000000015"), 3, "na");
    await upload(statsLog("000000000016"), 2, "na");
    await db().batch([
      db().prepare("UPDATE matches SET status = 'accepted'"),
      db().prepare("DELETE FROM rating_state WHERE board = 'na'"),
    ]);
    const counting = countingDb(db());
    const result = await rateNewMatches(counting.db, defaults, new Date(), createLogger("error"), "na");
    expect(result.rated).toBe(2);
    expect(counting.queries()).toBeLessThanOrEqual(rateNewMatchesMaxQueries);
    await db().prepare("INSERT OR IGNORE INTO rating_state (board) VALUES ('na')").run();
  });
});

describe("head-to-head and player merges (#8)", () => {
  const lines = (key: string, body: string[]) =>
    [`GBR|1.00|1|1.3.3R|${key}`, "MATCH_START|1.00|workshop-island-night|Default|0|", ...body, "MATCH_END|90.00|TIME"]
      .map((line) => `[00:00:01] ${line}`)
      .join("\r\n");
  // Alpha and Alfa (one player under two names) share match 31 but no round. Alpha kills Alfa between
  // rounds: after the merge, a kill of a player by themselves, which isn't a pair.
  const shared = lines("000000000031", [
    "JOIN|1.00|1|Alpha", "JOIN|1.00|2|Alfa", "JOIN|1.00|3|Bravo", "JOIN|1.00|4|Charlie",
    "ROUND_START|2.00|1|1,3,4", "ELIM|3.00|1|3|1|3", "KILL|3.00|Alpha|Bravo|1|3", "ELIM|4.00|1|4|1|2", "KILL|4.00|Alpha|Charlie|1|4", "ROUND_END|4.00|1|1|WIN",
    "KILL|8.00|Alpha|Alfa|1|2",
    "ROUND_START|20.00|2|2,3,4", "ELIM|21.00|2|3|2|3", "KILL|21.00|Alfa|Bravo|2|3", "ELIM|22.00|2|2|4|2", "KILL|22.00|Charlie|Alfa|4|2", "ROUND_END|22.00|2|4|WIN",
  ]);
  const alfaOnly = lines("000000000032", [
    "JOIN|1.00|1|Alfa", "JOIN|1.00|2|Bravo", "JOIN|1.00|3|Charlie",
    "ROUND_START|2.00|1|1,2,3", "ELIM|3.00|1|2|1|3", "KILL|3.00|Alfa|Bravo|1|2", "ELIM|4.00|1|3|1|2", "KILL|4.00|Alfa|Charlie|1|3", "ROUND_END|4.00|1|1|WIN",
  ]);
  const alphaOnly = lines("000000000033", [
    "JOIN|1.00|1|Alpha", "JOIN|1.00|2|Bravo",
    "ROUND_START|2.00|1|1,2", "ELIM|3.00|1|2|1|2", "KILL|3.00|Alpha|Bravo|1|2", "ROUND_END|3.00|1|1|WIN",
  ]);
  const matchPairs = async () =>
    (await db().prepare("SELECT match_id, player_id, opponent_id, rounds, ahead, kills, deaths FROM match_pairs ORDER BY 1, 2, 3").all()).results;
  /** match_pairs as a fresh derivation from the rounds and events gives, and pair_stats as their sum. */
  async function expectAsRederived() {
    await expectTotalsMatchPairs();
    const [pairs, totals] = [await matchPairs(), await pairStats()];
    const ids = (await db().prepare("SELECT min(id) AS lo, max(id) AS hi FROM matches").first<{ lo: number; hi: number }>())!;
    await db().batch(rebuildPairsStatements(ids.lo, ids.hi).map((s) => db().prepare(s)));
    expect(await matchPairs()).toEqual(pairs);
    expect(await pairStats()).toEqual(totals);
  }

  it("re-derives the moved matches' pairs on merge and undo, and the totals follow exactly", async () => {
    await upload(shared, 4);
    await upload(alfaOnly, 3, "na");
    await upload(alphaOnly, 2);
    const { Alpha, Alfa, Bravo, Charlie } = await ids();
    const pairsBefore = await matchPairs();
    const totalsBefore = await pairStats();
    // Both have totals against Bravo in EU (the primary key the merge makes them share).
    expect(totalsBefore.filter((r) => r.region === "eu" && r.opponentId === Bravo && (r.playerId === Alpha || r.playerId === Alfa))).toHaveLength(2);

    const merged = await admin(`players/${Alfa}/merge`, { into: Alpha });
    expect(merged.status, await merged.clone().text()).toBe(200);
    const { merge } = await merged.json<{ merge: { id: number } }>();
    const involving = (rows: Record<string, unknown>[]) => rows.filter((r) => [r.player_id, r.opponent_id, r.playerId, r.opponentId].includes(Alfa));
    expect(involving(await matchPairs())).toEqual([]);
    expect(involving(await pairStats())).toEqual([]);
    expect((await pairStats()).filter((r) => r.playerId === r.opponentId)).toEqual([]);
    // Alpha against Bravo in EU: Alpha's rounds 1 and 2 of match 31 and match 33. Charlie: both rounds of 31.
    expect(await get<HeadToHead>(`head-to-head?a=${Alpha}&b=${Bravo}`)).toMatchObject({ rounds: 3, a: { kills: 3 }, b: { kills: 0 } });
    expect(await get<HeadToHead>(`head-to-head?a=${Alpha}&b=${Charlie}`)).toMatchObject({ rounds: 2, a: { kills: 1 }, b: { kills: 1 } });
    // The old id answers as the player it was merged into.
    expect(await get<HeadToHead>(`head-to-head?a=${Alfa}&b=${Bravo}&region=na`)).toMatchObject({ rounds: 1, a: { id: Alpha, kills: 1 } });
    await expectAsRederived();

    const undone = await admin(`merges/${merge.id}/undo`, {});
    expect(undone.status, await undone.clone().text()).toBe(200);
    expect(await matchPairs()).toEqual(pairsBefore);
    expect(await pairStats()).toEqual(totalsBefore);
    await expectAsRederived();
  });

  it("refuses a merge or undo that would rewrite more pairs than playerMergeMaxPairRows, writing nothing", async () => {
    await upload(alfaOnly, 3);
    await upload(alphaOnly, 2);
    const { Alpha, Alfa } = await ids();
    const pairs = await matchPairs();
    const totals = await pairStats();
    const capped = (path: string) =>
      handleAdmin(
        new Request(`https://example.com/api/admin/${path}`, { method: "POST", body: JSON.stringify({ into: Alpha }), headers: { Authorization: `Bearer ${adminToken}` } }),
        db(), env.PROOFS, { ...defaults, playerMergeMaxPairRows: 1 }, createLogger("error"),
      );
    const refused = await capped(`players/${Alfa}/merge`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "too_large" });
    expect(await matchPairs()).toEqual(pairs);
    expect(await pairStats()).toEqual(totals);
    expect((await db().prepare("SELECT count(*) AS n FROM player_merges").first<{ n: number }>())!.n).toBe(0);

    // With the default limit the merge goes through, and its undo is refused the same way.
    const merged = await admin(`players/${Alfa}/merge`, { into: Alpha });
    const { merge } = await merged.json<{ merge: { id: number } }>();
    const undoRefused = await capped(`merges/${merge.id}/undo`);
    expect(undoRefused.status).toBe(409);
    expect(await undoRefused.json()).toMatchObject({ error: "too_large" });
  });

  it("refuses a head-to-head of a player with the one they were merged into", async () => {
    await upload(alfaOnly, 3);
    await upload(alphaOnly, 2);
    const { Alpha, Alfa } = await ids();
    expect((await admin(`players/${Alfa}/merge`, { into: Alpha })).status).toBe(200);
    expect(await get(`head-to-head?a=${Alfa}&b=${Alpha}`, 400)).toMatchObject({ error: "bad_request" });
  });
});
