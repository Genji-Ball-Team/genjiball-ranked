import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin/handler";
import { defaults, loadConfig } from "../src/config";
import { createLogger } from "../src/log";
import { diffRatings } from "../src/rating/diff";
import { sha256 } from "../src/upload/handler";
import example from "./fixtures/ranked-log-example.txt?raw";
import { expectUpToDate, matchId, matchLog } from "./helpers";

// The admin debug tools (#33): the dry-run parse and the recompute (dry run or not).

const db = () => env.DB;
const adminToken = "admin-token";
const tokens = { eu: "eu-host", na: "na-host", untrusted: "untrusted-host" };

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = [
    "admin_actions", "admins", "tourney_lobbies", "tourneys", "events", "round_players", "rounds", "match_players",
    "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts",
  ];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'eu host', ?, 'trusted', 'eu')").bind(await sha256(tokens.eu)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (2, 'na host', ?, 'trusted', 'na')").bind(await sha256(tokens.na)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust) VALUES (3, 'untrusted', ?, 'untrusted')").bind(await sha256(tokens.untrusted)),
  ]);
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

async function upload(body: string, token: string, startedAt: string) {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": startedAt },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

function post(path: string, body?: string, token: string | null = adminToken, method = "POST") {
  return SELF.fetch(`https://example.com/api/admin/${path}`, {
    method,
    body: method === "GET" ? undefined : body,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function postOk<T = Record<string, unknown>>(path: string, body?: string): Promise<T> {
  const res = await post(path, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

/** Every table a dry run must leave alone, to check nothing was written. */
async function snapshot() {
  const tables = ["uploads", "matches", "players", "aliases", "match_players", "rounds", "round_players", "events", "ratings", "rating_history", "rating_state", "admin_actions"];
  const rows = await db().batch(tables.map((t) => db().prepare(`SELECT * FROM ${t}`)));
  return Object.fromEntries(tables.map((t, i) => [t, rows[i]!.results.map((row) => JSON.stringify(row)).sort()]));
}

type Parsed = {
  region: string | null;
  upload: { status: number; result?: string; error?: string };
  duplicateOf: number | null;
  matches: {
    matchKey: string;
    region: string | null;
    action: string;
    status: string;
    rejection: { code: string } | null;
    reviewReasons: string[];
    storedMatchId: number | null;
    format: number;
    complete: boolean;
    ratedRounds: number;
    players: { id: number; name: string }[];
    rounds: { number: number; rated: boolean; left: number[]; placements: { position: number; id: number; name: string }[] }[];
    kills: number;
    deflects: number;
  }[];
  warnings: string[];
};

describe("POST /api/admin/parse", () => {
  it("answers what the parser makes of the spec's example, writing nothing", async () => {
    const before = await snapshot();
    const body = await postOk<Parsed>("parse", example);
    expect(await snapshot()).toEqual(before);

    expect(body.upload).toEqual({ status: 200, result: "stored" });
    expect(body.region).toBeNull();
    expect(body.matches).toHaveLength(1);
    const [m] = body.matches;
    expect(m).toMatchObject({
      matchKey: "482913507226",
      format: 1,
      action: "insert",
      status: "review",
      rejection: null,
      reviewReasons: ["duplicate_name"],
      storedMatchId: null,
      complete: true,
      ratedRounds: 3,
    });
    expect(m!.players.map((p) => p.name)).toEqual(["Sparrow", "Tidal", "Mochi", "Ghost", "Ghost", "Nova"]);
    expect(m!.rounds.map((r) => r.placements.map((p) => p.id))).toEqual([
      [1, 5, 3, 4],
      [6, 5, 1, 4, 3],
      [1, 4, 5, 3, 6],
    ]);
    expect(m!.rounds[0]!.left).toEqual([2]);
    expect(m!.rounds[0]!.placements[0]).toEqual({ position: 1, id: 1, name: "Sparrow" });
    expect(m!.kills).toBeGreaterThan(0);
    expect(m!.deflects).toBeGreaterThan(0);
  });

  it("echoes region into the matches and refuses one that isn't a region", async () => {
    const body = await postOk<Parsed>("parse?region=NA", matchLog());
    expect(body.region).toBe("na");
    expect(body.matches[0]!.region).toBe("na");
    expect(body.matches[0]!.status).toBe("accepted");
    expect((await post("parse?region=mars", matchLog())).status).toBe(400);
  });

  it("plans against a host's stored copies, which keep their region", async () => {
    await upload(matchLog({ rounds: 1 }), tokens.eu, hoursAgo(1));
    const stored = await matchId("000000000001");

    const longer = await postOk<Parsed>("parse?host=1&region=na", matchLog());
    expect(longer.upload).toEqual({ status: 200, result: "stored" });
    expect(longer.matches[0]).toMatchObject({ action: "replace", storedMatchId: stored, region: "eu" });

    const shorter = await postOk<Parsed>("parse?host=1", matchLog({ rounds: 1, end: false }));
    expect(shorter.upload.result).toBe("unchanged");
    expect(shorter.matches[0]).toMatchObject({ action: "skip", region: "eu" });

    const same = await postOk<Parsed>("parse?host=1", matchLog({ rounds: 1 }));
    expect(same.upload.result).toBe("duplicate");
    expect(same.duplicateOf).not.toBeNull();

    // Another host's copy isn't this host's match.
    expect((await postOk<Parsed>("parse?host=2", matchLog())).matches[0]).toMatchObject({ action: "insert", region: "na" });
    expect((await post("parse?host=99", matchLog())).status).toBe(404);
    expect((await post("parse?host=abc", matchLog())).status).toBe(400);
  });

  it("judges as the host's trust, and says when the host has no region", async () => {
    const body = await postOk<Parsed>("parse?host=3", matchLog());
    expect(body.matches[0]).toMatchObject({ status: "review", reviewReasons: ["untrusted_host"] });
    expect(body.upload).toMatchObject({ status: 422, error: "no_region" });
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it("says what an upload would answer for a file with no ranked match", async () => {
    const notRanked = await postOk<Parsed>("parse", "[00:00:01] hello");
    expect(notRanked.upload).toMatchObject({ status: 422, error: "not_ranked" });
    expect(notRanked.matches).toEqual([]);

    const legacyFile = ["10.00|Alpha|Bravo", "11.00|Alpha|Charlie", "20.00|Bravo|Alpha", "21.00|Bravo|Charlie"]
      .map((line) => `[00:00:01] KILL|${line}`)
      .join("\r\n");
    expect((await postOk<Parsed>("parse", legacyFile)).upload).toMatchObject({ status: 422, error: "legacy_log" });
    const legacy = await postOk<Parsed>("parse?legacy=1", legacyFile);
    expect(legacy.upload).toEqual({ status: 200, result: "stored" });
    expect(legacy.matches[0]).toMatchObject({ format: 0, status: "accepted", ratedRounds: 2 });
  });

  it("warns about an incomplete match and several copies in one file", async () => {
    const body = await postOk<Parsed>("parse", `${matchLog({ rounds: 1, end: false })}\r\n${matchLog()}`);
    expect(body.matches).toHaveLength(1);
    expect(body.warnings.join("\n")).toMatch(/2 copies of match 000000000001/);
    expect((await postOk<Parsed>("parse", matchLog({ end: false }))).warnings.join("\n")).toMatch(/no MATCH_END/);
  });

  it("has the upload's size limit, and needs an admin and a POST", async () => {
    expect((await post("parse", "x".repeat(defaults.maxUploadBytes + 1))).status).toBe(413);
    expect((await post("parse", "")).status).toBe(400);
    expect((await post("parse", matchLog(), null)).status).toBe(401);
    expect((await post("parse", matchLog(), tokens.eu)).status).toBe(401);
    expect((await post("parse", undefined, adminToken, "GET")).status).toBe(405);
  });
});

type Diff = {
  dryRun: boolean;
  region: string;
  staleFrom: unknown;
  matches: { counted: number; recomputed: number; capped: boolean; until: { id: number } | null };
  summary: { players: number; changed: number; added: number; removed: number; up: number; down: number; biggestGain: number; biggestLoss: number; identical: boolean };
  truncated: boolean;
  players: { playerId: number; name: string; before: { display: number; rank: number | null } | null; after: { display: number; rank: number | null } | null; change: number | null; rankChange: number | null }[];
};

const playerId = async (name: string) =>
  (await db().prepare("SELECT id FROM players WHERE name = ?").bind(name).first<{ id: number }>())!.id;

describe("POST /api/admin/ratings/recompute?dryRun=1", () => {
  it("finds nothing to change when the ratings are up to date, writing nothing", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002" }), tokens.eu, hoursAgo(1));
    const before = await snapshot();
    const body = await postOk<Diff>("ratings/recompute?region=eu&dryRun=1");
    expect(await snapshot()).toEqual(before);
    expect(body).toMatchObject({ dryRun: true, region: "eu", staleFrom: null, truncated: false, players: [] });
    expect(body.matches).toEqual({ counted: 2, recomputed: 2, capped: false, until: null });
    expect(body.summary).toMatchObject({ players: 4, changed: 0, identical: true });
  });

  it("lists who would move, and by how much, writing nothing", async () => {
    await upload(matchLog(), tokens.eu, hoursAgo(1));
    const alpha = await playerId("Alpha");
    const stored = (await db().prepare("SELECT display FROM ratings WHERE board = 'eu' AND player_id = ?").bind(alpha).first<{ display: number }>())!.display;
    // Drift: Alpha's stored rating is 40 points too high.
    await db().prepare("UPDATE ratings SET display = display + 40, mu = mu + 1 WHERE board = 'eu' AND player_id = ?").bind(alpha).run();

    const before = await snapshot();
    const body = await postOk<Diff>("ratings/recompute?region=eu&dryRun=true");
    expect(await snapshot()).toEqual(before);
    expect(body.summary).toMatchObject({ changed: 1, down: 1, up: 0, biggestLoss: -40, identical: false });
    expect(body.players).toEqual([
      expect.objectContaining({ playerId: alpha, name: "Alpha", change: -40, before: expect.objectContaining({ display: stored + 40 }), after: expect.objectContaining({ display: stored }) }),
    ]);
  });

  it("shows a match that stopped counting: players lose its rounds or their rating", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002", players: ["Alpha", "Bravo", "Echo", "Foxtrot"] }), tokens.eu, hoursAgo(1));
    // Voided behind the rating's back: nothing marked it stale.
    await db().prepare("UPDATE matches SET status = 'void' WHERE match_key = '000000000002'").run();

    const body = await postOk<Diff>("ratings/recompute?region=eu&dryRun=1");
    expect(body.matches.counted).toBe(1);
    expect(body.summary).toMatchObject({ removed: 2, added: 0 });
    const removed = body.players.filter((p) => p.after === null).map((p) => p.name).sort();
    expect(removed).toEqual(["Echo", "Foxtrot"]);
    expect(body.players.slice(0, 2).every((p) => p.change === null)).toBe(true);
  });

  it("keeps the regions apart", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002", players: ["Alpha", "Bravo", "Echo", "Foxtrot"] }), tokens.na, hoursAgo(1));
    await db().prepare("UPDATE ratings SET display = display + 25 WHERE board = 'na'").run();

    const eu = await postOk<Diff>("ratings/recompute?region=eu&dryRun=1");
    expect(eu.matches.counted).toBe(1);
    expect(eu.summary).toMatchObject({ players: 4, changed: 0, identical: true });

    const na = await postOk<Diff>("ratings/recompute?region=na&dryRun=1");
    expect(na.matches.counted).toBe(1);
    expect(na.summary).toMatchObject({ players: 4, changed: 4, down: 4 });
    expect(na.players.map((p) => p.name).sort()).toEqual(["Alpha", "Bravo", "Echo", "Foxtrot"]);
  });

  it("caps the matches it rates, and compares with the leaderboard just before the first left out", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002" }), tokens.eu, hoursAgo(1));
    const config = { ...loadConfig(env), ratingDryRunMaxMatches: 1, ratingDryRunReadChunk: 1 };
    const request = new Request("https://example.com/api/admin/ratings/recompute?region=eu&dryRun=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const res = await handleAdmin(request, env.DB, env.PROOFS, config, createLogger("error"));
    const body = (await res.json()) as Diff;
    expect(body.matches).toEqual({ counted: 2, recomputed: 1, capped: true, until: { id: await matchId("000000000002"), playedAt: expect.any(String) } });
    expect(body.summary).toMatchObject({ players: 4, changed: 0, identical: true });
  });

  it("lists at most ratingDryRunListLimit players, and says so", async () => {
    await upload(matchLog(), tokens.eu, hoursAgo(1));
    await db().prepare("UPDATE ratings SET display = display + 10 WHERE board = 'eu'").run();
    const config = { ...loadConfig(env), ratingDryRunListLimit: 2 };
    const request = new Request("https://example.com/api/admin/ratings/recompute?region=eu&dryRun=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = (await (await handleAdmin(request, env.DB, env.PROOFS, config, createLogger("error"))).json()) as Diff;
    expect(body.summary.changed).toBe(4);
    expect(body.players).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });
});

describe("POST /api/admin/ratings/recompute", () => {
  it("recomputes the region from the start, logged, leaving the other region alone", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002" }), tokens.eu, hoursAgo(1));
    await db().prepare("UPDATE ratings SET display = display + 40, mu = mu + 1 WHERE board = 'eu'").run();
    const na = await db().prepare("SELECT * FROM rating_state WHERE board = 'na'").first();

    const body = await postOk("ratings/recompute?region=eu");
    expect(body).toEqual({ region: "eu", ratingsStale: false });
    await expectUpToDate();
    expect(await db().prepare("SELECT * FROM rating_state WHERE board = 'na'").first()).toEqual(na);
    const action = await db().prepare("SELECT admin_id AS adminId, action, detail FROM admin_actions").all();
    expect(action.results).toEqual([{ adminId: 1, action: "ratings_recompute", detail: JSON.stringify({ region: "eu" }) }]);
  });

  it("leaves the rest to the cron when it doesn't fit one run", async () => {
    await upload(matchLog(), tokens.eu, hoursAgo(1));
    const config = { ...loadConfig(env), ratingMatchesPerRun: 0 };
    const request = new Request("https://example.com/api/admin/ratings/recompute?region=eu", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = await (await handleAdmin(request, env.DB, env.PROOFS, config, createLogger("error"))).json();
    expect(body).toEqual({ region: "eu", ratingsStale: true });
    expect(await db().prepare("SELECT stale_played_at AS playedAt, stale_match_id AS id FROM rating_state WHERE board = 'eu'").first()).toEqual({ playedAt: "", id: 0 });
  });

  it("needs a region, an admin and a POST", async () => {
    expect((await post("ratings/recompute?dryRun=1")).status).toBe(400);
    expect((await post("ratings/recompute?region=mars&dryRun=1")).status).toBe(400);
    expect((await post("ratings/recompute?region=eu&dryRun=maybe")).status).toBe(400);
    expect((await post("ratings/recompute?region=eu&dryRun=1", undefined, null)).status).toBe(401);
    expect((await post("ratings/recompute?region=eu&dryRun=1", undefined, tokens.eu)).status).toBe(401);
    expect((await post("ratings/recompute?region=eu&dryRun=1", undefined, adminToken, "GET")).status).toBe(405);
    expect((await db().prepare("SELECT count(*) AS n FROM admin_actions").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("diffRatings", () => {
  const rating = (display: number, rounds = 10) => ({ mu: display / 100, sigma: 1, display, rounds, wins: 1, lastPlayedAt: "2026-10-01T00:00:00Z" });

  it("ranks like the leaderboard and says who passes whom", () => {
    const before = new Map([[1, rating(1200)], [2, rating(1100)], [3, rating(1000, 2)]]);
    const after = new Map([[1, rating(1050)], [2, rating(1100)], [3, rating(1300)]]);
    const diff = diffRatings(before, after, 3);
    expect(diff.players).toEqual([
      // Below minRounds before: no rank to compare with.
      { playerId: 3, before: { display: 1000, rounds: 2, wins: 1, rank: null }, after: { display: 1300, rounds: 10, wins: 1, rank: 1 }, change: 300, rankChange: null },
      { playerId: 1, before: { display: 1200, rounds: 10, wins: 1, rank: 1 }, after: { display: 1050, rounds: 10, wins: 1, rank: 3 }, change: -150, rankChange: -2 },
    ]);
    // Player 2 keeps 1100 and rank 2: not listed.
    expect(diff.summary).toEqual({ players: 3, changed: 2, added: 0, removed: 0, up: 1, down: 1, biggestGain: 300, biggestLoss: -150, identical: false });
  });

  it("is identical only when every rating is exactly the same", () => {
    const same = new Map([[1, rating(1200)]]);
    expect(diffRatings(same, new Map(same), 3).summary).toMatchObject({ changed: 0, identical: true });
    const drifted = new Map([[1, { ...rating(1200), mu: 12.000001 }]]);
    expect(diffRatings(same, drifted, 3).summary).toMatchObject({ changed: 0, identical: false });
  });
});
