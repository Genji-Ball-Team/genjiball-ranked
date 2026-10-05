import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { codeFrom, newLobbyKey, roundLimitOf, tourneyCode, type CodeLobby } from "../src/tourney/code";
import { findLobby, isLobbyChanged, setScreenshot } from "../src/tourney/store";
import { sha256 } from "../src/upload/handler";
import { matchId, matchLog } from "./helpers";

// The host API for tourneys (#25, #28): assigned lobbies, the tourney code window, the host's screenshot.

const db = () => env.DB;
const adminToken = "admin-token";
const hostToken = "host-token";
const otherToken = "other-token";
const revokedToken = "revoked-token";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const minute = 60 * 1000;

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = [
    "host_actions",
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
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'Kenzo', ?, 'trusted', 'eu')").bind(await sha256(hostToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (2, 'Other', ?, 'untrusted', 'na')").bind(await sha256(otherToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (3, 'Gone', ?, 'revoked', 'eu')").bind(await sha256(revokedToken)),
  ]);
});

function admin(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return SELF.fetch(`https://example.com/api/admin/${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

async function adminOk<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await admin(path, body, method);
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res.json();
}

function host(path: string, { token = hostToken, method = "GET", body, headers = {} }: { token?: string; method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
  return SELF.fetch(`https://example.com/api/host/${path}`, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } });
}

async function hostLobbies(query = "", headers: Record<string, string> = {}, token = hostToken) {
  const res = await host(`tourneys${query}`, { token, headers });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json<{ region: string | null; codeLeadMinutes: number; lobbies: HostLobby[] }>();
}

interface HostLobby {
  id: number;
  label: string;
  region: string;
  roundLimit: number;
  tourney: { id: number; name: string; region: string; startsAt: string; status: string };
  matchId: number | null;
  screenshot: string | null;
  verified: boolean;
  codeFrom: string;
  code: { lobbyKey: string; roundLimit: number; name: string; label: string } | null;
}

interface AdminLobby {
  id: number;
  version: number;
  hostId: number | null;
  hostName: string | null;
  roundLimit: number;
  roundLimitDefault: boolean;
  lobbyKey: string;
  screenshotKey: string | null;
}

/** A tourney starting `minutesFromNow` from now. */
async function newTourney(minutesFromNow: number, fields: Record<string, unknown> = {}) {
  const startsAt = new Date(Date.now() + minutesFromNow * minute).toISOString();
  const { tourney } = await adminOk<{ tourney: { id: number } }>("tourneys", { name: "October Cup", region: "eu", startsAt, ...fields });
  return tourney.id;
}

async function newLobby(tourneyId: number, fields: Record<string, unknown> = {}) {
  const { lobby } = await adminOk<{ lobby: AdminLobby }>(`tourneys/${tourneyId}/lobbies`, { label: "Lobby 1/2", ...fields });
  return lobby;
}

async function uploadMatch(key = "000000000001") {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body: matchLog({ key }),
    headers: { Authorization: `Bearer ${hostToken}`, "X-Log-Started-At": new Date(Date.now() - 3600000).toISOString() },
  });
  expect(res.status).toBe(200);
  return matchId(key);
}

