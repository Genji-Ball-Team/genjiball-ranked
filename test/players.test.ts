import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin/handler";
import { playerIdColumns, writeMerge } from "../src/admin/playerStore";
import { isStale } from "../src/admin/store";
import { defaults } from "../src/config";
import { createLogger } from "../src/log";
import { displayRating, recompute, type RatingMatch } from "../src/rating/engine";
import { readRounds, readState } from "../src/rating/store";
import { updateRatings } from "../src/rating/update";
import { listTagCandidates } from "../src/site/store";
import { handleSite } from "../src/site/handler";
import { handleUpload, sha256, type UploadResponse } from "../src/upload/handler";
import { matchId, matchLog } from "./helpers";

const db = () => env.DB;
const log = createLogger("error");
const adminToken = "admin-token";
const tokens = { eu: "eu-host", na: "na-host" };

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = [
    "admin_actions", "player_merges", "events", "round_players", "rounds", "match_players",
    "rating_history", "ratings", "matches", "uploads", "aliases", "players", "admins", "hosts",
  ];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'eu host', ?, 'trusted', 'eu')").bind(await sha256(tokens.eu)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (2, 'na host', ?, 'trusted', 'na')").bind(await sha256(tokens.na)),
  ]);
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

async function upload(body: string, token: string, startedAt: string): Promise<UploadResponse> {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": startedAt },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

function admin(path: string, body?: unknown) {
  return SELF.fetch(`https://example.com/api/admin/${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

/** Run a competing write after the handler's reads, just before its transaction. */
function beforeBatch(compete: () => Promise<unknown>): D1Database {
  return new Proxy(db(), {
    get(target, prop) {
      if (prop === "batch") return async (statements: D1PreparedStatement[]) => {
        await compete();
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function adminWith(database: D1Database, path: string, body: unknown) {
  return handleAdmin(new Request(`https://example.com/api/admin/${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { Authorization: `Bearer ${adminToken}` },
  }), database, env.PROOFS, defaults, log);
}

