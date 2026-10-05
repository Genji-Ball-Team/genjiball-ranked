import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults, findRegion } from "../src/config";
import { createLogger } from "../src/log";
import { displayRating, recompute, type RatingMatch } from "../src/rating/engine";
import { readRounds, readState } from "../src/rating/store";
import { markMatchesChanged, updateRatings } from "../src/rating/update";
import { sha256, type UploadResponse } from "../src/upload/handler";
import { matchId, matchLog } from "./helpers";

const db = () => env.DB;
const log = createLogger("error");
const adminToken = "admin-token";
const tokens = { eu: "eu-host", na: "na-host", none: "roaming-host" };

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
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust) VALUES (3, 'roaming', ?, 'trusted')").bind(await sha256(tokens.none)),
  ]);
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function upload(body: string, token: string, startedAt: string, region?: string) {
  return SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": startedAt, ...(region === undefined ? {} : { "X-Region": region }) },
  });
}

async function uploadOk(body: string, token: string, startedAt: string, region?: string): Promise<UploadResponse> {
  const res = await upload(body, token, startedAt, region);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function get<T = Record<string, unknown>>(path: string): Promise<T> {
  const res = await SELF.fetch(`https://example.com/api/${path}`);
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

async function playerId(name: string): Promise<number> {
  return (await db().prepare("SELECT id FROM players WHERE name = ?").bind(name).first<{ id: number }>())!.id;
}

/** The region's ratings in D1, and what a recompute from scratch over its accepted matches gives. */
async function regionRatings(region: string) {
  const { results: stored } = await db()
    .prepare("SELECT player_id AS playerId, mu, sigma, display, rounds, wins FROM ratings WHERE board = ? ORDER BY player_id")
    .bind(region)
    .all();
  const { results: matches } = await db()
    .prepare("SELECT id, played_at AS playedAt, tournament FROM matches WHERE status = 'accepted' AND region = ? ORDER BY played_at, id")
    .bind(region)
    .all<{ id: number; playedAt: string; tournament: number }>();
  const rounds = await readRounds(db(), matches.map((m) => m.id));
  const input: RatingMatch[] = matches.map((m) => ({ ...m, rounds: rounds.get(m.id)!, tournament: m.tournament === 1 }));
  const expected = [...recompute(input, defaults).ratings]
    .sort(([a], [b]) => a - b)
    .map(([playerId, r]) => ({ playerId, mu: r.mu, sigma: r.sigma, display: displayRating(r, defaults), rounds: r.rounds, wins: r.wins }));
  return { stored, expected };
}

describe("regions: config", () => {
  it("finds a region by id, ignoring case and spaces", () => {
    expect(findRegion(defaults.regions, " NA ")?.id).toBe("na");
    expect(findRegion(defaults.regions, "asia")).toBeNull();
    expect(findRegion(defaults.regions, null)).toBeNull();
  });
});

describe("regions: upload", () => {
  it("stores a match in the host's home region, or the X-Region it sends", async () => {
    expect(await uploadOk(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(3))).toMatchObject({ region: "eu", matches: [{ region: "eu" }] });
    expect(await uploadOk(matchLog({ key: "000000000002" }), tokens.eu, hoursAgo(2), "na")).toMatchObject({ region: "na" });
    expect(await uploadOk(matchLog({ key: "000000000003" }), tokens.none, hoursAgo(1), "EU")).toMatchObject({ region: "eu" });
    const regions = await db().prepare("SELECT match_key AS k, region FROM matches ORDER BY match_key").all();
    expect(regions.results).toEqual([
      { k: "000000000001", region: "eu" },
      { k: "000000000002", region: "na" },
      { k: "000000000003", region: "eu" },
    ]);
  });

  it("refuses an upload with no region, or one that isn't a region", async () => {
    const none = await upload(matchLog(), tokens.none, hoursAgo(1));
    expect(none.status).toBe(422);
    expect(await none.json()).toMatchObject({ error: "no_region" });
    const bad = await upload(matchLog(), tokens.eu, hoursAgo(1), "asia");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "bad_request" });
    expect(await db().prepare("SELECT COUNT(*) AS n FROM uploads").first("n")).toBe(0);
  });

  it("keeps a match in the region it was first stored in when a longer copy comes", async () => {
    await uploadOk(matchLog({ rounds: 1, end: false }), tokens.eu, hoursAgo(1));
    const longer = await uploadOk(matchLog(), tokens.eu, hoursAgo(1), "na");
    expect(longer).toMatchObject({ region: "na", matches: [{ action: "replace", region: "eu" }] });
    expect(await db().prepare("SELECT region FROM matches").first("region")).toBe("eu");
  });

  it("says the host's home region on /api/host/me", async () => {
    const res = await SELF.fetch("https://example.com/api/host/me", { headers: { Authorization: `Bearer ${tokens.na}` } });
    expect(await res.json()).toMatchObject({ host: { region: "na" } });
  });
});