const putShot = (lobby: number, opts: { token?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
  host(`lobbies/${lobby}/screenshot`, { method: "PUT", body: png, ...opts });

describe("tourney code values", () => {
  const lobby = (fields: Partial<CodeLobby> = {}): CodeLobby => ({
    label: "Lobby 1/2",
    lobbyKey: "012345678901",
    roundLimit: null,
    matchId: null,
    tourneyName: "October Cup",
    tourneyStartsAt: "2026-10-10T19:00:00Z",
    tourneyStatus: "scheduled",
    ...fields,
  });

  it("makes lobby keys of tourneyLobbyKeyDigits random digits", () => {
    const key = newLobbyKey(defaults.tourneyLobbyKeyDigits);
    expect(key).toMatch(new RegExp(`^\\d{${defaults.tourneyLobbyKeyDigits}}$`));
    expect(newLobbyKey(defaults.tourneyLobbyKeyDigits)).not.toBe(key);
  });

  it("gives them from tourneyCodeLeadMinutes before the start until the lobby is done", () => {
    expect(codeFrom("2026-10-10T19:00:00Z", defaults)).toBe("2026-10-10T18:00:00Z");
    expect(tourneyCode(lobby(), defaults, new Date("2026-10-10T17:59:59Z"))).toBeNull();
    expect(tourneyCode(lobby(), defaults, new Date("2026-10-10T18:00:00Z"))).toEqual({
      lobbyKey: "012345678901",
      roundLimit: defaults.tourneyRoundLimit,
      name: "October Cup",
      label: "Lobby 1/2",
    });
    const later = new Date("2026-10-10T21:00:00Z");
    expect(tourneyCode(lobby({ tourneyStatus: "live", roundLimit: 20 }), defaults, later)?.roundLimit).toBe(20);
    expect(tourneyCode(lobby({ matchId: 5 }), defaults, later)).toBeNull();
    expect(tourneyCode(lobby({ tourneyStatus: "done" }), defaults, later)).toBeNull();
    expect(tourneyCode(lobby({ tourneyStatus: "cancelled" }), defaults, later)).toBeNull();
  });

  it("uses tourneyRoundLimit when a lobby has no round limit of its own", () => {
    expect(roundLimitOf(null, defaults)).toBe(defaults.tourneyRoundLimit);
    expect(roundLimitOf(12, defaults)).toBe(12);
  });
});

describe("admin: lobby hosts and round limits", () => {
  it("gives a new lobby a lobby key and the default round limit, and assigns its host", async () => {
    const tourney = await newTourney(24 * 60);
    const lobby = await newLobby(tourney);
    expect(lobby).toMatchObject({ hostId: null, hostName: null, roundLimit: defaults.tourneyRoundLimit, roundLimitDefault: true });
    expect(lobby.lobbyKey).toMatch(/^\d{12}$/);

    const { lobby: edited } = await adminOk<{ lobby: AdminLobby }>(`lobbies/${lobby.id}`, { hostId: 2, roundLimit: 20 });
    expect(edited).toMatchObject({ hostId: 2, hostName: "Other", roundLimit: 20, roundLimitDefault: false, lobbyKey: lobby.lobbyKey });
    const action = await db().prepare("SELECT action, host_id AS hostId, detail FROM admin_actions WHERE action = 'lobby_edit'").first<{ action: string; hostId: number; detail: string }>();
    expect(action).toMatchObject({ hostId: 2 });
    expect(JSON.parse(action!.detail)).toMatchObject({ lobby: lobby.id, hostId: 2, roundLimit: 20 });

    const { lobby: reset } = await adminOk<{ lobby: AdminLobby }>(`lobbies/${lobby.id}`, { hostId: null, roundLimit: null });
    expect(reset).toMatchObject({ hostId: null, roundLimit: defaults.tourneyRoundLimit, roundLimitDefault: true });

    const second = await newLobby(tourney, { label: "Lobby 2/2", hostId: 1, roundLimit: 10 });
    expect(second).toMatchObject({ hostId: 1, hostName: "Kenzo", roundLimit: 10 });
    expect(second.lobbyKey).not.toBe(lobby.lobbyKey);
    const { tourneys } = await adminOk<{ tourneys: { lobbies: AdminLobby[] }[] }>("tourneys");
    expect(tourneys[0]!.lobbies.map((l) => l.hostName)).toEqual([null, "Kenzo"]);
  });

  it("refuses an unknown or revoked host and a bad round limit", async () => {
    const lobby = await newLobby(await newTourney(60));
    expect((await admin(`lobbies/${lobby.id}`, { hostId: 99 })).status).toBe(404);
    expect((await admin(`lobbies/${lobby.id}`, { hostId: 3 })).status).toBe(409);
    expect((await admin(`lobbies/${lobby.id}`, { hostId: "1" })).status).toBe(400);
    expect((await admin(`lobbies/${lobby.id}`, { roundLimit: 0 })).status).toBe(400);
    expect((await admin(`lobbies/${lobby.id}`, { roundLimit: defaults.tourneyRoundLimitMax + 1 })).status).toBe(400);
    expect((await admin(`lobbies/${lobby.id}`, { roundLimit: 2.5 })).status).toBe(400);
    expect((await findLobby(db(), lobby.id))).toMatchObject({ hostId: null, roundLimit: null });
  });
});

describe("GET /api/host/tourneys", () => {
  it("needs a valid host token and GET", async () => {
    expect((await SELF.fetch("https://example.com/api/host/tourneys")).status).toBe(401);
    expect((await host("tourneys", { token: "nope" })).status).toBe(401);
    expect((await host("tourneys", { token: revokedToken })).status).toBe(403);
    expect((await host("tourneys", { method: "POST" })).status).toBe(405);
  });

  it("lists only the host's lobbies of scheduled and live tourneys, soonest first", async () => {
    const later = await newTourney(3 * 24 * 60, { name: "Later Cup" });
    const soon = await newTourney(2 * 24 * 60, { name: "Soon Cup", status: "live" });
    const done = await newTourney(-24 * 60, { name: "Done Cup", status: "done" });
    const mine = await newLobby(later, { hostId: 1 });
    const live = await newLobby(soon, { hostId: 1, label: "Lobby 2/2", roundLimit: 15 });
    await newLobby(soon, { hostId: 2 });
    await newLobby(done, { hostId: 1 });
    await newLobby(later);

    const answer = await hostLobbies();
    expect(answer.region).toBeNull();
    expect(answer.codeLeadMinutes).toBe(defaults.tourneyCodeLeadMinutes);
    expect(answer.lobbies.map((l) => l.id)).toEqual([live.id, mine.id]);
    expect(answer.lobbies[0]).toMatchObject({
      label: "Lobby 2/2",
      region: "eu",
      roundLimit: 15,
      tourney: { id: soon, name: "Soon Cup", region: "eu", status: "live" },
      matchId: null,
      screenshot: null,
      verified: false,
      code: null,
    });
    expect((await hostLobbies("", {}, otherToken)).lobbies.map((l) => l.label)).toEqual(["Lobby 1/2"]);
  });

  it("gives the code values from tourneyCodeLeadMinutes before the start until the lobby has a match", async () => {
    const lead = defaults.tourneyCodeLeadMinutes;
    const early = await newLobby(await newTourney(lead + 30, { name: "Early Cup" }), { hostId: 1 });
    const open = await newLobby(await newTourney(lead - 30, { name: "Open Cup" }), { hostId: 1, roundLimit: 25 });
    const [first, second] = (await hostLobbies()).lobbies;
    expect(first!.id).toBe(open.id);
    expect(first!.code).toEqual({ lobbyKey: open.lobbyKey, roundLimit: 25, name: "Open Cup", label: "Lobby 1/2" });
    expect(Date.parse(first!.codeFrom)).toBeLessThan(Date.now());
    expect(second!.id).toBe(early.id);
    expect(second!.code).toBeNull();
    expect(Date.parse(second!.codeFrom)).toBeGreaterThan(Date.now());

    // Played: the match is linked, and the lobby is done.
    await adminOk(`lobbies/${open.id}`, { matchId: await uploadMatch() });
    const played = (await hostLobbies()).lobbies.find((l) => l.id === open.id)!;
    expect(played.code).toBeNull();
    expect(played.matchId).not.toBeNull();
  });

  it("keeps regions apart: ?region= or X-Region lists only that region's lobbies, each saying its region", async () => {
    const eu = await newLobby(await newTourney(30, { name: "EU Cup", region: "eu" }), { hostId: 1 });
    const na = await newLobby(await newTourney(40, { name: "NA Cup", region: "na" }), { hostId: 1 });

    const all = await hostLobbies();
    expect(all.region).toBeNull();
    expect(all.lobbies.map((l) => [l.id, l.region, l.tourney.region])).toEqual([
      [eu.id, "eu", "eu"],
      [na.id, "na", "na"],
    ]);
    const naOnly = await hostLobbies("?region=na");
    expect(naOnly.region).toBe("na");
    expect(naOnly.lobbies.map((l) => [l.id, l.region])).toEqual([[na.id, "na"]]);
    expect(naOnly.lobbies[0]!.code?.lobbyKey).toBe(na.lobbyKey);
    const euOnly = await hostLobbies("", { "X-Region": "EU" });
    expect(euOnly.region).toBe("eu");
    expect(euOnly.lobbies.map((l) => l.id)).toEqual([eu.id]);
    // The query wins over the header.
    expect((await hostLobbies("?region=na", { "X-Region": "eu" })).lobbies.map((l) => l.id)).toEqual([na.id]);
  });

  it("answers 400 for a region that isn't one", async () => {
    const res = await host("tourneys?region=asia");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
    expect((await host("tourneys", { headers: { "X-Region": "mars" } })).status).toBe(400);
  });
});

describe("host screenshot: /api/host/lobbies/:id/screenshot", () => {
  it("lets the assigned host upload, replace and delete it, logged in host_actions", async () => {
    const lobby = await newLobby(await newTourney(30), { hostId: 1 });
    const first = await putShot(lobby.id);
    expect(first.status, await first.clone().text()).toBe(200);
    const { lobby: view } = await first.json<{ lobby: HostLobby }>();
    expect(view).toMatchObject({ id: lobby.id, region: "eu", verified: false });
    const key = (await findLobby(db(), lobby.id))!.screenshotKey!;
    expect(view.screenshot).toBe(`/api/screenshots/${key}`);
    expect(await env.PROOFS.head(key)).not.toBeNull();

    expect((await putShot(lobby.id)).status).toBe(200);
    const replaced = (await findLobby(db(), lobby.id))!.screenshotKey!;
    expect(replaced).not.toBe(key);
    expect(await env.PROOFS.head(key)).toBeNull();

    const removed = await host(`lobbies/${lobby.id}/screenshot`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await removed.json<{ lobby: HostLobby }>()).lobby.screenshot).toBeNull();
    expect(await env.PROOFS.head(replaced)).toBeNull();
    expect((await host(`lobbies/${lobby.id}/screenshot`, { method: "DELETE" })).status).toBe(409);

    const { results } = await db().prepare("SELECT host_id AS hostId, action, lobby_id AS lobbyId, detail FROM host_actions ORDER BY id").all<{ hostId: number; action: string; lobbyId: number; detail: string }>();
    expect(results.map((r) => [r.hostId, r.action, r.lobbyId])).toEqual([
      [1, "lobby_screenshot", lobby.id],
      [1, "lobby_screenshot", lobby.id],
      [1, "lobby_screenshot_delete", lobby.id],
    ]);
    expect(JSON.parse(results[0]!.detail)).toMatchObject({ lobby: lobby.id, bytes: png.length, type: "image/png" });
    expect(await db().prepare("SELECT count(*) AS n FROM admin_actions WHERE action LIKE 'lobby_screenshot%'").first("n")).toBe(0);
  });

  it("has the admin upload's size and type limits", async () => {
    const lobby = await newLobby(await newTourney(30), { hostId: 1 });
    expect((await putShot(lobby.id, { body: "<svg/>" })).status).toBe(415);
    expect((await putShot(lobby.id, { body: new Uint8Array(defaults.screenshotMaxBytes + 1) })).status).toBe(413);
    expect((await putShot(lobby.id, { body: new Uint8Array() })).status).toBe(400);
    expect((await findLobby(db(), lobby.id))!.screenshotKey).toBeNull();
  });

  it("is only for the lobby's assigned host", async () => {
    const tourney = await newTourney(30);
    const theirs = await newLobby(tourney, { hostId: 2 });
    const nobodys = await newLobby(tourney);
    for (const id of [theirs.id, nobodys.id]) {
      const res = await putShot(id);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "not_assigned" });
    }
    expect((await putShot(99999)).status).toBe(404);
    expect((await putShot(theirs.id, { token: revokedToken })).status).toBe(403);
    expect((await host(`lobbies/${theirs.id}/screenshot`, { method: "POST" })).status).toBe(405);
    expect((await host(`lobbies/${theirs.id}`, { method: "PUT" })).status).toBe(404);

    // Reassigned: the new host can, the old one can't any more.
    await adminOk(`lobbies/${theirs.id}`, { hostId: 1 });
    expect((await putShot(theirs.id)).status).toBe(200);
    expect((await putShot(theirs.id, { token: otherToken })).status).toBe(403);
  });

  it("stays in the tourney's region: a host sending another region is refused", async () => {
    const lobby = await newLobby(await newTourney(30, { region: "na" }), { hostId: 1 });
    const wrong = await putShot(lobby.id, { headers: { "X-Region": "eu" } });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ error: "wrong_region" });
    expect((await host(`lobbies/${lobby.id}/screenshot?region=eu`, { method: "DELETE" })).status).toBe(409);
    expect((await putShot(lobby.id, { headers: { "X-Region": "moon" } })).status).toBe(400);
    expect((await findLobby(db(), lobby.id))!.screenshotKey).toBeNull();

    const right = await putShot(lobby.id, { headers: { "X-Region": "na" } });
    expect(right.status).toBe(200);
    expect((await right.json<{ lobby: HostLobby }>()).lobby.region).toBe("na");
  });

  it("can't replace or delete it once an admin verified it, and can again once unverified", async () => {
    const lobby = await newLobby(await newTourney(30), { hostId: 1 });
    expect((await putShot(lobby.id)).status).toBe(200);
    await adminOk(`lobbies/${lobby.id}`, { matchId: await uploadMatch() });
    const { version } = (await findLobby(db(), lobby.id))!;
    await adminOk(`lobbies/${lobby.id}/verify`, { verified: true, version });
    const key = (await findLobby(db(), lobby.id))!.screenshotKey;

    const put = await putShot(lobby.id);
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ error: "verified" });
    expect((await host(`lobbies/${lobby.id}/screenshot`, { method: "DELETE" })).status).toBe(409);
    expect((await findLobby(db(), lobby.id))!.screenshotKey).toBe(key);
    expect((await hostLobbies()).lobbies[0]!.verified).toBe(true);

    await adminOk(`lobbies/${lobby.id}/verify`, { verified: false });
    expect((await host(`lobbies/${lobby.id}/screenshot`, { method: "DELETE" })).status).toBe(200);
  });

  it("refuses a cancelled tourney's lobby", async () => {
    const tourney = await newTourney(30);
    const lobby = await newLobby(tourney, { hostId: 1 });
    await adminOk(`tourneys/${tourney}`, { status: "cancelled" });
    expect((await putShot(lobby.id)).status).toBe(409);
  });

  it("rolls back a host write that lost a race with a reassignment or verification", async () => {
    const lobby = await newLobby(await newTourney(30), { hostId: 1 });
    const snapshot = (await findLobby(db(), lobby.id))!;
    await adminOk(`lobbies/${lobby.id}`, { hostId: 2 });
    const hostLog = { hostId: 1, action: "lobby_screenshot", at: new Date().toISOString() };
    await expect(setScreenshot(db(), snapshot, null, null, hostLog)).rejects.toSatisfy(isLobbyChanged);
    // Even at the current version, the guard checks the host and that it's unverified.
    const current = (await findLobby(db(), lobby.id))!;
    await expect(setScreenshot(db(), current, null, null, hostLog)).rejects.toSatisfy(isLobbyChanged);
    expect(await db().prepare("SELECT count(*) AS n FROM host_actions").first("n")).toBe(0);
  });
});