async function adminOk<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await admin(path, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function get<T = Record<string, unknown>>(path: string): Promise<T> {
  const res = await SELF.fetch(`https://example.com/api/${path}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function playerId(name: string): Promise<number> {
  return (await db().prepare("SELECT player_id AS id FROM aliases WHERE name_key = lower(?)").bind(name).first<{ id: number }>())!.id;
}

async function rows(sql: string) {
  return (await db().prepare(sql).all()).results;
}

/** Everything a merge touches, to compare before and after. */
async function snapshot() {
  return {
    players: await rows("SELECT id, name, name_fixed, merged_into FROM players ORDER BY id"),
    aliases: await rows("SELECT id, player_id, name, name_key, first_seen_at, last_seen_at FROM aliases ORDER BY id"),
    matchPlayers: await rows("SELECT match_id, log_id, player_id, name FROM match_players ORDER BY match_id, log_id"),
    roundPlayers: await rows("SELECT round_id, log_id, player_id, position FROM round_players ORDER BY round_id, log_id"),
    ratings: await rows("SELECT board, player_id, mu, sigma, display, rounds, wins, last_played_at FROM ratings ORDER BY board, player_id"),
    history: await rows("SELECT board, player_id, match_id, mu, sigma, display, rounds, wins FROM rating_history ORDER BY board, match_id, player_id"),
  };
}

async function finishRecompute() {
  while ((await readState(db(), "eu")).staleFrom || (await readState(db(), "na")).staleFrom) {
    await updateRatings(db(), defaults, new Date(), log);
  }
}

/** The region's ratings in D1 match a recompute from scratch over its accepted matches. */
async function expectRegionUpToDate(region: string) {
  const stored = await rows(
    `SELECT player_id AS playerId, mu, sigma, display, rounds, wins FROM ratings WHERE board = '${region}' ORDER BY player_id`,
  );
  const { results: matches } = await db()
    .prepare("SELECT id, played_at AS playedAt, tournament FROM matches WHERE status = 'accepted' AND region = ? ORDER BY played_at, id")
    .bind(region)
    .all<{ id: number; playedAt: string; tournament: number }>();
  const rounds = await readRounds(db(), matches.map((m) => m.id));
  const input: RatingMatch[] = matches.map((m) => ({ ...m, rounds: rounds.get(m.id)!, tournament: m.tournament === 1 }));
  const expected = [...recompute(input, defaults).ratings]
    .sort(([a], [b]) => a - b)
    .map(([playerId, r]) => ({ playerId, mu: r.mu, sigma: r.sigma, display: displayRating(r, defaults), rounds: r.rounds, wins: r.wins }));
  expect(stored, region).toEqual(expected);
  expect((await readState(db(), region)).staleFrom, region).toBeNull();
}

/**
 * Alpha plays as Alpha in EU, then changes name to Alfa and plays in EU and NA. Bravo, Charlie and
 * Delta play with both names; Echo..Hotel only with Alfa.
 */
async function nameChange() {
  await upload(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(10));
  await upload(matchLog({ key: "000000000002", players: ["Alfa", "Echo", "Foxtrot", "Golf"] }), tokens.eu, hoursAgo(9));
  await upload(matchLog({ key: "000000000003", players: ["Alpha", "Bravo", "Echo", "Hotel"] }), tokens.eu, hoursAgo(8));
  await upload(matchLog({ key: "000000000004", players: ["Alfa", "Bravo", "Charlie", "Delta"] }), tokens.na, hoursAgo(7));
  await upload(matchLog({ key: "000000000005", players: ["Alfa", "Echo", "Charlie", "Hotel"] }), tokens.eu, hoursAgo(6));
  return { alpha: await playerId("Alpha"), alfa: await playerId("Alfa") };
}

describe("players: the merge knows every player id column", () => {
  it("lists every column that references players(id)", async () => {
    // D1 doesn't allow pragma_foreign_key_list: read the CREATE TABLE text (ALTER TABLE adds to it).
    const { results } = await db()
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY name")
      .all<{ name: string; sql: string }>();
    const inSchema = results
      .flatMap(({ name, sql }) => [...sql.matchAll(/(\w+)\s+INTEGER\b[^,]*?REFERENCES\s+players\s*\(\s*id\s*\)/gi)].map((m) => `${name}.${m[1]}`))
      .sort();
    const listed = playerIdColumns.map((c) => `${c.table}.${c.column}`).sort();
    expect(inSchema).toEqual(listed);
  });
});

describe("players: merge", () => {
  it("moves the names and matches to the player who stays, and rebuilds the ratings", async () => {
    const { alpha, alfa } = await nameChange();
    const res = await admin(`players/${alfa}/merge`, { into: alpha });
    expect(res.status, await res.clone().text()).toBe(200);
    const { merge } = await res.json<{ merge: { id: number } }>();
    expect(merge).toMatchObject({ from: { id: alfa, name: "Alfa" }, into: { id: alpha }, aliases: ["Alfa"], mergedBy: "Ada", undoneAt: null });

    expect(await rows(`SELECT name FROM aliases WHERE player_id = ${alpha} ORDER BY name`)).toEqual([{ name: "Alfa" }, { name: "Alpha" }]);
    expect(await rows(`SELECT COUNT(*) AS n FROM aliases WHERE player_id = ${alfa}`)).toEqual([{ n: 0 }]);
    for (const table of ["match_players", "round_players", "ratings", "rating_history"]) {
      expect(await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id = ${alfa}`), table).toEqual([{ n: 0 }]);
    }
    // Events hold log ids, not player ids: untouched.
    expect(await rows(`SELECT merged_into FROM players WHERE id = ${alfa}`)).toEqual([{ merged_into: alpha }]);
    // Alfa is the name seen most recently: the display name.
    expect(await rows(`SELECT name FROM players WHERE id = ${alpha}`)).toEqual([{ name: "Alfa" }]);

    await finishRecompute();
    await expectRegionUpToDate("eu");
    await expectRegionUpToDate("na");
    // The merged player has a rating in both regions now.
    expect(await rows(`SELECT board FROM ratings WHERE player_id = ${alpha} ORDER BY board`)).toEqual([{ board: "eu" }, { board: "na" }]);

    const logged = await rows("SELECT admin_id, action, detail FROM admin_actions");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ admin_id: 1, action: "player_merge" });
    expect(JSON.parse(logged[0]!.detail as string)).toEqual({ from: alfa, into: alpha, fromName: "Alfa", intoName: "Alpha", aliases: ["Alfa"], merge: merge.id });
  });

  it("makes the ratings stale in every region the merged player was rated in, from their first match there", async () => {
    const { alpha, alfa } = await nameChange();
    await writeMerge(db(), { from: alfa, into: alpha, adminId: 1, at: "2026-10-05T12:00:00Z", detail: {} });
    expect((await readState(db(), "eu")).staleFrom).toMatchObject({ id: await matchId("000000000002") });
    expect((await readState(db(), "na")).staleFrom).toMatchObject({ id: await matchId("000000000004") });
    await finishRecompute();
    await expectRegionUpToDate("eu");
    await expectRegionUpToDate("na");
  });

  it("leaves all recomputation after merge and undo to the cron", async () => {
    const { alpha, alfa } = await nameChange();
    const before = await snapshot();
    const versions = await rows("SELECT board, version FROM rating_state ORDER BY board");
    const res = await adminOk<{ merge: { id: number }; ratingsStale: boolean }>(`players/${alfa}/merge`, { into: alpha });
    expect(res.ratingsStale).toBe(true);
    expect((await readState(db(), "eu")).staleFrom).toMatchObject({ id: await matchId("000000000002") });
    expect((await readState(db(), "na")).staleFrom).toMatchObject({ id: await matchId("000000000004") });
    expect((await snapshot()).history).toEqual(before.history.filter((r) => r.player_id !== alfa));
    const changed = await rows("SELECT board, version FROM rating_state ORDER BY board");
    for (const [i, state] of changed.entries()) expect(Number(state.version)).toBeGreaterThan(Number(versions[i]!.version));
    await finishRecompute();
    await expectRegionUpToDate("eu");
    await expectRegionUpToDate("na");
    const merged = await snapshot();
    const undone = await adminOk<{ ratingsStale: boolean }>(`merges/${res.merge.id}/undo`, {});
    expect(undone.ratingsStale).toBe(true);
    expect((await snapshot()).history).toEqual(merged.history);
    expect((await readState(db(), "eu")).staleFrom).toMatchObject({ id: await matchId("000000000002") });
    expect((await readState(db(), "na")).staleFrom).toMatchObject({ id: await matchId("000000000004") });
    await finishRecompute();
    expect(await snapshot()).toEqual(before);
  });

  it("leaves a region the merged player never played in alone", async () => {
    await upload(matchLog({ key: "000000000001" }), tokens.na, hoursAgo(3));
    await upload(matchLog({ key: "000000000002", players: ["Alfa", "Echo", "Foxtrot", "Golf"] }), tokens.eu, hoursAgo(2));
    const before = await rows("SELECT version FROM rating_state WHERE board = 'na'");
    await writeMerge(db(), { from: await playerId("Alfa"), into: await playerId("Alpha"), adminId: 1, at: "2026-10-05T12:00:00Z", detail: {} });
    expect((await readState(db(), "na")).staleFrom).toBeNull();
    expect((await readState(db(), "eu")).staleFrom).toMatchObject({ id: await matchId("000000000002") });
    // Its version still moves on, so a rating run that read the old rows fails.
    expect(await rows("SELECT version FROM rating_state WHERE board = 'na'")).not.toEqual(before);
  });

  it("maps later uploads of either name to the merged player", async () => {
    const { alpha, alfa } = await nameChange();
    await adminOk(`players/${alfa}/merge`, { into: alpha });
    const players = await rows("SELECT COUNT(*) AS n FROM players");

    await upload(matchLog({ key: "000000000006", players: ["ALFA", "Bravo", "Echo", "Golf"] }), tokens.eu, hoursAgo(1));
    await upload(matchLog({ key: "000000000007", players: ["Alpha", "Charlie", "Echo", "Golf"] }), tokens.na, hoursAgo(0.5));
    expect(await rows("SELECT COUNT(*) AS n FROM players")).toEqual(players);
    for (const key of ["000000000006", "000000000007"]) {
      expect(await rows(`SELECT player_id FROM match_players WHERE match_id = ${await matchId(key)} AND log_id = 1`)).toEqual([{ player_id: alpha }]);
    }
    // The newest spelling is the display name.
    expect(await rows(`SELECT name FROM players WHERE id = ${alpha}`)).toEqual([{ name: "Alpha" }]);
    await finishRecompute();
    await expectRegionUpToDate("eu");
    await expectRegionUpToDate("na");
  });

  it("finds the merged player by either name, and answers the old player page with the merged one", async () => {
    const { alpha, alfa } = await nameChange();
    await adminOk(`players/${alfa}/merge`, { into: alpha });
    const { players } = await get<{ players: { id: number; matchedAlias: string | null }[] }>("players?search=alf");
    expect(players).toEqual([expect.objectContaining({ id: alpha })]);
    const page = await get<{ player: { id: number; aliases: string[] } }>(`players/${alfa}?region=na`);
    expect(page.player).toMatchObject({ id: alpha });
    expect(page.player.aliases.sort()).toEqual(["Alfa", "Alpha"]);
    expect(page.player).not.toHaveProperty("mergedInto");
  });

  it("resolves a long merge chain with a fixed number of page queries", async () => {
    const { alpha } = await nameChange();
    let oldest = alpha;
    for (let i = 0; i < 13; i++) {
      oldest = (await db().prepare("INSERT INTO players (name, merged_into) VALUES (?, ?) RETURNING id")
        .bind(`Old ${i}`, oldest).first<{ id: number }>())!.id;
    }
    let queries = 0;
    const counted = new Proxy(db(), {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await handleSite(new Request(`https://example.com/api/players/${oldest}?region=eu`), counted, defaults);
    expect(response!.status).toBe(200);
    const page = await response!.json<{ player: { id: number }; matches: unknown[] }>();
    expect(page.player.id).toBe(alpha);
    expect(page).toEqual(await get(`players/${alpha}?region=eu`));
    expect(queries).toBe(7); // Canonical id, player, rating, matches, regions, rivals (#18) and rank.
  });

  it("refuses a shared round uploaded after the check, and rolls back the merge and action", async () => {
    const { alpha, alfa } = await nameChange();
    let before: Awaited<ReturnType<typeof snapshot>>;
    const racing = beforeBatch(async () => {
      await upload(matchLog({ key: "000000000006", players: ["Alpha", "Alfa", "Charlie", "Delta"] }), tokens.eu, hoursAgo(1));
      before = await snapshot();
    });
    const response = await adminWith(racing, `players/${alfa}/merge`, { into: alpha });
    expect(response.status).toBe(409);
    expect(await snapshot()).toEqual(before!);
    expect(await rows("SELECT COUNT(*) AS n FROM player_merges")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM admin_actions")).toEqual([{ n: 0 }]);
  });

  it("reviews resolved-id collisions even when the merge lands between upload reads and its batch", async () => {
    const { alpha, alfa } = await nameChange();
    const racing = beforeBatch(() => writeMerge(db(), { from: alfa, into: alpha, adminId: 1, at: hoursAgo(0.5), detail: {} }));
    const response = await handleUpload(new Request("https://example.com/api/upload", {
      method: "POST", body: matchLog({ key: "000000000006", players: ["Alpha", "Alfa", "Charlie", "Delta"] }),
      headers: { Authorization: `Bearer ${tokens.eu}`, "X-Log-Started-At": hoursAgo(1) },
    }), racing, defaults, log);
    expect(response.status).toBe(200);
    expect((await response.json<UploadResponse>()).matches).toMatchObject([{ status: "review", reviewReasons: ["merged_names"] }]);
    expect(await rows("SELECT status, review_reasons, rated_at FROM matches WHERE match_key = '000000000006'"))
      .toEqual([{ status: "review", review_reasons: "merged_names", rated_at: null }]);
    expect(await rows(`SELECT COUNT(*) AS n FROM rating_history WHERE match_id = ${await matchId("000000000006")}`)).toEqual([{ n: 0 }]);
    await finishRecompute();
    await expectRegionUpToDate("eu");
    await expectRegionUpToDate("na");
  });

  it("reviews a longer copy containing merged names and keeps existing review reasons", async () => {
    const { alpha, alfa } = await nameChange();
    await upload(matchLog({ key: "000000000006", rounds: 1 }), tokens.eu, hoursAgo(1));
    await adminOk(`players/${alfa}/merge`, { into: alpha });
    await db().prepare("UPDATE hosts SET trust = 'untrusted' WHERE id = 1").run();
    const response = await upload(matchLog({ key: "000000000006", players: ["Alpha", "Alfa", "Charlie", "Delta"] }), tokens.eu, hoursAgo(1));
    expect(response.matches).toMatchObject([{ action: "replace", status: "review", reviewReasons: ["untrusted_host", "merged_names"] }]);
    await finishRecompute();
    expect(await rows(`SELECT COUNT(*) AS n FROM rating_history WHERE match_id = ${await matchId("000000000006")}`)).toEqual([{ n: 0 }]);
  });

  it("keeps admin voids and rejections when a longer copy contains merged names", async () => {
    const { alpha, alfa } = await nameChange();
    await upload(matchLog({ key: "000000000006", rounds: 1 }), tokens.eu, hoursAgo(2));
    await upload(matchLog({ key: "000000000007", rounds: 1 }), tokens.eu, hoursAgo(1));
    await db().batch([
      db().prepare("UPDATE matches SET status = 'void' WHERE match_key = '000000000006'"),
      db().prepare("UPDATE matches SET status = 'rejected', rejection_code = 'admin', rejection_message = 'Rejected' WHERE match_key = '000000000007'"),
    ]);
    await adminOk(`players/${alfa}/merge`, { into: alpha });
    const voided = await upload(matchLog({ key: "000000000006", players: ["Alpha", "Alfa", "Charlie", "Delta"] }), tokens.eu, hoursAgo(2));
    expect(voided.matches).toMatchObject([{ status: "void" }]);
    const rejected = await upload(matchLog({ key: "000000000007", players: ["Alpha", "Alfa", "Charlie", "Delta"] }), tokens.eu, hoursAgo(1));
    expect(rejected.matches).toMatchObject([{ status: "rejected", rejection: { code: "admin" } }]);
  });

  it("refuses what can't be merged", async () => {
    const { alpha, alfa } = await nameChange();
    const bravo = await playerId("Bravo");
    expect((await admin(`players/${alfa}/merge`, {})).status).toBe(400);
    expect((await admin(`players/${alfa}/merge`, { into: "1" })).status).toBe(400);
    expect((await admin(`players/${alfa}/merge`, { into: alfa })).status).toBe(400);
    expect((await admin(`players/${alfa}/merge`, { into: 999999 })).status).toBe(404);
    expect((await admin(`players/999999/merge`, { into: alpha })).status).toBe(404);
    expect((await admin(`players/${alfa}/merge`)).status).toBe(405);
    // Two names in one round are two players.
    const together = await admin(`players/${bravo}/merge`, { into: alpha });
    expect(together.status).toBe(409);
    expect(await together.text()).toContain("together");

    await adminOk(`players/${alfa}/merge`, { into: alpha });
    expect((await admin(`players/${alfa}/merge`, { into: alpha })).status).toBe(409);
    expect((await admin(`players/${await playerId("Golf")}/merge`, { into: alfa })).status).toBe(409);
    expect(await rows("SELECT COUNT(*) AS n FROM player_merges")).toEqual([{ n: 1 }]);
  });

  it("writes nothing when a player was merged after the handler read it", async () => {
    const { alpha, alfa } = await nameChange();
    await writeMerge(db(), { from: alfa, into: alpha, adminId: 1, at: "2026-10-05T12:00:00Z", detail: {} });
    const before = await snapshot();
    const error = await writeMerge(db(), { from: await playerId("Golf"), into: alfa, adminId: 1, at: "2026-10-05T12:00:00Z", detail: {} }).catch((e: unknown) => e);
    expect(isStale(error)).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});

describe("players: undo a merge", () => {
  it("restores exactly what was there", async () => {
    const { alpha, alfa } = await nameChange();
    const before = await snapshot();
    const { merge } = await adminOk<{ merge: { id: number } }>(`players/${alfa}/merge`, { into: alpha });
    await finishRecompute();

    const res = await admin(`merges/${merge.id}/undo`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ merge: { id: merge.id, undoneBy: "Ada" } });
    await finishRecompute();
    expect(await snapshot()).toEqual(before);
    expect(await rows("SELECT action FROM admin_actions ORDER BY id")).toEqual([{ action: "player_merge" }, { action: "player_unmerge" }]);
  });

  it("gives back the matches uploaded under the merged names since the merge", async () => {
    const { alpha, alfa } = await nameChange();
    const { merge } = await adminOk<{ merge: { id: number } }>(`players/${alfa}/merge`, { into: alpha });
    await upload(matchLog({ key: "000000000006", players: ["alfa", "Bravo", "Echo", "Golf"] }), tokens.eu, hoursAgo(1));
    await upload(matchLog({ key: "000000000007", players: ["Alpha", "Charlie", "Echo", "Golf"] }), tokens.eu, hoursAgo(0.5));

    await adminOk(`merges/${merge.id}/undo`, {});
    expect(await rows(`SELECT player_id FROM match_players WHERE match_id = ${await matchId("000000000006")} AND log_id = 1`)).toEqual([{ player_id: alfa }]);
    expect(await rows(`SELECT player_id FROM match_players WHERE match_id = ${await matchId("000000000007")} AND log_id = 1`)).toEqual([{ player_id: alpha }]);
    expect(await rows(`SELECT DISTINCT player_id FROM round_players rp JOIN rounds r ON r.id = rp.round_id WHERE r.match_id = ${await matchId("000000000006")} AND rp.log_id = 1`)).toEqual([{ player_id: alfa }]);
    // The spelling seen most recently.
    expect(await rows(`SELECT id, name, merged_into FROM players WHERE id IN (${alpha}, ${alfa}) ORDER BY id`)).toEqual([
      { id: alpha, name: "Alpha", merged_into: null },
      { id: alfa, name: "alfa", merged_into: null },
    ]);
    await finishRecompute();
    await expectRegionUpToDate("eu");
    await expectRegionUpToDate("na");
  });

  it("moves a new Unicode spelling uploaded after reading the undo, by its persisted alias id", async () => {
    await upload(matchLog(), tokens.eu, hoursAgo(3));
    await upload(matchLog({ key: "000000000002", players: ["Älfa", "Echo", "Foxtrot", "Golf"] }), tokens.eu, hoursAgo(2));
    const alpha = await playerId("Alpha");
    const alfa = (await db().prepare("SELECT player_id AS id FROM aliases WHERE name_key = ?").bind("älfa").first<{ id: number }>())!.id;
    const { merge } = await adminOk<{ merge: { id: number } }>(`players/${alfa}/merge`, { into: alpha });
    const racing = beforeBatch(() => upload(matchLog({ key: "000000000003", players: ["ÄLFA", "Bravo", "Charlie", "Delta"] }), tokens.eu, hoursAgo(1)));
    const response = await adminWith(racing, `merges/${merge.id}/undo`, {});
    expect(response.status).toBe(200);
    const id = await matchId("000000000003");
    expect(await rows(`SELECT player_id, name FROM match_players WHERE match_id = ${id} AND log_id = 1`))
      .toEqual([{ player_id: alfa, name: "ÄLFA" }]);
    expect(await rows(`SELECT DISTINCT player_id FROM round_players rp JOIN rounds r ON r.id = rp.round_id WHERE r.match_id = ${id} AND rp.log_id = 1`))
      .toEqual([{ player_id: alfa }]);
    await finishRecompute();
    await expectRegionUpToDate("eu");
  });

  it("undoes merges newest first, and only once", async () => {
    const { alpha, alfa } = await nameChange();
    // Zulu never played with Alfa or Alpha.
    await upload(matchLog({ key: "000000000006", players: ["Zulu", "Bravo", "Charlie", "Delta"] }), tokens.na, hoursAgo(1));
    const zulu = await playerId("Zulu");
    const first = await adminOk<{ merge: { id: number } }>(`players/${zulu}/merge`, { into: alfa });
    // Alfa (with Zulu's names) goes into Alpha.
    const second = await adminOk<{ merge: { id: number } }>(`players/${alfa}/merge`, { into: alpha });
    const before = await snapshot();
    const refused = await admin(`merges/${first.merge.id}/undo`, {});
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(`undo merge ${second.merge.id} first`);
    expect(await snapshot()).toEqual(before);

    await adminOk(`merges/${second.merge.id}/undo`, {});
    await adminOk(`merges/${first.merge.id}/undo`, {});
    expect((await admin(`merges/${first.merge.id}/undo`, {})).status).toBe(409);
    expect((await admin("merges/999/undo", {})).status).toBe(404);
    expect(await rows(`SELECT player_id FROM aliases WHERE name = 'Zulu'`)).toEqual([{ player_id: zulu }]);
    await finishRecompute();
    await expectRegionUpToDate("eu");
    await expectRegionUpToDate("na");
  });

  it("lists merges, newest first, and a player's merges on their admin page", async () => {
    const { alpha, alfa } = await nameChange();
    const { merge } = await adminOk<{ merge: { id: number } }>(`players/${alfa}/merge`, { into: alpha });
    const { merges } = await adminOk<{ merges: unknown[] }>("merges");
    expect(merges).toEqual([
      { id: merge.id, from: { id: alfa, name: "Alfa" }, into: { id: alpha, name: "Alfa" }, aliases: ["Alfa"], mergedBy: "Ada", mergedAt: expect.any(String), undoneBy: null, undoneAt: null },
    ]);
    const page = await adminOk<{ player: Record<string, unknown>; merges: unknown[] }>(`players/${alpha}`);
    expect(page.player).toMatchObject({ id: alpha, nameFixed: false, mergedInto: null, matches: 5 });
    expect(page.merges).toEqual(merges);
    expect((await adminOk<{ player: { mergedInto: number } }>(`players/${alfa}`)).player.mergedInto).toBe(alpha);
    expect((await admin("players/999999")).status).toBe(404);
  });
});

describe("players: search for admins", () => {
  it("finds players by any of their names, with every name", async () => {
    await nameChange();
    const { players } = await adminOk<{ players: { name: string; matchedAlias: string | null; aliases: string[] }[] }>("players?search=al");
    expect(players.map((p) => p.name).sort()).toEqual(["Alfa", "Alpha"]);
    expect((await admin("players?search=a")).status).toBe(400);
    expect((await admin("players", {})).status).toBe(405);
  });
});

describe("players: display name", () => {
  it("keeps the newest-seen alias and rank tag when an older alias is uploaded late", async () => {
    const { alpha, alfa } = await nameChange();
    await adminOk(`players/${alfa}/merge`, { into: alpha });
    await finishRecompute();
    const response = await upload(matchLog({ key: "000000000006" }), tokens.eu, hoursAgo(9.5));
    expect(response.matches).toMatchObject([{ status: "accepted", reviewReasons: [] }]);
    expect(await rows(`SELECT name, name_fixed FROM players WHERE id = ${alpha}`)).toEqual([{ name: "Alfa", name_fixed: 0 }]);
    const candidates = await listTagCandidates(db(), "eu", 0, 0, "", defaults.rankTagsMaxNames);
    expect(candidates.find((c) => c.playerId === alpha)?.name).toBe("Alfa");
    await finishRecompute();
    await expectRegionUpToDate("eu");
  });

  it("sets a name uploads keep, adds it as a name, and goes back to the logs' name", async () => {
    const { alpha } = await nameChange();
    const res = await admin(`players/${alpha}/name`, { name: " Alpha Prime " });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ player: { id: alpha, name: "Alpha Prime", nameFixed: true } });
    expect(await rows(`SELECT name, first_seen_at, last_seen_at FROM aliases WHERE player_id = ${alpha} ORDER BY id`)).toEqual([
      { name: "Alpha", first_seen_at: expect.any(String), last_seen_at: expect.any(String) },
      { name: "Alpha Prime", first_seen_at: "", last_seen_at: "" },
    ]);

    await upload(matchLog({ key: "000000000006" }), tokens.eu, hoursAgo(1));
    expect(await rows(`SELECT name FROM players WHERE id = ${alpha}`)).toEqual([{ name: "Alpha Prime" }]);
    // The rank tags keep the name the game shows.
    const candidates = await listTagCandidates(db(), "eu", 0, 0, "", defaults.rankTagsMaxNames);
    expect(candidates.find((c) => c.playerId === alpha)?.name).toBe("Alpha");

    // A log with the new name counts for the player.
    await upload(matchLog({ key: "000000000007", players: ["alpha prime", "Bravo", "Charlie", "Delta"] }), tokens.eu, hoursAgo(0.5));
    expect(await rows(`SELECT player_id FROM match_players WHERE match_id = ${await matchId("000000000007")} AND log_id = 1`)).toEqual([{ player_id: alpha }]);

    await adminOk(`players/${alpha}/name`, { name: null });
    expect(await rows(`SELECT name, name_fixed FROM players WHERE id = ${alpha}`)).toEqual([{ name: "alpha prime", name_fixed: 0 }]);
    const logged = await rows("SELECT action, detail FROM admin_actions ORDER BY id");
    expect(logged.map((r) => [r.action, JSON.parse(r.detail as string)])).toEqual([
      ["player_name", { player: alpha, from: "Alpha", to: "Alpha Prime" }],
      ["player_name", { player: alpha, from: "Alpha Prime", to: null }],
    ]);
  });

  it("takes one of the player's own names in another spelling", async () => {
    const { alpha } = await nameChange();
    await adminOk(`players/${alpha}/name`, { name: "ALPHA" });
    expect(await rows(`SELECT name FROM aliases WHERE player_id = ${alpha}`)).toEqual([{ name: "Alpha" }]);
    expect(await rows(`SELECT name FROM players WHERE id = ${alpha}`)).toEqual([{ name: "ALPHA" }]);
  });

  it("refuses another player's name, a merged player, and bad names", async () => {
    const { alpha, alfa } = await nameChange();
    const taken = await admin(`players/${alpha}/name`, { name: "bravo" });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain("Merge");
    expect((await admin(`players/${alpha}/name`, {})).status).toBe(400);
    expect((await admin(`players/${alpha}/name`, { name: "  " })).status).toBe(400);
    expect((await admin(`players/${alpha}/name`, { name: "x".repeat(defaults.playerNameMaxLength + 1) })).status).toBe(400);
    expect((await admin("players/999999/name", { name: "Zed" })).status).toBe(404);
    await adminOk(`players/${alfa}/merge`, { into: alpha });
    expect((await admin(`players/${alfa}/name`, { name: "Zed" })).status).toBe(409);
    expect(await rows("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'player_name'")).toEqual([{ n: 0 }]);
  });

  it("a fixed name that was one of the merged names follows the logs again after the undo", async () => {
    const { alpha, alfa } = await nameChange();
    const { merge } = await adminOk<{ merge: { id: number } }>(`players/${alfa}/merge`, { into: alpha });
    await adminOk(`players/${alpha}/name`, { name: "Alfa" });
    await adminOk(`merges/${merge.id}/undo`, {});
    expect(await rows(`SELECT id, name, name_fixed FROM players WHERE id IN (${alpha}, ${alfa}) ORDER BY id`)).toEqual([
      { id: alpha, name: "Alpha", name_fixed: 0 },
      { id: alfa, name: "Alfa", name_fixed: 0 },
    ]);
  });
});
