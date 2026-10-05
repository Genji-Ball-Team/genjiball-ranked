import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin/handler";
import { defaults, loadConfig } from "../src/config";
import { createLogger } from "../src/log";
import { diffRatings } from "../src/rating/diff";
import { countedMatches, dryRunDiff, dryRunSql, sqlRegion } from "../src/rating/dryRun";
import type { StoredRating } from "../src/rating/plan";
import type { CandidateRow, RoundRow } from "../src/rating/store";
import { updateRatings } from "../src/rating/update";
import { sha256 } from "../src/upload/handler";
import example from "./fixtures/ranked-log-example.txt?raw";
import { expectUpToDate, matchId, matchLog } from "./helpers";

// The admin debug tools (#33): the dry-run parse, the recompute, and the dry-run recompute that
// `npm run ratings:dry-run` runs outside the Worker (its queries and logic, against the test D1).

const db = () => env.DB;
const log = createLogger("error");
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
    db().prepare("INSERT OR IGNORE INTO rating_state (board) VALUES ('eu'), ('na')"),
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

/** Calls the admin API with a changed config. */
async function adminWith<T>(config: Partial<typeof defaults>, path: string, body?: string): Promise<{ status: number; body: T }> {
  const request = new Request(`https://example.com/api/admin/${path}`, { method: "POST", body, headers: { Authorization: `Bearer ${adminToken}` } });
  const res = await handleAdmin(request, env.DB, env.PROOFS, { ...loadConfig(env), ...config }, log);
  return { status: res.status, body: (await res.json()) as T };
}

/** Every table the debug tools must leave alone, to check nothing was written. */
async function snapshot() {
  const tables = ["uploads", "matches", "players", "aliases", "match_players", "rounds", "round_players", "events", "ratings", "rating_history", "rating_state", "admin_actions", "hosts"];
  const rows = await db().batch(tables.map((t) => db().prepare(`SELECT * FROM ${t}`)));
  return Object.fromEntries(tables.map((t, i) => [t, rows[i]!.results.map((row) => JSON.stringify(row)).sort()]));
}

const legacyFile = ["10.00|Alpha|Bravo", "11.00|Alpha|Charlie", "20.00|Bravo|Alpha", "21.00|Bravo|Charlie"]
  .map((line) => `[00:00:01] KILL|${line}`)
  .join("\r\n");

type ParsedMatchOut = {
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
};
type Parsed = {
  region: string | null;
  duplicateOf: number | null;
  upload: { status: number; result?: string; error?: string; region?: string; matches?: { matchKey: string; action: string; status: string }[] };
  parser: { error: { status: number; error: string } | null; matches: ParsedMatchOut[]; warnings: string[] };
};

