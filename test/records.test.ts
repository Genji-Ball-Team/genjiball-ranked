import { createScheduledController, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import worker from "../src/index";
import { createLogger } from "../src/log";
import { queryBudget } from "../src/budget";
import { matchStats, recordsView, noRecords, type MatchCounts } from "../src/records/stats";
import { readFeedChanges, readMatchCounts, syncStatements } from "../src/records/store";
import { isDue, rebuildRecords, refreshQueries, syncMatchStats, syncQueries, updateRecords } from "../src/records/update";
import { markAllStale, rateNewQueries, recomputeQueries } from "../src/rating/update";
import { sha256 } from "../src/upload/handler";
import { matchId } from "./helpers";

const db = () => env.DB;
const log = createLogger("error");
const adminToken = "records-admin";
const tokens = { eu: "records-eu", na: "records-na" };
const names = ["Alpha", "Bravo", "Charlie", "Delta"];

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = [
    "admin_actions", "admins", "match_stats", "records", "records_revisions", "screenshot_deletions", "events", "round_players", "rounds", "match_players",
    "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts",
  ];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE records_state SET feed_cursor = 0"),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'eu host', ?, 'trusted', 'eu')").bind(await sha256(tokens.eu)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (2, 'na host', ?, 'trusted', 'na')").bind(await sha256(tokens.na)),
  ]);
});

/**
 * A 4-player match like `matchLog` (Alpha wins round 1, Bravo round 2), with `DEFLECT`s
 * (`[round, id, speed]`) and `KILL`s (`[attacker id, victim id]`, in round 1).
 */
