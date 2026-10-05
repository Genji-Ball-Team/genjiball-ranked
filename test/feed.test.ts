import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { handleSite } from "../src/site/handler";
import { sha256 } from "../src/upload/handler";
import { matchId, matchLog } from "./helpers";

const db = () => env.DB;
const token = "trusted-token";

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = ["events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts"];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'trusted', ?, 'trusted', 'eu')").bind(await sha256(token)),
  ]);
});

async function upload(log: string, startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()) {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body: log,
    headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": startedAt },
  });
  expect(res.status).toBe(200);
}

interface FeedMatch {
  id: number;
  removed: boolean;
  void?: boolean;
  complete?: boolean;
  rounds?: number;
  ratedRounds?: number;
  players?: { id: number; name: string; rounds: number; wins: number; ratingBefore: number | null; ratingAfter: number | null }[];
}
interface Feed {
  cursor: number;
  hasMore: boolean;
  matches: FeedMatch[];
}

async function feed(query: string): Promise<Feed> {
  const res = await SELF.fetch(`https://example.com/api/matches?${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

describe("match feed", () => {
  it("lists a new match with its players and ratings, then nothing past the cursor", async () => {
    await upload(matchLog({ key: "000000000001" }));
    const id = await matchId("000000000001");
    const first = await feed("after=0");
    expect(first.hasMore).toBe(false);
    expect(first.matches).toHaveLength(1);
    const [match] = first.matches;
    expect(match).toMatchObject({ id, removed: false, void: false, complete: true, rounds: 2, ratedRounds: 2 });
    expect(match!.players!.map((p) => [p.name, p.rounds, p.wins])).toEqual([
      ["Alpha", 2, 1],
      ["Bravo", 2, 1],
      ["Charlie", 2, 0],
      ["Delta", 2, 0],
    ]);
    expect(match!.players!.every((p) => p.ratingBefore === null && typeof p.ratingAfter === "number")).toBe(true);

    expect(await feed(`after=${first.cursor}`)).toEqual({ cursor: first.cursor, hasMore: false, matches: [] });
  });

  it("starts from now with after=latest", async () => {
    await upload(matchLog({ key: "000000000001" }));
    const { cursor, matches } = await feed("after=latest");
    expect(matches).toEqual([]);
    expect((await feed(`after=${cursor}`)).matches).toEqual([]);
    await upload(matchLog({ key: "000000000002" }));
    expect((await feed(`after=${cursor}`)).matches.map((m) => m.id)).toEqual([await matchId("000000000002")]);
  });

  it("lists a match again when it changes late: accepted from review, a longer copy, voided", async () => {
    await upload(matchLog({ key: "000000000001", rounds: 1, end: false }));
    await upload(matchLog({ key: "000000000002" }));
    const [first, second] = [await matchId("000000000001"), await matchId("000000000002")];
    let { cursor } = await feed("after=latest");

    await upload(matchLog({ key: "000000000001" }));
    let changed = await feed(`after=${cursor}`);
    expect(changed.matches.map((m) => [m.id, m.rounds, m.complete])).toEqual([[first, 2, true]]);
    cursor = changed.cursor;

    await db().prepare("UPDATE matches SET status = 'void' WHERE id = ?").bind(second).run();
    changed = await feed(`after=${cursor}`);
    expect(changed.matches.map((m) => [m.id, m.void])).toEqual([[second, true]]);
    cursor = changed.cursor;

    await db().prepare("UPDATE matches SET status = 'review' WHERE id = ?").bind(first).run();
    changed = await feed(`after=${cursor}`);
    expect(changed.matches).toEqual([{ id: first, removed: true }]);
    cursor = changed.cursor;
    await db().prepare("UPDATE matches SET status = 'accepted' WHERE id = ?").bind(first).run();
    expect((await feed(`after=${cursor}`)).matches.map((m) => [m.id, m.removed])).toEqual([[first, false]]);
  });

  it("leaves out matches that were never public, and changes that don't show in a post", async () => {
    await upload(matchLog({ key: "000000000001" }));
    const id = await matchId("000000000001");
    const { cursor } = await feed("after=latest");
    await db().prepare("UPDATE matches SET rated_at = '2026-10-05T00:00:00Z', upload_id = upload_id WHERE id = ?").bind(id).run();
    expect((await feed(`after=${cursor}`)).matches).toEqual([]);

    await db().prepare("UPDATE matches SET status = 'review', rejection_code = NULL").run();
    const { cursor: next } = await feed("after=latest");
    await db().prepare("UPDATE matches SET status = 'rejected' WHERE id = ?").bind(id).run();
    expect((await feed(`after=${next}`)).matches).toEqual([]);
  });

  it("pages oldest change first, at most matchFeedLimit", async () => {
    for (const key of ["000000000001", "000000000002", "000000000003"]) await upload(matchLog({ key }));
    const ids = [await matchId("000000000001"), await matchId("000000000002"), await matchId("000000000003")];
    const config = { ...defaults, matchFeedLimit: 2 };
    const read = async (query: string) => (await (await handleSite(new Request(`https://example.com/api/matches?${query}`), db(), config))!.json()) as Feed;

    const first = await read("after=0");
    expect(first.matches.map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(first.hasMore).toBe(true);
    const second = await read(`after=${first.cursor}`);
    expect(second.matches.map((m) => m.id)).toEqual(ids.slice(2));
    expect(second.hasMore).toBe(false);
    expect((await read("after=0&limit=1")).matches.map((m) => m.id)).toEqual(ids.slice(0, 1));
    expect((await handleSite(new Request("https://example.com/api/matches?after=0&limit=3"), db(), config))!.status).toBe(400);
  });

  it("is cached, and a 400 for a missing or malformed cursor", async () => {
    const res = await SELF.fetch("https://example.com/api/matches?after=0");
    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.publicCacheSeconds}`);
    for (const query of ["", "after=-1", "after=abc", "after=0&limit=0", `after=0&limit=${defaults.matchFeedLimit + 1}`]) {
      const bad = await SELF.fetch(`https://example.com/api/matches?${query}`);
      expect(bad.status, query).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "bad_request" });
    }
    expect((await SELF.fetch("https://example.com/api/matches?after=0", { method: "POST" })).status).toBe(405);
  });
});