describe("POST /api/admin/parse", () => {
  it("answers what the parser makes of the spec's example, writing nothing", async () => {
    const before = await snapshot();
    const body = await postOk<Parsed>("parse", example);
    expect(await snapshot()).toEqual(before);

    expect(body.upload).toMatchObject({ status: 200, result: "stored" });
    expect(body.upload.matches).toEqual([expect.objectContaining({ matchKey: "482913507226", action: "insert", status: "review" })]);
    expect(body.region).toBeNull();
    expect(body.parser.error).toBeNull();
    expect(body.parser.matches).toHaveLength(1);
    const [m] = body.parser.matches;
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
    expect(body.upload.region).toBe("na");
    expect(body.parser.matches[0]).toMatchObject({ region: "na", status: "accepted" });
    // A bad region is the upload's 400 (an X-Region that isn't a region); the parser still reads the file.
    const mars = await postOk<Parsed>("parse?region=mars", matchLog());
    expect(mars.upload).toMatchObject({ status: 400, error: "bad_request" });
    expect(mars.parser.matches).toHaveLength(1);
  });

  it("plans against a host's stored copies, which keep their region", async () => {
    await upload(matchLog({ rounds: 1 }), tokens.eu, hoursAgo(1));
    const stored = await matchId("000000000001");

    const longer = await postOk<Parsed>("parse?host=1&region=na", matchLog());
    expect(longer.upload).toMatchObject({ status: 200, result: "stored", region: "na" });
    expect(longer.parser.matches[0]).toMatchObject({ action: "replace", storedMatchId: stored, region: "eu" });

    const shorter = await postOk<Parsed>("parse?host=1", matchLog({ rounds: 1, end: false }));
    expect(shorter.upload.result).toBe("unchanged");
    expect(shorter.parser.matches[0]).toMatchObject({ action: "skip", region: "eu" });

    const same = await postOk<Parsed>("parse?host=1", matchLog({ rounds: 1 }));
    expect(same.upload).toMatchObject({ status: 200, result: "duplicate", matches: [] });
    expect(same.duplicateOf).not.toBeNull();
    // The parser's view is still there.
    expect(same.parser.matches[0]).toMatchObject({ action: "repoint" });

    // Another host's copy isn't this host's match.
    expect((await postOk<Parsed>("parse?host=2", matchLog())).parser.matches[0]).toMatchObject({ action: "insert", region: "na" });
    expect((await post("parse?host=99", matchLog())).status).toBe(404);
    expect((await post("parse?host=abc", matchLog())).status).toBe(400);
  });

  it("judges as the host's trust, and stops at no_region for a host without one", async () => {
    const body = await postOk<Parsed>("parse?host=3", matchLog());
    expect(body.upload).toMatchObject({ status: 422, error: "no_region" });
    expect(body.parser.matches[0]).toMatchObject({ status: "review", reviewReasons: ["untrusted_host"] });
    expect((await postOk<Parsed>("parse?host=3&region=eu", matchLog())).upload).toMatchObject({ status: 200, result: "stored", region: "eu" });
  });

  it("keeps the parser's error apart from what the upload answers", async () => {
    const notRanked = await postOk<Parsed>("parse", "[00:00:01] hello");
    expect(notRanked.upload).toMatchObject({ status: 422, error: "not_ranked" });
    expect(notRanked.parser).toMatchObject({ error: { status: 422, error: "not_ranked" }, matches: [] });

    expect((await postOk<Parsed>("parse", legacyFile)).upload).toMatchObject({ status: 422, error: "legacy_log" });
    // The legacy import needs a host.
    expect((await postOk<Parsed>("parse?legacy=1", legacyFile)).upload).toMatchObject({ status: 400, error: "bad_request" });
    const legacy = await postOk<Parsed>("parse?legacy=1&host=3", legacyFile);
    // As the import: from a trusted host, and a host with no home region needs region=.
    expect(legacy.upload).toMatchObject({ status: 400, error: "bad_request" });
    expect(legacy.parser.matches[0]).toMatchObject({ format: 0, status: "accepted", ratedRounds: 2 });
    expect((await postOk<Parsed>("parse?legacy=1&host=3&region=na", legacyFile)).upload).toMatchObject({ status: 200, result: "stored", region: "na" });
  });

  it("answers duplicate before the parser's error, as the real paths do", async () => {
    await upload(matchLog(), tokens.eu, hoursAgo(1));
    const asLegacy = await postOk<Parsed>("parse?legacy=1&host=1", matchLog());
    expect(asLegacy.upload).toMatchObject({ status: 200, result: "duplicate" });
    expect(asLegacy.parser.error).toMatchObject({ status: 422, error: "not_legacy" });

    const imported = await SELF.fetch("https://example.com/api/admin/legacy-import?host=1", {
      method: "POST",
      body: legacyFile,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(imported.status).toBe(200);
    const asRanked = await postOk<Parsed>("parse?host=1", legacyFile);
    expect(asRanked.upload).toMatchObject({ status: 200, result: "duplicate" });
    expect(asRanked.parser.error).toMatchObject({ status: 422, error: "legacy_log" });
  });

  it("checks the host in the upload's order: revoked, then region, then rate limit, then duplicate", async () => {
    await upload(matchLog(), tokens.eu, hoursAgo(1));
    const file = matchLog();

    // Rate limit before duplicate.
    const limited = await adminWith<Parsed>({ maxUploadsPerHour: 1 }, "parse?host=1", file);
    expect(limited.body.upload).toMatchObject({ status: 429, error: "rate_limited" });
    expect((await postOk<Parsed>("parse?host=1", file)).upload).toMatchObject({ status: 200, result: "duplicate" });

    // No region before the rate limit and duplicate.
    const noRegion = await adminWith<Parsed>({ maxUploadsPerHour: 0 }, "parse?host=3", file);
    expect(noRegion.body.upload).toMatchObject({ status: 422, error: "no_region" });

    // Revoked before everything.
    await db().prepare("UPDATE hosts SET trust = 'revoked' WHERE id = 3").run();
    expect((await postOk<Parsed>("parse?host=3", file)).upload).toMatchObject({ status: 403, error: "revoked" });
    // The legacy import doesn't look at revocation, only the region.
    expect((await postOk<Parsed>("parse?host=3&legacy=1", legacyFile)).upload).toMatchObject({ status: 400, error: "bad_request" });
  });

  it("warns about an incomplete match and several copies in one file", async () => {
    const body = await postOk<Parsed>("parse", `${matchLog({ rounds: 1, end: false })}\r\n${matchLog()}`);
    expect(body.parser.matches).toHaveLength(1);
    expect(body.parser.warnings.join("\n")).toMatch(/2 copies of match 000000000001/);
    expect((await postOk<Parsed>("parse", matchLog({ end: false }))).parser.warnings.join("\n")).toMatch(/no MATCH_END/);
  });

  it("checks host, region and rate limit before the body, as the real handlers do", async () => {
    const tooBig = "x".repeat(defaults.maxUploadBytes + 1);
    // No-region host and a body over the limit: no_region first.
    expect((await postOk<Parsed>("parse?host=3", tooBig)).upload).toMatchObject({ status: 422, error: "no_region" });
    // The legacy import's region error comes before the empty body.
    expect((await postOk<Parsed>("parse?host=3&legacy=1", "")).upload).toMatchObject({ status: 400, error: "bad_request", message: expect.stringMatching(/home region/) });

    await db().prepare("UPDATE hosts SET trust = 'revoked' WHERE id = 1").run();
    // Revoked host: 403 before a bad region or an empty body.
    expect((await postOk<Parsed>("parse?host=1&region=mars", matchLog())).upload).toMatchObject({ status: 403, error: "revoked" });
    expect((await postOk<Parsed>("parse?host=1", "")).upload).toMatchObject({ status: 403, error: "revoked" });
  });

  it("has the upload's size limit, needs an admin and a POST, and writes nothing when it refuses", async () => {
    const before = await snapshot();
    const tooBig = await postOk<Parsed>("parse", "x".repeat(defaults.maxUploadBytes + 1));
    expect(tooBig.upload).toMatchObject({ status: 413, error: "too_large" });
    expect(tooBig.parser).toMatchObject({ error: { status: 413, error: "too_large" }, matches: [] });
    expect((await postOk<Parsed>("parse", "")).upload).toMatchObject({ status: 400, error: "empty" });
    expect((await post("parse?legacy=maybe", matchLog())).status).toBe(400);
    expect((await post("parse?host=99", matchLog())).status).toBe(404);
    expect((await post("parse", matchLog(), null)).status).toBe(401);
    expect((await post("parse", matchLog(), tokens.eu)).status).toBe(401);
    expect((await post("parse", undefined, adminToken, "GET")).status).toBe(405);
    expect(await snapshot()).toEqual(before);
  });
});

describe("POST /api/admin/ratings/recompute", () => {
  const state = (board: string) =>
    db().prepare("SELECT version, stale_played_at AS playedAt, stale_match_id AS id FROM rating_state WHERE board = ?").bind(board).first();

  it("marks the region stale from the start, logged, and leaves the rating to the cron", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002" }), tokens.eu, hoursAgo(1));
    await db().prepare("UPDATE ratings SET display = display + 40, mu = mu + 1 WHERE board = 'eu'").run();
    const drifted = await db().prepare("SELECT * FROM ratings ORDER BY player_id").all();
    const na = await state("na");

    expect(await postOk("ratings/recompute?region=eu")).toEqual({ region: "eu", ratingsStale: true });
    expect(await state("eu")).toMatchObject({ playedAt: "", id: 0 });
    expect(await state("na")).toEqual(na);
    // Nothing rated in the request.
    expect((await db().prepare("SELECT * FROM ratings ORDER BY player_id").all()).results).toEqual(drifted.results);
    const actions = await db().prepare("SELECT admin_id AS adminId, action, detail FROM admin_actions").all();
    expect(actions.results).toEqual([{ adminId: 1, action: "ratings_recompute", detail: JSON.stringify({ region: "eu" }) }]);

    await updateRatings(db(), loadConfig(env), new Date(), log); // the cron
    await expectUpToDate();
  });

  it("makes the rating_state row of a region that has none", async () => {
    await db().prepare("DELETE FROM rating_state WHERE board = 'na'").run();
    expect(await postOk("ratings/recompute?region=na")).toEqual({ region: "na", ratingsStale: true });
    expect(await state("na")).toMatchObject({ playedAt: "", id: 0 });
  });

  it("recomputes matches with the same start time in id order", async () => {
    const at = hoursAgo(1);
    await upload(matchLog({ key: "000000000001" }), tokens.eu, at);
    await upload(matchLog({ key: "000000000002", players: ["Bravo", "Alpha", "Delta", "Charlie"] }), tokens.eu, at);
    await expectUpToDate();
    await db().prepare("UPDATE ratings SET mu = mu + 1 WHERE board = 'eu'").run();
    await postOk("ratings/recompute?region=eu");
    await updateRatings(db(), loadConfig(env), new Date(), log);
    await expectUpToDate();
  });

  it("needs a region, refuses dryRun (a script now), an admin and a POST, writing nothing", async () => {
    const before = await snapshot();
    expect((await post("ratings/recompute")).status).toBe(400);
    expect((await post("ratings/recompute?region=mars")).status).toBe(400);
    for (const dryRun of ["1", "0", "true"]) {
      const res = await post(`ratings/recompute?region=eu&dryRun=${dryRun}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(/ratings:dry-run/);
    }
    expect((await post("ratings/recompute?region=eu", undefined, null)).status).toBe(401);
    expect((await post("ratings/recompute?region=eu", undefined, tokens.eu)).status).toBe(401);
    expect((await post("ratings/recompute?region=eu", undefined, adminToken, "GET")).status).toBe(405);
    expect(await snapshot()).toEqual(before);
  });
});

/** What `npm run ratings:dry-run` does, with the same queries and functions, against the test D1. */
async function dryRun(region: string, { chunk = 200, now = new Date() } = {}) {
  const r = sqlRegion(defaults.regions, region);
  const all = async <T>(sql: string) => (await db().prepare(sql).all<T>()).results;
  const stale = (await all<{ version: number; playedAt: string | null; id: number | null }>(dryRunSql.state(r)))[0] ?? null;
  const accepted = await all<CandidateRow>(dryRunSql.matches(r));
  const counted = countedMatches(accepted, defaults, now);
  const rounds: RoundRow[] = [];
  for (let i = 0; i < counted.length; i += chunk) rounds.push(...(await all<RoundRow>(dryRunSql.rounds(counted.slice(i, i + chunk).map((m) => m.id)))));
  const stored = await all<StoredRating & { playerId: number }>(dryRunSql.ratings(r));
  const diff = dryRunDiff(counted, rounds, stored, defaults);
  const names = diff.players.length ? await all<{ id: number; name: string }>(dryRunSql.names(diff.players.map((p) => p.playerId))) : [];
  return { stale, accepted: accepted.length, counted: counted.length, ...diff, names: new Map(names.map((p) => [p.id, p.name])) };
}

const playerId = async (name: string) =>
  (await db().prepare("SELECT id FROM players WHERE name = ?").bind(name).first<{ id: number }>())!.id;

describe("dry-run recompute (npm run ratings:dry-run)", () => {
  it("finds nothing to change when the ratings are up to date, and reads only", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002" }), tokens.eu, hoursAgo(1));
    const before = await snapshot();
    const result = await dryRun("eu", { chunk: 1 });
    expect(await snapshot()).toEqual(before);
    expect(result).toMatchObject({ stale: { playedAt: null }, accepted: 2, counted: 2, players: [] });
    expect(result.summary).toMatchObject({ players: 4, changed: 0, identical: true });
  });

  it("lists who would move, and by how much", async () => {
    await upload(matchLog(), tokens.eu, hoursAgo(1));
    const alpha = await playerId("Alpha");
    const stored = (await db().prepare("SELECT display FROM ratings WHERE board = 'eu' AND player_id = ?").bind(alpha).first<{ display: number }>())!.display;
    await db().prepare("UPDATE ratings SET display = display + 40, mu = mu + 1 WHERE board = 'eu' AND player_id = ?").bind(alpha).run();

    const result = await dryRun("eu");
    expect(result.summary).toMatchObject({ changed: 1, down: 1, up: 0, biggestLoss: -40, identical: false });
    expect(result.players).toEqual([
      expect.objectContaining({ playerId: alpha, change: -40, before: expect.objectContaining({ display: stored + 40 }), after: expect.objectContaining({ display: stored }) }),
    ]);
    expect(result.names.get(alpha)).toBe("Alpha");
  });

  it("rates tournaments as the recompute does", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002", players: ["Delta", "Charlie", "Bravo", "Alpha"] }), tokens.eu, hoursAgo(1));
    await postOk("matches/" + (await matchId("000000000001")) + "/tournament", JSON.stringify({ tournament: true }));
    await updateRatings(db(), loadConfig(env), new Date(), log);
    await expectUpToDate();
    expect((await dryRun("eu")).summary).toMatchObject({ changed: 0, identical: true });

    // Behind the rating's back: the dry run sees the weight change.
    await db().prepare("UPDATE matches SET tournament = 0").run();
    expect((await dryRun("eu")).summary.changed).toBeGreaterThan(0);
  });

  it("orders matches with the same start time by id, as the recompute does", async () => {
    const at = hoursAgo(1);
    await upload(matchLog({ key: "000000000001" }), tokens.eu, at);
    await upload(matchLog({ key: "000000000002", players: ["Bravo", "Alpha", "Delta", "Charlie"] }), tokens.eu, at);
    await expectUpToDate();
    expect((await dryRun("eu", { chunk: 1 })).summary).toMatchObject({ changed: 0, identical: true });
  });

  it("counts an incomplete match only after the grace period", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002", end: false }), tokens.eu, hoursAgo(1));
    const now = await dryRun("eu");
    expect(now).toMatchObject({ accepted: 2, counted: 1 });
    expect(now.summary.identical).toBe(true);
    const later = await dryRun("eu", { now: new Date(Date.now() + (defaults.ratingIncompleteGraceHours + 1) * 60 * 60 * 1000) });
    expect(later.counted).toBe(2);
    expect(later.summary.identical).toBe(false); // the cron hasn't rated it yet
  });

  it("shows a match that stopped counting: players lose its rounds or their rating", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002", players: ["Alpha", "Bravo", "Echo", "Foxtrot"] }), tokens.eu, hoursAgo(1));
    await db().prepare("UPDATE matches SET status = 'void' WHERE match_key = '000000000002'").run();

    const result = await dryRun("eu");
    expect(result.counted).toBe(1);
    expect(result.summary).toMatchObject({ removed: 2, added: 0 });
    expect(result.players.filter((p) => p.after === null).map((p) => result.names.get(p.playerId)).sort()).toEqual(["Echo", "Foxtrot"]);
  });

  it("keeps the regions apart", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000002", players: ["Alpha", "Bravo", "Echo", "Foxtrot"] }), tokens.na, hoursAgo(1));
    await db().prepare("UPDATE ratings SET display = display + 25 WHERE board = 'na'").run();

    const eu = await dryRun("eu");
    expect(eu).toMatchObject({ counted: 1 });
    expect(eu.summary).toMatchObject({ players: 4, changed: 0, identical: true });
    const na = await dryRun("na");
    expect(na).toMatchObject({ counted: 1 });
    expect(na.summary).toMatchObject({ players: 4, changed: 4, down: 4 });
  });

  it("works for a region with no rating_state row", async () => {
    await db().prepare("DELETE FROM rating_state WHERE board = 'na'").run();
    const result = await dryRun("na");
    expect(result).toMatchObject({ stale: null, counted: 0, players: [] });
    expect(result.summary.identical).toBe(true);
  });

  it("reads a rating state version that rating writes, recompute marks and tournament changes move on", async () => {
    const version = async () => (await dryRun("eu")).stale!.version;
    const v0 = await version();
    await upload(matchLog(), tokens.eu, hoursAgo(1)); // rated on upload
    const v1 = await version();
    expect(v1).toBeGreaterThan(v0);
    await postOk("ratings/recompute?region=eu");
    const v2 = await version();
    expect(v2).toBeGreaterThan(v1);
    await postOk("matches/" + (await matchId("000000000001")) + "/tournament", JSON.stringify({ tournament: true }));
    expect(await version()).toBeGreaterThan(v2);
  });

  it("writes only checked values into its SQL", () => {
    expect(sqlRegion(defaults.regions, "EU")).toBe("eu");
    for (const bad of ["mars", "eu' OR 1=1 --", ""]) expect(() => sqlRegion(defaults.regions, bad)).toThrow();
    expect(() => dryRunSql.rounds([1, 2.5])).toThrow();
    expect(() => dryRunSql.names([Number.NaN])).toThrow();
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