function richLog({ key = "000000000001", deflects = [] as [number, number, number][], kills = [] as [number, number][], rounds = 2 } = {}): string {
  const lines = [`GBR|1.00|1|1.3.3R|${key}`, "MATCH_START|1.00|workshop-island-night|Default|0|"];
  names.forEach((name, i) => lines.push(`JOIN|1.00|${i + 1}|${name}`));
  const roundDeflects = (round: number) =>
    deflects.filter(([r]) => r === round).map(([r, id, speed]) => `DEFLECT|2.50|${r}|${id}|${speed}|${(id % 4) + 1}`);
  lines.push("ROUND_START|2.00|1|1,2,3,4", ...roundDeflects(1));
  lines.push(...kills.map(([a, v]) => `KILL|2.80|${names[a - 1]}|${names[v - 1]}|${a}|${v}`));
  lines.push("ELIM|3.00|1|2|1|4", "ELIM|4.00|1|3|1|3", "ELIM|5.00|1|4|1|2", "ROUND_END|5.00|1|1|WIN");
  if (rounds >= 2) {
    lines.push("ROUND_START|6.00|2|1,2,3,4", ...roundDeflects(2));
    lines.push("ELIM|7.00|2|1|2|4", "ELIM|8.00|2|3|2|3", "ELIM|9.00|2|4|2|2", "ROUND_END|9.00|2|2|WIN", "MATCH_END|10.00|TIME");
  }
  return lines.map((line) => `[00:00:01] ${line}`).join("\r\n");
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const later = (minutes: number) => new Date(Date.now() + minutes * 60 * 1000);

async function upload(body: string, hours: number, token = tokens.eu) {
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

/** Brings the match stats up to date and rebuilds both regions' records now. */
async function refresh(now = new Date()) {
  while (await syncMatchStats(db(), defaults, log));
  for (const region of ["eu", "na"]) {
    const { revision, version } = await revisions(region);
    await rebuildRecords(db(), defaults, region, revision, version, now);
  }
}

async function revisions(region: string) {
  const row = await db()
    .prepare(
      `SELECT coalesce((SELECT revision FROM records_revisions WHERE region = ?1), 0) AS revision,
         coalesce((SELECT urgent FROM records_revisions WHERE region = ?1), 0) AS urgent,
         coalesce((SELECT version FROM rating_state WHERE board = ?1), 0) AS version`,
    )
    .bind(region)
    .first<{ revision: number; urgent: number; version: number }>();
  return row!;
}

type RecordsResponse = ReturnType<typeof recordsView> & { region: string; updatedAt: string | null };

async function records(query = ""): Promise<RecordsResponse> {
  const res = await SELF.fetch(`https://example.com/api/records${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.publicCacheSeconds}`);
  return res.json();
}

describe("match stats", () => {
  const match = { id: 7, seq: 1, status: "accepted", region: "eu", hostId: 1, playedAt: "2026-10-05T20:00:00Z", lineCount: 40 };

  it("groups a long-match batch with work proportional to its input, not matches times input", () => {
    const matches = Array.from({ length: defaults.recordsMatchesPerRun }, (_, i) => ({ ...match, id: i + 1 }));
    const counts: MatchCounts = { deflects: [], kills: [], wins: [], ratedRounds: [], players: [] };
    let visited = 0;
    for (const m of matches) {
      for (let logId = 1; logId <= 12; logId++) {
        counts.players.push({ matchId: m.id, logId, playerId: logId });
        counts.kills.push({ matchId: m.id, logId, count: logId });
        counts.wins.push({ matchId: m.id, logId, count: logId });
        for (let round = 1; round <= 100; round++) {
          counts.deflects.push({ get matchId() { visited++; return m.id; }, round, logId, count: logId, fastest: round });
        }
      }
      counts.ratedRounds.push({ matchId: m.id, count: 100 });
    }
    // Deterministic benchmark: Workers freeze wall-clock time between I/O, so measuring CPU
    // with performance.now() here would report zero. Count scanned input rows instead.
    const rows = matchStats(matches, counts);
    expect(visited).toBe(counts.deflects.length);
    expect(rows).toHaveLength(defaults.recordsMatchesPerRun);
    for (const [i, row] of rows.entries()) {
      expect(row).toMatchObject({ matchId: i + 1, ratedRounds: 100, roundDeflects: 12, roundDeflectsBy: 12,
        roundDeflectsRound: 1, fastestDeflect: 100, fastestDeflectBy: 1, fastestDeflectRound: 100,
        matchKills: 12, matchKillsBy: 12, matchWins: 12, matchWinsBy: 12 });
    }
  });

  it("adds up a rejoined player's two log ids, and names them by the newest", () => {
    const [row] = matchStats([match], {
      deflects: [
        { matchId: 7, round: 1, logId: 1, count: 2, fastest: 30 },
        { matchId: 7, round: 1, logId: 2, count: 2, fastest: 40 },
      ],
      kills: [
        { matchId: 7, logId: 1, count: 2 },
        { matchId: 7, logId: 3, count: 2 },
        { matchId: 7, logId: 2, count: 1 },
      ],
      wins: [{ matchId: 7, logId: 2, count: 1 }],
      ratedRounds: [{ matchId: 7, count: 1 }],
      players: [
        { matchId: 7, logId: 1, playerId: 100 },
        { matchId: 7, logId: 2, playerId: 200 },
        { matchId: 7, logId: 3, playerId: 100 },
      ],
    });
    expect(row).toMatchObject({ matchKills: 4, matchKillsBy: 3, matchWins: 1, matchWinsBy: 2, ratedRounds: 1, fastestDeflect: 40, fastestDeflectBy: 2 });
  });

  it("breaks a tie to the earliest round, then the lowest log id", () => {
    const [row] = matchStats([match], {
      deflects: [
        { matchId: 7, round: 2, logId: 1, count: 3, fastest: 50 },
        { matchId: 7, round: 1, logId: 3, count: 3, fastest: 50 },
        { matchId: 7, round: 1, logId: 2, count: 3, fastest: 20 },
      ],
      kills: [],
      wins: [],
      ratedRounds: [],
      players: [1, 2, 3].map((logId) => ({ matchId: 7, logId, playerId: logId })),
    });
    expect(row).toMatchObject({ roundDeflects: 3, roundDeflectsBy: 2, roundDeflectsRound: 1, fastestDeflect: 50, fastestDeflectBy: 3, fastestDeflectRound: 1 });
    expect(row).toMatchObject({ matchKills: null, matchKillsBy: null, matchWins: null, ratedRounds: 0 });
  });
});

describe("GET /api/records", () => {
  it("answers the region's records, activity and top hosts", async () => {
    await upload(richLog({ deflects: [[1, 1, 20], [1, 1, 35], [1, 1, 30], [1, 2, 50], [2, 3, 10], [2, 3, 12]], kills: [[2, 3], [2, 4], [1, 2]] }), 3);
    await refresh();
    const ids = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await playerId(n)] as const)));
    const id = await matchId("000000000001");
    const playedAt = (await db().prepare("SELECT played_at FROM matches WHERE id = ?").bind(id).first<string>("played_at"))!;
    const body = await records();
    const firstId = Math.min(...Object.values(ids));
    const first = names.find((n) => ids[n] === firstId)!;
    expect(body.region).toBe("eu");
    expect(body.updatedAt).not.toBeNull();
    expect(body.records).toEqual({
      roundDeflects: { value: 3, player: { id: ids.Alpha, name: "Alpha" }, matchId: id, playedAt, round: 1 },
      fastestDeflect: { value: 50, player: { id: ids.Bravo, name: "Bravo" }, matchId: id, playedAt, round: 1 },
      matchKills: { value: 2, player: { id: ids.Bravo, name: "Bravo" }, matchId: id, playedAt },
      // One win each: the lowest log id, Alpha.
      matchWins: { value: 1, player: { id: ids.Alpha, name: "Alpha" }, matchId: id, playedAt },
      highestRating: expect.objectContaining({ matchId: id, playedAt }),
      // Everyone has a best streak of 1, 2 rounds and 1 win: the lowest player id.
      winStreak: { value: 1, player: { id: firstId, name: first } },
      mostRounds: { value: 2, player: { id: firstId, name: first } },
      mostWins: { value: 1, player: { id: firstId, name: first } },
    });
    const top = await db().prepare("SELECT max(display) AS top FROM rating_history WHERE board = 'eu'").first<number>("top");
    expect(body.records.highestRating!.value).toBe(top);

    expect(body.activity).toMatchObject({ days: defaults.recordsActivityDays, matches: 1, rounds: 2, players: 4 });
    expect(body.activity.perDay).toHaveLength(defaults.recordsActivityDays);
    expect(body.activity.perDay.find((d) => d.date === playedAt.slice(0, 10))).toEqual({ date: playedAt.slice(0, 10), matches: 1, rounds: 2, players: 4 });
    expect(body.topHosts).toEqual([{ name: "eu host", matches: 1 }]);
  });

  it("keeps the regions apart", async () => {
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20]] }), 3);
    await upload(richLog({ key: "000000000002", deflects: [[1, 2, 90], [1, 2, 80]] }), 2, tokens.na);
    await upload(richLog({ key: "000000000003" }), 1, tokens.na);
    await refresh();
    const eu = await records();
    const na = await records("?region=na");
    expect(eu.records.fastestDeflect).toMatchObject({ value: 20, matchId: await matchId("000000000001") });
    expect(na).toMatchObject({ region: "na", records: { fastestDeflect: { value: 90, matchId: await matchId("000000000002") }, roundDeflects: { value: 2 } } });
    expect(eu.topHosts).toEqual([{ name: "eu host", matches: 1 }]);
    expect(na.topHosts).toEqual([{ name: "na host", matches: 2 }]);
    expect(eu.activity.matches).toBe(1);
    expect(na.activity.matches).toBe(2);
  });

  it("follows a match moved to the other region after the next refresh", async () => {
    await upload(richLog({ deflects: [[1, 1, 20]] }), 3);
    await refresh();
    const id = await matchId("000000000001");
    const res = await SELF.fetch(`https://example.com/api/admin/matches/${id}/region`, {
      method: "POST",
      body: JSON.stringify({ region: "na" }),
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await db().prepare("SELECT region FROM match_stats WHERE match_id = ?").bind(id).first("region")).toBe("na");
    expect((await revisions("eu")).urgent).toBe((await revisions("eu")).revision);
    expect((await revisions("na")).revision).toBeGreaterThan(0);

    await refresh(later(defaults.recordsRefreshMinutes));
    const eu = await records();
    const na = await records("?region=na");
    expect(eu.records.fastestDeflect).toBeNull();
    expect(eu.topHosts).toEqual([]);
    expect(na.records.fastestDeflect).toMatchObject({ value: 20, matchId: id });
    expect(na.topHosts).toEqual([{ name: "eu host", matches: 1 }]);
  });

  it("drops a voided match, and counts only the longest copy", async () => {
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20]], rounds: 1 }), 3);
    await syncMatchStats(db(), defaults, log);
    const id = await matchId("000000000001");
    expect(await db().prepare("SELECT rated_rounds FROM match_stats WHERE match_id = ?").bind(id).first("rated_rounds")).toBe(1);
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20], [2, 1, 60]] }), 3);
    await syncMatchStats(db(), defaults, log);
    expect(await db().prepare("SELECT rated_rounds, fastest_deflect FROM match_stats WHERE match_id = ?").bind(id).first()).toEqual({ rated_rounds: 2, fastest_deflect: 60 });

    await db().prepare("UPDATE matches SET status = 'void' WHERE id = ?").bind(id).run();
    await refresh();
    expect(await db().prepare("SELECT COUNT(*) AS n FROM match_stats").first("n")).toBe(0);
    const body = await records();
    expect(body.records).toMatchObject({ roundDeflects: null, fastestDeflect: null, matchKills: null, matchWins: null });
    expect(body.topHosts).toEqual([]);
  });

  it("rebuilds the same stats from the stored matches when the cursor goes back to 0", async () => {
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20], [2, 3, 40]], kills: [[1, 2]] }), 3);
    await upload(richLog({ key: "000000000002", deflects: [[1, 4, 70]] }), 2);
    await syncMatchStats(db(), defaults, log);
    const before = await db().prepare("SELECT * FROM match_stats ORDER BY match_id").all();
    await db().batch([db().prepare("DELETE FROM match_stats"), db().prepare("UPDATE records_state SET feed_cursor = 0")]);
    await syncMatchStats(db(), defaults, log);
    expect((await db().prepare("SELECT * FROM match_stats ORDER BY match_id").all()).results).toEqual(before.results);
  });

  it("answers empty records before the first refresh, and a 400 for an unknown region", async () => {
    const body = await records("?region=na");
    expect(body).toMatchObject({ region: "na", updatedAt: null, records: noRecords, topHosts: [], activity: { matches: 0, rounds: 0, players: 0 } });
    expect(body.activity.perDay).toHaveLength(defaults.recordsActivityDays);
    const res = await SELF.fetch("https://example.com/api/records?region=mars");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
    expect((await SELF.fetch("https://example.com/api/records", { method: "POST" })).status).toBe(405);
  });
});