describe("regions: ratings", () => {
  it("rates each region apart: an EU match never moves an NA rating", async () => {
    await uploadOk(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(5));
    await uploadOk(matchLog({ key: "000000000002", players: ["Alpha", "Bravo", "Echo", "Foxtrot"] }), tokens.na, hoursAgo(4));
    const naBefore = await regionRatings("na");
    await uploadOk(matchLog({ key: "000000000003", players: ["Bravo", "Alpha", "Charlie", "Delta"] }), tokens.eu, hoursAgo(3));

    const [eu, na] = [await regionRatings("eu"), await regionRatings("na")];
    expect(eu.stored).toEqual(eu.expected);
    expect(na.stored).toEqual(na.expected);
    expect(na.stored).toEqual(naBefore.stored);
    expect(eu.stored).toHaveLength(4);
    expect(na.stored).toHaveLength(4);
  });

  it("marks only the changed match's region stale, and recomputes it", async () => {
    await uploadOk(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(5));
    await uploadOk(matchLog({ key: "000000000002" }), tokens.na, hoursAgo(4));
    await uploadOk(matchLog({ key: "000000000003" }), tokens.eu, hoursAgo(3));
    const first = await matchId("000000000001");
    await db().prepare("UPDATE matches SET status = 'void' WHERE id = ?").bind(first).run();
    await markMatchesChanged(db(), [first], new Date());

    expect((await readState(db(), "eu")).staleFrom).toMatchObject({ id: first });
    expect((await readState(db(), "na")).staleFrom).toBeNull();
    await updateRatings(db(), defaults, new Date(), log);
    expect((await readState(db(), "eu")).staleFrom).toBeNull();
    const eu = await regionRatings("eu");
    expect(eu.stored).toEqual(eu.expected);
  });

  it("makes the rating state of a region added to the config the first time it's read", async () => {
    expect(await readState(db(), "oce")).toEqual({ version: 0, staleFrom: null });
    expect(await db().prepare("SELECT board FROM rating_state WHERE board = 'oce'").first("board")).toBe("oce");
  });
});

