import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256, type UploadResponse } from "../src/upload/handler";
import { matchLog } from "./helpers";
import example from "./fixtures/ranked-log-example.txt?raw";
import tourneyExample from "./fixtures/ranked-log-tourney-example.txt?raw";

/** Uploads of tourney matches (#23): linked to their lobby by `TOURNEY` `lobbyKey`, or held for review. */

const db = () => env.DB;
const adminToken = "admin-token";
const tokens = { host: "host-token", other: "other-host-token" };
const lobbyKey = "073518264903";
const matchKey = "219604738815";

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = [
    "screenshot_deletions",
    "tourney_lobbies",
    "tourneys",
    "admin_actions",
    "admins",
    "events",
    "round_players",
    "rounds",
    "match_players",
    "rating_history",
    "ratings",
    "matches",
    "uploads",
    "aliases",
    "players",
    "hosts",
  ];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'Kenzo', ?, 'trusted', 'eu')").bind(await sha256(tokens.host)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (2, 'Other', ?, 'trusted', 'eu')").bind(await sha256(tokens.other)),
    db().prepare("INSERT INTO tourneys (id, name, starts_at, status, region) VALUES (1, 'October Cup', '2026-10-10T17:00:00Z', 'live', 'eu')"),
    // The example's lobby: assigned to host 1, 3 rounds.
    db().prepare("INSERT INTO tourney_lobbies (id, tourney_id, label, lobby_key, host_id, round_limit) VALUES (1, 1, 'Lobby 1/2', ?, 1, 3)").bind(lobbyKey),
  ]);
});