describe("records: matches that stop counting", () => {
  it("never names a record holder's match once it's back in review, and rebuilds at the next cron run", async () => {
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20]] }), 3);
    await upload(richLog({ key: "000000000002", deflects: [[1, 2, 90]] }), 2);
    await refresh();
    const second = await matchId("000000000002");
    expect((await records()).records.fastestDeflect).toMatchObject({ matchId: second });

    // A longer copy sent it back to review: the trigger drops its stats in the same transaction.
    await db().prepare("UPDATE matches SET status = 'review' WHERE id = ?").bind(second).run();
    expect(await db().prepare("SELECT COUNT(*) AS n FROM match_stats WHERE match_id = ?").bind(second).first("n")).toBe(0);
    // Served from the stored page until the rebuild, without the match.
    const served = await records();
    expect(served.records.fastestDeflect).toBeNull();
    expect(JSON.stringify(served.records)).not.toContain(`"matchId":${second}`);

    // Due at once, inside recordsRefreshMinutes.
    await updateRecords(db(), defaults, new Date(), log);
    expect((await records()).records.fastestDeflect).toMatchObject({ value: 20, matchId: await matchId("000000000001") });
  });

  it("counts only matches accepted in the region now when rebuilding", async () => {
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20]] }), 3);
    await refresh();
    // A stats row the triggers didn't see go (written by hand here): the rebuild still leaves it out.
    const id = await matchId("000000000001");
    await db().batch([
      db().prepare("DROP TRIGGER match_stats_leave"),
      db().prepare("UPDATE matches SET status = 'rejected' WHERE id = ?").bind(id),
    ]);
    try {
      expect(await db().prepare("SELECT COUNT(*) AS n FROM match_stats").first("n")).toBe(1);
      await rebuildRecords(db(), defaults, "eu", 99, 0, new Date());
      const body = await records();
      expect(body.records).toMatchObject({ roundDeflects: null, fastestDeflect: null, matchWins: null });
      expect(body.topHosts).toEqual([]);
      expect(body.activity.matches).toBe(0);
    } finally {
      await db().prepare(MIGRATION_TRIGGER).run();
    }
  });

  it("writes nothing when another run moved the cursor first", async () => {
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20]] }), 3);
    const { cursor, matches } = await readFeedChanges(db(), defaults.recordsMatchesPerRun);
    const stats = matchStats(matches, await readMatchCounts(db(), matches.map((m) => m.id)));
    await db().prepare("UPDATE records_state SET feed_cursor = feed_cursor + 1").run();
    await expect(db().batch(syncStatements(db(), cursor, matches.at(-1)!.seq, matches.map((m) => m.id), stats, ["eu"]))).rejects.toThrow(
      "feed_cursor",
    );
    expect(await db().prepare("SELECT COUNT(*) AS n FROM match_stats").first("n")).toBe(0);
    expect((await revisions("eu")).revision).toBe(0);
  });

  it("checks status and region when it writes, not when it read", async () => {
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20]] }), 3);
    await upload(richLog({ key: "000000000002", deflects: [[1, 1, 30]] }), 2);
    const { cursor, matches } = await readFeedChanges(db(), defaults.recordsMatchesPerRun);
    const stats = matchStats(matches, await readMatchCounts(db(), matches.map((m) => m.id)));
    const [first, second] = [await matchId("000000000001"), await matchId("000000000002")];
    // Between the read and the write: one voided, one moved to NA.
    await db().prepare("UPDATE matches SET status = 'void' WHERE id = ?").bind(first).run();
    await db().prepare("UPDATE matches SET region = 'na' WHERE id = ?").bind(second).run();
    await db().batch(syncStatements(db(), cursor, matches.at(-1)!.seq, matches.map((m) => m.id), stats, ["eu"]));
    expect((await db().prepare("SELECT match_id AS id, region FROM match_stats").all()).results).toEqual([{ id: second, region: "na" }]);
    expect((await revisions("na")).revision).toBeGreaterThan(0);
  });

  it("keeps a change made during a rebuild: an older revision never overwrites a newer page", async () => {
    await upload(richLog({ key: "000000000001", deflects: [[1, 1, 20]] }), 3);
    await syncMatchStats(db(), defaults, log);
    const before = await revisions("eu");
    // A change lands while the rebuild that read `before` runs.
    await db().prepare("UPDATE records_revisions SET revision = revision + 1 WHERE region = 'eu'").run();
    await rebuildRecords(db(), defaults, "eu", before.revision, before.version, new Date());
    const [state] = (await db().prepare("SELECT revision FROM records WHERE region = 'eu'").all<{ revision: number }>()).results;
    expect(state!.revision).toBe(before.revision);
    const later = new Date(Date.now() + defaults.recordsRefreshMinutes * 60 * 1000);
    expect(isDue({ region: "eu", version: before.version, ratingVersion: before.version, revision: before.revision + 1, urgent: 0, builtRevision: before.revision, refreshedAt: new Date().toISOString() }, defaults, later)).toBe(true);
    // A slower run that read an even older revision doesn't overwrite it.
    await rebuildRecords(db(), defaults, "eu", before.revision - 1, before.version, new Date());
    expect(await db().prepare("SELECT revision FROM records WHERE region = 'eu'").first("revision")).toBe(before.revision);
  });
});