describe("regions: site", () => {
  beforeEach(async () => {
    await uploadOk(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(5));
    await uploadOk(matchLog({ key: "000000000002" }), tokens.eu, hoursAgo(4));
    await uploadOk(matchLog({ key: "000000000003", players: ["Alpha", "Echo", "Foxtrot", "Golf"] }), tokens.na, hoursAgo(3));
    await uploadOk(matchLog({ key: "000000000004", players: ["Alpha", "Echo", "Foxtrot", "Golf"] }), tokens.na, hoursAgo(2));
  });

  it("has a leaderboard per region, the first region without ?region=", async () => {
    type Board = { region: string; players: { name: string }[] };
    const eu = await get<Board>("leaderboard?region=eu");
    const na = await get<Board>("leaderboard?region=NA");
    expect(eu.region).toBe("eu");
    expect(eu.players.map((p) => p.name).sort()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    expect(na.players.map((p) => p.name).sort()).toEqual(["Alpha", "Echo", "Foxtrot", "Golf"]);
    expect(await get("leaderboard")).toEqual(eu);
    const bad = await SELF.fetch("https://example.com/api/leaderboard?region=asia");
    expect(bad.status).toBe(400);
  });

  it("shows a player's rating and matches in one region, and the regions they're rated in", async () => {
    type Player = { region: string; player: { regions: string[]; rating: { rounds: number } | null }; matches: { id: number }[] };
    const alpha = await playerId("Alpha");
    const eu = await get<Player>(`players/${alpha}?region=eu`);
    const na = await get<Player>(`players/${alpha}?region=na`);
    expect(eu.player.regions).toEqual(["eu", "na"]);
    expect(eu.matches.map((m) => m.id)).toEqual([await matchId("000000000002"), await matchId("000000000001")]);
    expect(na.matches.map((m) => m.id)).toEqual([await matchId("000000000004"), await matchId("000000000003")]);
    expect(eu.player.rating!.rounds).toBe(4);
    expect(na.player.rating!.rounds).toBe(4);

    const bravo = await get<Player>(`players/${await playerId("Bravo")}?region=na`);
    expect(bravo).toMatchObject({ region: "na", player: { regions: ["eu"], rating: null }, matches: [] });
  });

  it("gives a match its region, with the ratings of that region", async () => {
    const id = await matchId("000000000003");
    const { match } = await get<{ match: { region: string; players: { name: string; ratingAfter: number | null }[] } }>(`matches/${id}`);
    expect(match.region).toBe("na");
    const naAlpha = await db()
      .prepare("SELECT display FROM rating_history WHERE board = 'na' AND match_id = ? AND player_id = ?")
      .bind(id, await playerId("Alpha"))
      .first("display");
    expect(match.players.find((p) => p.name === "Alpha")!.ratingAfter).toBe(naAlpha);
  });

  it("searches players with the region's ratings, only those rated there when ?region= is sent", async () => {
    type Search = { region: string; players: { name: string; rating: number | null }[] };
    const naAlpha = await db().prepare("SELECT display FROM ratings WHERE board = 'na' AND player_id = ?").bind(await playerId("Alpha")).first("display");
    const na = await get<Search>("players?search=al&region=na");
    expect(na.region).toBe("na");
    expect(na.players.map((p) => [p.name, p.rating])).toEqual([["Alpha", naAlpha]]);
    const delta = await get<Search>("players?search=delta");
    expect(delta).toMatchObject({ region: "eu", players: [{ name: "Delta" }] });
    expect(delta.players[0]!.rating).not.toBeNull();
    expect((await get<Search>("players?search=delta&region=na")).players).toEqual([]);
  });

  it("lists every region's matches in the feed, or one region's with ?region=", async () => {
    type Feed = { matches: { id: number; region: string; players: { name: string; ratingAfter: number | null }[] }[] };
    const all = await get<Feed>("matches?after=0");
    expect(all.matches.map((m) => m.region)).toEqual(["eu", "eu", "na", "na"]);
    const na = await get<Feed>("matches?after=0&region=na");
    expect(na.matches.map((m) => m.id)).toEqual([await matchId("000000000003"), await matchId("000000000004")]);
    expect(na.matches[0]!.players.every((p) => p.ratingAfter !== null)).toBe(true);
    expect((await SELF.fetch("https://example.com/api/matches?after=0&region=asia")).status).toBe(400);
  });

  it("builds rank tags from the region's ratings", async () => {
    const config = { ...defaults, tiers: [{ label: "Anyone", color: [1, 2, 3] as [number, number, number], threshold: 0 }] };
    const { handleSite } = await import("../src/site/handler");
    const tags = async (region: string) => {
      const res = await handleSite(new Request(`https://example.com/api/rank-tags?region=${region}`), db(), config);
      return (await res!.json()) as { region: string; tiers: { names: string[] }[] };
    };
    expect((await tags("na")).tiers[0]!.names.sort()).toEqual(["Alpha", "Echo", "Foxtrot", "Golf"]);
    expect((await tags("eu")).tiers[0]!.names.sort()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });
});

describe("regions: admin", () => {
  it("sets a host's home region, which its next uploads use", async () => {
    const res = await admin("hosts/3/region", { region: "na" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ host: { id: 3, region: "na" } });
    expect(await uploadOk(matchLog(), tokens.none, hoursAgo(1))).toMatchObject({ region: "na" });
    expect((await admin("hosts/3/region", { region: null })).status).toBe(200);
    expect((await upload(matchLog({ key: "000000000002" }), tokens.none, hoursAgo(1))).status).toBe(422);
    expect((await admin("hosts/3/region", { region: "asia" })).status).toBe(400);
    expect((await admin("hosts/3/region", {})).status).toBe(400);
    expect((await admin("hosts/99/region", { region: "eu" })).status).toBe(404);
    const logged = await db().prepare("SELECT detail FROM admin_actions WHERE action = 'host_region' ORDER BY id").all<{ detail: string }>();
    expect(logged.results.map((r) => JSON.parse(r.detail))).toEqual([{ from: null, to: "na" }, { from: "na", to: null }]);
  });

  it("moves a match to the other region: its ratings leave the old leaderboard and it's rated in the new one", async () => {
    await uploadOk(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(6));
    await uploadOk(matchLog({ key: "000000000002", players: ["Alpha", "Bravo", "Echo", "Foxtrot"] }), tokens.eu, hoursAgo(5));
    await uploadOk(matchLog({ key: "000000000003" }), tokens.eu, hoursAgo(4));
    await uploadOk(matchLog({ key: "000000000004", players: ["Alpha", "Golf", "Hotel", "India"] }), tokens.na, hoursAgo(3));
    await uploadOk(matchLog({ key: "000000000005", players: ["Kilo", "Lima", "Mike", "November"] }), tokens.eu, hoursAgo(2));

    // The middle EU match: later EU matches are recomputed without it.
    const middle = await matchId("000000000002");
    const res = await admin(`matches/${middle}/region`, { region: "na" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ match: { id: middle, region: "na" } });
    // The newest EU match, whose players played nowhere else.
    expect((await admin(`matches/${await matchId("000000000005")}/region`, { region: "na" })).status).toBe(200);
    while ((await readState(db(), "eu")).staleFrom || (await readState(db(), "na")).staleFrom) {
      await updateRatings(db(), defaults, new Date(), log);
    }

    for (const region of ["eu", "na"]) {
      const { stored, expected } = await regionRatings(region);
      expect(stored, region).toEqual(expected);
    }
    const euPlayers = await db().prepare("SELECT p.name FROM ratings r JOIN players p ON p.id = r.player_id WHERE r.board = 'eu' ORDER BY p.name").all<{ name: string }>();
    expect(euPlayers.results.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM rating_history WHERE board = 'eu' AND match_id = ?").bind(middle).first("n")).toBe(0);
    const logged = await db().prepare("SELECT detail FROM admin_actions WHERE action = 'match_region' ORDER BY id").first<{ detail: string }>();
    expect(JSON.parse(logged!.detail)).toEqual({ from: "eu", to: "na" });
  });

  it("refuses a move to the same region, to no region, or of a tourney lobby's match", async () => {
    await uploadOk(matchLog(), tokens.eu, hoursAgo(1));
    const id = await matchId("000000000001");
    expect((await admin(`matches/${id}/region`, { region: "eu" })).status).toBe(409);
    expect((await admin(`matches/${id}/region`, { region: "asia" })).status).toBe(400);
    expect((await admin("matches/999/region", { region: "na" })).status).toBe(404);
    const { tourney } = (await (await admin("tourneys", { name: "Cup", region: "eu", startsAt: "2026-12-01T19:00:00Z" })).json()) as { tourney: { id: number } };
    const { lobby } = (await (await admin(`tourneys/${tourney.id}/lobbies`, { label: "Lobby 1" })).json()) as { lobby: { id: number } };
    expect((await admin(`lobbies/${lobby.id}`, { matchId: id })).status).toBe(200);
    expect((await admin(`matches/${id}/region`, { region: "na" })).status).toBe(409);
    expect(await db().prepare("SELECT region FROM matches WHERE id = ?").bind(id).first("region")).toBe("eu");
  });

  it("filters the match list by region", async () => {
    await uploadOk(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await uploadOk(matchLog({ key: "000000000002" }), tokens.na, hoursAgo(1));
    const list = async (query: string) =>
      ((await (await admin(`matches?status=accepted${query}`)).json()) as { matches: { matchKey: string; region: string }[] }).matches;
    expect((await list("")).map((m) => m.region)).toEqual(["na", "eu"]);
    expect((await list("&region=na")).map((m) => m.matchKey)).toEqual(["000000000002"]);
    expect((await admin("matches?region=asia")).status).toBe(400);
  });

  it("imports a legacy log into the region asked for, or the host's", async () => {
    const legacy = "[00:00:21] KILL|21.81|Alpha|Bravo\n[00:00:29] KILL|29.23|Alpha|Charlie\n";
    const imported = await SELF.fetch("https://example.com/api/admin/legacy-import?host=1&region=na", {
      method: "POST",
      body: legacy,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);
    expect(await imported.json()).toMatchObject({ region: "na" });
    const roaming = await SELF.fetch("https://example.com/api/admin/legacy-import?host=3", {
      method: "POST",
      body: legacy,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(roaming.status).toBe(400);
  });
});

describe("regions: tourneys", () => {
  it("lists a region's tourneys, and only links a match from the tourney's region", async () => {
    const created = await admin("tourneys", { name: "NA Cup", region: "na", startsAt: "2026-12-01T19:00:00Z" });
    expect(created.status).toBe(201);
    const { tourney } = (await created.json()) as { tourney: { id: number; region: string } };
    expect(tourney.region).toBe("na");
    expect((await admin("tourneys", { name: "No region", startsAt: "2026-12-01T19:00:00Z" })).status).toBe(400);

    type Page = { region: string; upcoming: { id: number }[] };
    expect((await get<Page>("tourneys?region=na")).upcoming.map((t) => t.id)).toEqual([tourney.id]);
    expect((await get<Page>("tourneys")).upcoming).toEqual([]);

    await uploadOk(matchLog({ key: "000000000001" }), tokens.eu, hoursAgo(2));
    await uploadOk(matchLog({ key: "000000000002" }), tokens.na, hoursAgo(1));
    const lobby = ((await (await admin(`tourneys/${tourney.id}/lobbies`, { label: "Lobby 1" })).json()) as { lobby: { id: number } }).lobby.id;
    const wrong = await admin(`lobbies/${lobby}`, { matchId: await matchId("000000000001") });
    expect(wrong.status).toBe(409);
    expect((await admin(`lobbies/${lobby}`, { matchId: await matchId("000000000002") })).status).toBe(200);

    const moved = await admin(`tourneys/${tourney.id}`, { region: "eu" });
    expect(moved.status).toBe(409);
    expect((await admin(`lobbies/${lobby}`, { matchId: null })).status).toBe(200);
    expect((await admin(`tourneys/${tourney.id}`, { region: "eu" })).status).toBe(200);
  });
});