async function upload(body: string, token = tokens.host, headers: Record<string, string> = {}): Promise<UploadResponse> {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

/** The example cut after its first `lines` lines, like an early copy of the match. */
const copy = (lines: number) => tourneyExample.split(/\r?\n/).slice(0, lines).join("\n");

async function lobby() {
  return (await db().prepare("SELECT match_id AS matchId, version, verified_at AS verifiedAt FROM tourney_lobbies WHERE id = 1").first<{
    matchId: number | null;
    version: number;
    verifiedAt: string | null;
  }>())!;
}

async function match(key = matchKey) {
  return (await db()
    .prepare("SELECT id, status, review_reasons AS reviewReasons, tournament, feed_seq AS feedSeq, rated_at AS ratedAt FROM matches WHERE match_key = ?")
    .bind(key)
    .first<{ id: number; status: string; reviewReasons: string | null; tournament: number; feedSeq: number | null; ratedAt: string | null }>())!;
}

/** Uploads the example and expects it held for review with these reasons, and not linked. */
async function expectReview(reasons: string[], token = tokens.host, headers: Record<string, string> = {}) {
  const body = await upload(tourneyExample, token, headers);
  expect(body.matches).toEqual([expect.objectContaining({ matchKey, action: "insert", status: "review", reviewReasons: reasons })]);
  expect(await match()).toMatchObject({ status: "review", reviewReasons: reasons.join(","), tournament: 0 });
  expect((await lobby()).matchId).toBeNull();
}

describe("upload: tourney matches", () => {
  it("links a tourney match to its lobby, as a tournament, rated and in the feed", async () => {
    const before = await lobby();
    const body = await upload(tourneyExample);
    expect(body.matches).toEqual([expect.objectContaining({ matchKey, action: "insert", status: "accepted", reviewReasons: [] })]);
    const stored = await match();
    expect(stored).toMatchObject({ status: "accepted", reviewReasons: null, tournament: 1 });
    expect(stored.feedSeq).not.toBeNull();
    expect(stored.ratedAt).not.toBeNull();
    expect(await lobby()).toEqual({ matchId: stored.id, version: before.version + 1, verifiedAt: null });

    const site = await SELF.fetch(`https://example.com/api/matches/${stored.id}`);
    expect(((await site.json()) as { match: { tournament: boolean; tourney: unknown } }).match).toMatchObject({
      tournament: true,
      tourney: { id: 1, name: "October Cup", lobby: "Lobby 1/2" },
    });
    const tourneys = (await (await SELF.fetch("https://example.com/api/tourneys?region=eu")).json()) as {
      upcoming: { lobbies: { matchId: number; standings: { place: number; name: string; wins: number; kills: number }[] }[] }[];
    };
    const shown = tourneys.upcoming[0]!.lobbies[0]!;
    expect(shown.matchId).toBe(stored.id);
    expect(shown.standings.map((s) => [s.place, s.name, s.wins, s.kills])).toEqual([
      [1, "Tidal", 2, 3],
      [2, "Mochi", 0, 1],
      [2, "Sparrow", 0, 1],
      [4, "Ghost", 0, 0],
    ]);
  });

  it("keeps format 1 and format 2 ranked matches ranked", async () => {
    const ranked = await upload(matchLog({ key: "000000000001" }));
    expect(ranked.matches[0]).toMatchObject({ status: "accepted", reviewReasons: [] });
    expect(await match("000000000001")).toMatchObject({ tournament: 0 });
    // The format 2 ranked example has two players named Ghost: review for that alone.
    const v2 = await upload(example);
    expect(v2.matches[0]).toMatchObject({ status: "review", reviewReasons: ["duplicate_name"] });
    expect(await match("482913507226")).toMatchObject({ tournament: 0 });
    expect((await lobby()).matchId).toBeNull();
  });

  it("holds a match for an unknown lobbyKey", async () => {
    await db().prepare("UPDATE tourney_lobbies SET lobby_key = '999999999999' WHERE id = 1").run();
    await expectReview(["tourney_unknown_lobby"]);
  });

  it("holds a match uploaded by a host who isn't the lobby's", async () => {
    await expectReview(["tourney_wrong_host"], tokens.other);
  });

  it("holds a match from another region than the tourney's", async () => {
    await expectReview(["tourney_wrong_region"], tokens.host, { "X-Region": "na" });
  });

  it("holds a match of a cancelled tourney", async () => {
    await db().prepare("UPDATE tourneys SET status = 'cancelled' WHERE id = 1").run();
    await expectReview(["tourney_cancelled"]);
  });

  it("holds a match for a lobby that already has another", async () => {
    await upload(matchLog({ key: "000000000001" }));
    const other = await match("000000000001");
    await db().prepare("UPDATE tourney_lobbies SET match_id = ? WHERE id = 1").bind(other.id).run();
    const body = await upload(tourneyExample);
    expect(body.matches[0]).toMatchObject({ status: "review", reviewReasons: ["tourney_lobby_taken"] });
    expect((await lobby()).matchId).toBe(other.id);
    expect(await match()).toMatchObject({ tournament: 0 });
  });

  it("holds a match whose round limit isn't the lobby's", async () => {
    await db().prepare("UPDATE tourney_lobbies SET round_limit = 5 WHERE id = 1").run();
    await expectReview(["tourney_round_limit"]);
  });

  it("compares the round limit with tourneyRoundLimit for a lobby without its own", async () => {
    await db().prepare("UPDATE tourney_lobbies SET round_limit = NULL WHERE id = 1").run();
    await expectReview(["tourney_round_limit"]);
  });

  it("lists every reason that applies", async () => {
    await db().prepare("UPDATE tourney_lobbies SET round_limit = 5 WHERE id = 1").run();
    await expectReview(["tourney_wrong_host", "tourney_round_limit"], tokens.other);
  });

  it("keeps the link for a longer copy, and clears the verification", async () => {
    const first = await upload(copy(20));
    expect(first.matches[0]).toMatchObject({ action: "insert", status: "accepted" });
    const id = (await match()).id;
    expect((await lobby()).matchId).toBe(id);
    await db().prepare("UPDATE tourney_lobbies SET verified_by = 1, verified_at = '2026-10-10T19:00:00Z' WHERE id = 1").run();
    const version = (await lobby()).version;

    const longer = await upload(tourneyExample);
    expect(longer.matches[0]).toMatchObject({ action: "replace", status: "accepted", reviewReasons: [] });
    expect(await match()).toMatchObject({ id, status: "accepted", tournament: 1 });
    expect(await lobby()).toEqual({ matchId: id, version: version + 1, verifiedAt: null });
  });

  it("links a longer copy when the first one didn't count", async () => {
    // Cut before any round ended: no rated round, rejected.
    const first = await upload(copy(8));
    expect(first.matches[0]).toMatchObject({ action: "insert", status: "rejected", rejection: { code: "too_few_players" } });
    expect((await lobby()).matchId).toBeNull();
    const longer = await upload(tourneyExample);
    expect(longer.matches[0]).toMatchObject({ action: "replace", status: "accepted" });
    expect((await lobby()).matchId).toBe((await match()).id);
    expect(await match()).toMatchObject({ tournament: 1 });
  });

  it("leaves a match an admin accepted without a lobby unlinked when a longer copy comes", async () => {
    await db().prepare("UPDATE tourney_lobbies SET round_limit = 5 WHERE id = 1").run();
    await upload(copy(20));
    await db().prepare("UPDATE matches SET status = 'accepted', review_reasons = NULL WHERE match_key = ?").bind(matchKey).run();
    await db().prepare("UPDATE tourney_lobbies SET round_limit = 3 WHERE id = 1").run();
    const longer = await upload(tourneyExample);
    expect(longer.matches[0]).toMatchObject({ action: "replace", status: "accepted", reviewReasons: [] });
    expect((await lobby()).matchId).toBeNull();
    expect(await match()).toMatchObject({ tournament: 0 });
  });

  it("holds the second of two matches for one lobby in the same file", async () => {
    const second = tourneyExample.replace(matchKey, "219604738816");
    const body = await upload(`${tourneyExample}\n${second}`);
    expect(body.matches.map((m) => [m.matchKey, m.status, m.reviewReasons])).toEqual([
      [matchKey, "accepted", []],
      ["219604738816", "review", ["tourney_lobby_taken"]],
    ]);
    expect((await lobby()).matchId).toBe((await match()).id);
  });

  it("holds a match whose lobby was taken between the read and the write", async () => {
    // The plan saw a free lobby; the write finds it taken and sends the match to review.
    await upload(matchLog({ key: "000000000001" }));
    const other = await match("000000000001");
    await db()
      .prepare(
        `CREATE TRIGGER take_lobby AFTER INSERT ON matches WHEN NEW.match_key = '${matchKey}'
         BEGIN UPDATE tourney_lobbies SET match_id = ${other.id} WHERE id = 1; END`,
      )
      .run();
    try {
      const body = await upload(tourneyExample);
      expect(body.matches[0]).toMatchObject({ status: "review", reviewReasons: ["tourney_lobby_taken"] });
      expect(await match()).toMatchObject({ status: "review", tournament: 0 });
      expect((await lobby()).matchId).toBe(other.id);
    } finally {
      await db().prepare("DROP TRIGGER take_lobby").run();
    }
  });

  it("shows the same in a dry-run parse, writing nothing", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/parse?host=2", {
      method: "POST",
      body: tourneyExample,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = (await res.json()) as { upload: { matches: unknown[] }; parser: { matches: unknown[] } };
    expect(body.upload.matches[0]).toMatchObject({ status: "review", reviewReasons: ["tourney_wrong_host"] });
    expect(body.parser.matches[0]).toMatchObject({ tourney: { lobbyKey, roundLimit: 3 }, lobbyId: null });
    expect(await db().prepare("SELECT count(*) AS n FROM matches").first("n")).toBe(0);
  });
});