describe("records refresh", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const state = { region: "eu", version: 3, revision: 4, urgent: 2, refreshedAt: "2026-10-05T11:30:00Z", builtRevision: 4, ratingVersion: 3 };
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  it("advances a backlog by only the configured stats batch on each cron run", async () => {
    const size = defaults.recordsMatchesPerRun;
    await upload(Array.from({ length: size + 2 }, (_, i) => richLog({ key: String(i + 1).padStart(12, "0"), deflects: [[1, 1, i + 20]] })).join("\r\n"), 3);
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), env);
    expect(await db().prepare("SELECT COUNT(*) FROM match_stats").first("COUNT(*)")).toBe(size);
    const cursor = await db().prepare("SELECT feed_cursor FROM records_state").first<number>("feed_cursor");
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), env);
    expect(await db().prepare("SELECT COUNT(*) FROM match_stats").first("COUNT(*)")).toBe(size + 2);
    expect(await db().prepare("SELECT feed_cursor FROM records_state").first<number>("feed_cursor")).toBeGreaterThan(cursor!);
  });

  it("refreshes a region never refreshed, a match leaving at once, other changes once recordsRefreshMinutes have passed", () => {
    expect(isDue({ ...state, refreshedAt: null, builtRevision: null, ratingVersion: null }, defaults, now)).toBe(true);
    expect(isDue({ ...state, revision: 5 }, defaults, now)).toBe(false);
    expect(isDue({ ...state, revision: 5, urgent: 5 }, defaults, now)).toBe(true);
    const old = minutesAgo(defaults.recordsRefreshMinutes);
    expect(isDue({ ...state, refreshedAt: old }, defaults, now)).toBe(false);
    expect(isDue({ ...state, refreshedAt: old, revision: 5 }, defaults, now)).toBe(true);
    expect(isDue({ ...state, refreshedAt: old, ratingVersion: 2 }, defaults, now)).toBe(true);
    // A new day moves the activity window.
    expect(isDue({ ...state, refreshedAt: "2026-10-04T23:00:00Z" }, defaults, now)).toBe(true);
  });

  it("leaves the records to the next run when the invocation's queries are short", async () => {
    await upload(richLog({ deflects: [[1, 1, 20]] }), 3);
    await updateRecords(db(), defaults, new Date(), log, queryBudget(db(), syncQueries - 1));
    expect(await db().prepare("SELECT COUNT(*) AS n FROM match_stats").first("n")).toBe(0);
    const short = queryBudget(db(), syncQueries + refreshQueries - 1);
    await updateRecords(short.db, defaults, new Date(), log, short);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM match_stats").first("n")).toBe(1);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM records").first("n")).toBe(0);
  });

  it("stays inside D1's queries an invocation with both regions busy, and still cleans up", async () => {
    // Both regions: rated matches, all stale (a recompute), a newer unrated one (rated on top), new
    // feed changes for the records, and a screenshot delete waiting.
    for (const [token, keys] of [[tokens.eu, ["000000000001", "000000000002", "000000000003"]], [tokens.na, ["000000000011", "000000000012", "000000000013"]]] as const) {
      for (const [i, key] of keys.entries()) await upload(richLog({ key, deflects: [[1, 1, 20 + i]] }), 6 - i, token);
    }
    await db().prepare("UPDATE matches SET rated_at = NULL WHERE match_key IN ('000000000003', '000000000013')").run();
    await markAllStale(db(), new Date());
    await db().prepare("INSERT INTO screenshot_deletions (key, bytes, queued_at, delete_after) VALUES ('busy.png', 5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
    await env.PROOFS.put("busy.png", "proof");

    const counted = queryBudget(env.DB, Infinity);
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), { ...env, DB: counted.db });
    expect(counted.used()).toBeLessThanOrEqual(defaults.d1QueriesPerInvocation);
    expect(await env.PROOFS.get("busy.png")).toBeNull();
    // What didn't fit is done by the next runs, each inside the limit too.
    for (let run = 0; run < 4; run++) {
      const next = queryBudget(env.DB, Infinity);
      await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), { ...env, DB: next.db });
      expect(next.used()).toBeLessThanOrEqual(defaults.d1QueriesPerInvocation);
    }
    expect(await db().prepare("SELECT COUNT(*) AS n FROM rating_state WHERE stale_played_at IS NOT NULL").first("n")).toBe(0);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM matches WHERE rated_at IS NULL").first("n")).toBe(0);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM match_stats").first("n")).toBe(6);
    expect((await db().prepare("SELECT region FROM records ORDER BY region").all()).results).toEqual([{ region: "eu" }, { region: "na" }]);
    // The worst cases the cron plans with are what the steps can make.
    expect(2 * rateNewQueries + 2 * recomputeQueries).toBeGreaterThan(defaults.d1QueriesPerInvocation - defaults.cronCleanupQueries);
  });

  it("runs on the cron: stats, then one region's records a run", async () => {
    await upload(richLog({ deflects: [[1, 1, 20]] }), 3);
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), env);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM match_stats").first("n")).toBe(1);
    expect((await db().prepare("SELECT region FROM records").all()).results).toEqual([{ region: "eu" }]);
    expect((await records()).records.fastestDeflect).toMatchObject({ value: 20 });
    await updateRecords(db(), defaults, new Date(), log);
    expect((await db().prepare("SELECT region FROM records ORDER BY region").all()).results).toEqual([{ region: "eu" }, { region: "na" }]);
  });
});

/** The trigger of migrations/0015_records.sql, to put back after a test drops it. */
const MIGRATION_TRIGGER = `CREATE TRIGGER match_stats_leave AFTER UPDATE OF status, region ON matches
WHEN OLD.status = 'accepted' AND (NEW.status IS NOT 'accepted' OR NEW.region IS NOT OLD.region)
BEGIN
  DELETE FROM match_stats WHERE match_id = NEW.id AND NEW.status IS NOT 'accepted';
  UPDATE match_stats SET region = NEW.region WHERE match_id = NEW.id;
  INSERT OR IGNORE INTO records_revisions (region) VALUES (OLD.region);
  UPDATE records_revisions SET revision = revision + 1, urgent = revision + 1 WHERE region = OLD.region;
  INSERT OR IGNORE INTO records_revisions (region) SELECT NEW.region WHERE NEW.region IS NOT OLD.region;
  UPDATE records_revisions SET revision = revision + 1 WHERE region = NEW.region AND NEW.region IS NOT OLD.region;
END`;
