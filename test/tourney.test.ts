import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStale, setTournament, type ActionLog } from "../src/admin/store";
import { defaults } from "../src/config";
import { createLogger } from "../src/log";
import { handleSite } from "../src/site/handler";
import { expireOld, expireOverCaps, flushScreenshotDeletions } from "../src/tourney/expiry";
import { imageType, isScreenshotKey, screenshotKey } from "../src/tourney/screenshot";
import { standings } from "../src/tourney/standings";
import { deleteLobby, findLobby, isLobbyChanged, pendingScreenshots, queueScreenshot, setScreenshot, setVerified, stageScreenshot, tournamentStatement, updateLobby } from "../src/tourney/store";
import { sha256 } from "../src/upload/handler";
import { expectUpToDate, matchId, matchLog } from "./helpers";

const db = () => env.DB;
const adminToken = "admin-token";
const hostToken = "trusted-token";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

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
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust) VALUES (1, 'trusted', ?, 'trusted')").bind(await sha256(hostToken)),
  ]);
});

function admin(path: string, init: { method?: string; body?: unknown; raw?: BodyInit } = {}) {
  return SELF.fetch(`https://example.com/api/admin/${path}`, {
    method: init.method ?? (init.body === undefined && init.raw === undefined ? "GET" : "POST"),
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

async function adminOk<T = Record<string, unknown>>(path: string, init: Parameters<typeof admin>[1] = {}): Promise<T> {
  const res = await admin(path, init);
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res.json();
}

async function get<T = Record<string, unknown>>(path: string): Promise<T> {
  const res = await SELF.fetch(`https://example.com/api/${path}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function upload(key: string, hoursAgo: number) {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body: matchLog({ key }),
    headers: { Authorization: `Bearer ${hostToken}`, "X-Log-Started-At": new Date(Date.now() - hoursAgo * 3600000).toISOString() },
  });
  expect(res.status).toBe(200);
  return matchId(key);
}

async function newTourney(fields: Record<string, unknown> = {}) {
  const { tourney } = await adminOk<{ tourney: { id: number } }>("tourneys", {
    body: { name: "October Cup", startsAt: "2026-10-10T19:00:00+02:00", ...fields },
  });
  return tourney.id;
}

async function newLobby(tourneyId: number, label = "Lobby 1") {
  const { lobby } = await adminOk<{ lobby: { id: number } }>(`tourneys/${tourneyId}/lobbies`, { body: { label } });
  return lobby.id;
}

async function verifyLobby(id: number) {
  const lobby = (await findLobby(db(), id))!;
  return adminOk(`lobbies/${id}/verify`, { body: { verified: true, version: lobby.version } });
}

const actionLog = (): ActionLog => ({ adminId: 1, action: "test_mutation", at: new Date().toISOString() });

interface Lobby {
  id: number;
  label: string;
  matchId: number | null;
  screenshot: string | null;
  verified: boolean;
  standings: { place: number; name: string; wins: number; kills: number; ratingBefore: number | null; ratingAfter: number | null }[];
}
interface Tourney {
  id: number;
  name: string;
  startsAt: string;
  status: string;
  lobbies: Lobby[];
}

describe("standings", () => {
  const players = [
    { logId: 1, playerId: 10, name: "Alpha", ratingBefore: 1000, ratingAfter: 1040 },
    { logId: 2, playerId: 20, name: "Bravo", ratingBefore: null, ratingAfter: 990 },
    { logId: 3, playerId: 30, name: "Charlie", ratingBefore: null, ratingAfter: null },
    // Alpha rejoined: a second log id for the same player.
    { logId: 4, playerId: 10, name: "Alpha", ratingBefore: 1000, ratingAfter: 1040 },
  ];

  it("ranks by rounds won, then kills, and counts a rejoined player once", () => {
    const result = standings(
      players,
      [
        { logId: 1, n: 2 },
        { logId: 4, n: 1 },
        { logId: 2, n: 3 },
      ],
      [
        { logId: 2, n: 5 },
        { logId: 1, n: 4 },
        { logId: 4, n: 3 },
      ],
    );
    expect(result).toEqual([
      { place: 1, id: 10, name: "Alpha", wins: 3, kills: 7, ratingBefore: 1000, ratingAfter: 1040 },
      { place: 2, id: 20, name: "Bravo", wins: 3, kills: 5, ratingBefore: null, ratingAfter: 990 },
      { place: 3, id: 30, name: "Charlie", wins: 0, kills: 0, ratingBefore: null, ratingAfter: null },
    ]);
  });

  it("gives players with the same wins and kills the same place", () => {
    const result = standings(players.slice(0, 3), [{ logId: 1, n: 1 }, { logId: 2, n: 1 }], []);
    expect(result.map((s) => [s.name, s.place])).toEqual([
      ["Alpha", 1],
      ["Bravo", 1],
      ["Charlie", 3],
    ]);
  });
});

describe("screenshots", () => {
  it("knows PNG, JPEG and WebP by their first bytes, whatever made them", () => {
    expect(imageType(png)).toBe("image/png");
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe("image/jpeg");
    expect(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(imageType(new TextEncoder().encode("<svg xmlns=..."))).toBeNull();
    expect(imageType(new Uint8Array())).toBeNull();
  });

  it("makes keys that only it would", () => {
    const key = screenshotKey(12, "image/png");
    expect(isScreenshotKey(key)).toBe(true);
    expect(screenshotKey(12, "image/png")).not.toBe(key);
    expect(isScreenshotKey("../secret")).toBe(false);
    expect(isScreenshotKey("lobby-1-zz.png")).toBe(false);
  });
});

describe("admin: tourneys", () => {
  it("schedules a tourney in UTC and edits it", async () => {
    const id = await newTourney({ notes: "Bring a friend" });
    const { tourneys } = await adminOk<{ tourneys: Tourney[] }>("tourneys");
    expect(tourneys).toEqual([{ id, name: "October Cup", startsAt: "2026-10-10T17:00:00Z", status: "scheduled", notes: "Bring a friend", lobbies: [] }]);

    await adminOk(`tourneys/${id}`, { body: { status: "live" } });
    expect((await adminOk<{ tourneys: Tourney[] }>("tourneys")).tourneys[0]).toMatchObject({ name: "October Cup", status: "live" });

    const { results } = await db().prepare("SELECT action, detail FROM admin_actions ORDER BY id").all<{ action: string; detail: string }>();
    expect(results.map((r) => [r.action, JSON.parse(r.detail)])).toEqual([
      ["tourney_create", { name: "October Cup", startsAt: "2026-10-10T17:00:00Z", tourney: id }],
      ["tourney_edit", { tourney: id, status: { from: "scheduled", to: "live" } }],
    ]);
  });

  it("refuses bad fields", async () => {
    expect((await admin("tourneys", { body: { startsAt: "2026-10-10T19:00:00Z" } })).status).toBe(400);
    expect((await admin("tourneys", { body: { name: "Cup", startsAt: "2026-10-10T19:00" } })).status).toBe(400);
    expect((await admin("tourneys", { body: { name: "Cup", startsAt: "next friday" } })).status).toBe(400);
    expect((await admin("tourneys", { body: { name: "Cup", startsAt: "2026-10-10T19:00:00Z", status: "maybe" } })).status).toBe(400);
    expect((await admin("tourneys/999", { body: { status: "done" } })).status).toBe(404);
    expect((await admin("tourneys/999/lobbies", { body: { label: "Lobby 1" } })).status).toBe(404);
    expect((await admin("lobbies/999", { body: { label: "x" } })).status).toBe(404);
    expect((await admin("tourneys", { method: "DELETE" })).status).toBe(405);
  });

  it("makes a lobby's match a tournament and re-rates it, and unlinking undoes it", async () => {
    const tourney = await newTourney();
    const lobby = await newLobby(tourney);
    const id = await upload("000000000001", 2);
    await expectUpToDate();

    const res = await adminOk<{ lobby: { matchId: number }; ratingsStale: boolean }>(`lobbies/${lobby}`, { body: { matchId: id } });
    expect(res).toMatchObject({ lobby: { matchId: id }, ratingsStale: false });
    expect(await db().prepare("SELECT tournament FROM matches WHERE id = ?").bind(id).first("tournament")).toBe(1);
    await expectUpToDate();

    await adminOk(`lobbies/${lobby}`, { body: { matchId: null } });
    expect(await db().prepare("SELECT tournament FROM matches WHERE id = ?").bind(id).first("tournament")).toBe(0);
    await expectUpToDate();
  });

  it("keeps a match in one lobby", async () => {
    const tourney = await newTourney();
    const [one, two] = [await newLobby(tourney, "Lobby 1"), await newLobby(tourney, "Lobby 2")];
    const id = await upload("000000000001", 2);
    await adminOk(`lobbies/${one}`, { body: { matchId: id } });
    expect((await admin(`lobbies/${two}`, { body: { matchId: id } })).status).toBe(409);
    expect((await admin(`lobbies/${two}`, { body: { matchId: 99999 } })).status).toBe(404);
    expect((await admin(`lobbies/${two}`, { body: { matchId: "1" } })).status).toBe(400);
  });

  it("stores a screenshot in R2, replaces it, and needs verifying again", async () => {
    const tourney = await newTourney();
    const lobby = await newLobby(tourney);
    const id = await upload("000000000001", 2);

    expect((await admin(`lobbies/${lobby}/verify`, { body: { verified: true } })).status).toBe(409);
    expect((await admin(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: "<svg/>" })).status).toBe(415);
    expect((await admin(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: new Uint8Array(defaults.screenshotMaxBytes + 1) })).status).toBe(413);

    const first = await adminOk<{ lobby: { screenshotKey: string } }>(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: png });
    const key = first.lobby.screenshotKey;
    expect(await env.PROOFS.head(key)).not.toBeNull();
    const image = await SELF.fetch(`https://example.com/api/screenshots/${key}`);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);

    await adminOk(`lobbies/${lobby}`, { body: { matchId: id } });
    await verifyLobby(lobby);
    expect((await admin(`lobbies/${lobby}/verify`, { body: { verified: true } })).status).toBe(409);
    expect((await get<{ tourney: Tourney }>(`tourneys/${tourney}`)).tourney.lobbies[0]!.verified).toBe(true);

    const second = await adminOk<{ lobby: { screenshotKey: string; verifiedAt: string | null } }>(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: png });
    expect(second.lobby.screenshotKey).not.toBe(key);
    expect(second.lobby.verifiedAt).toBeNull();
    expect(await env.PROOFS.head(key)).toBeNull();
    expect((await SELF.fetch(`https://example.com/api/screenshots/${key}`)).status).toBe(404);

    await adminOk(`lobbies/${lobby}`, { method: "DELETE" });
    expect(await env.PROOFS.head(second.lobby.screenshotKey)).toBeNull();
    expect(await db().prepare("SELECT tournament FROM matches WHERE id = ?").bind(id).first("tournament")).toBe(0);
  });
});

describe("screenshot expiry", () => {
  const log = createLogger("error");

  /** A lobby with a stored screenshot of `bytes`, taken at `at`. Returns its key. */
  async function stored(tourney: number, label: string, at: string, bytes = png.length): Promise<string> {
    const lobby = await newLobby(tourney, label);
    const key = screenshotKey(lobby, "image/png");
    await env.PROOFS.put(key, png);
    await db().prepare("UPDATE tourney_lobbies SET screenshot_key = ?2, screenshot_at = ?3, screenshot_bytes = ?4 WHERE id = ?1").bind(lobby, key, at, bytes).run();
    return key;
  }

  const lobbyOf = (key: string) =>
    db().prepare("SELECT screenshot_key AS key, screenshot_expired_at AS expiredAt FROM tourney_lobbies WHERE id = ?").bind(Number(key.split("-")[1])).first();

  it("deletes the oldest past screenshotsKept, from R2 and the lobby", async () => {
    const t = await newTourney();
    const keys = [await stored(t, "A", "2026-09-01T00:00:00Z"), await stored(t, "B", "2026-09-02T00:00:00Z"), await stored(t, "C", "2026-09-03T00:00:00Z")];
    const now = new Date("2026-10-01T00:00:00Z");
    expect(await expireOverCaps(db(), env.PROOFS, { ...defaults, screenshotsKept: 2 }, now, log)).toEqual([keys[0]]);
    expect(await env.PROOFS.head(keys[0]!)).toBeNull();
    expect(await env.PROOFS.head(keys[1]!)).not.toBeNull();
    expect(await lobbyOf(keys[0]!)).toEqual({ key: null, expiredAt: "2026-10-01T00:00:00Z" });
    expect(await lobbyOf(keys[2]!)).toEqual({ key: keys[2], expiredAt: null });
  });

  it("deletes the oldest past screenshotStorageMaxBytes, counted from the newest", async () => {
    const t = await newTourney();
    const old = await stored(t, "A", "2026-09-01T00:00:00Z", 600);
    const mid = await stored(t, "B", "2026-09-02T00:00:00Z", 300);
    const recent = await stored(t, "C", "2026-09-03T00:00:00Z", 600);
    const config = { ...defaults, screenshotStorageMaxBytes: 1000 };
    expect(await expireOverCaps(db(), env.PROOFS, config, new Date(), log)).toEqual([old]);
    expect((await lobbyOf(mid))!.key).toBe(mid);
    expect((await lobbyOf(recent))!.key).toBe(recent);
  });

  it("deletes screenshots past screenshotKeepDays on the cron, and nothing when it's 0", async () => {
    const t = await newTourney();
    const old = await stored(t, "A", "2026-08-01T00:00:00Z");
    const recent = await stored(t, "B", "2026-09-25T00:00:00Z");
    const now = new Date("2026-10-01T00:00:00Z");
    expect(await expireOld(db(), env.PROOFS, defaults, now, log)).toEqual([]);
    expect(await expireOld(db(), env.PROOFS, { ...defaults, screenshotKeepDays: 30 }, now, log)).toEqual([old]);
    expect((await lobbyOf(recent))!.key).toBe(recent);
  });

  it("keeps the result and verified mark, and the site says the screenshot is gone", async () => {
    const tourney = await newTourney({ status: "done" });
    const lobby = await newLobby(tourney);
    const id = await upload("000000000001", 2);
    await adminOk(`lobbies/${lobby}`, { body: { matchId: id } });
    const { lobby: l } = await adminOk<{ lobby: { screenshotKey: string } }>(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: png });
    await verifyLobby(lobby);
    await expireOverCaps(db(), env.PROOFS, { ...defaults, screenshotsKept: 0 }, new Date(), log);

    const { tourney: t } = await get<{ tourney: Tourney }>(`tourneys/${tourney}`);
    expect(t.lobbies[0]).toMatchObject({ screenshot: null, screenshotExpired: true, verified: true, matchId: id });
    expect(t.lobbies[0]!.standings).toHaveLength(4);
    expect((await SELF.fetch(`https://example.com/api/screenshots/${l.screenshotKey}`)).status).toBe(404);
  });

  it("applies the caps after an upload", async () => {
    const t = await newTourney();
    // More than screenshotStorageMaxBytes on record: the upload pushes it out.
    const huge = await stored(t, "Old", "2026-01-01T00:00:00Z", defaults.screenshotStorageMaxBytes);
    const lobby = await newLobby(t, "New");
    const res = await adminOk<{ expired: number }>(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: png });
    expect(res.expired).toBe(1);
    expect((await lobbyOf(huge))!.key).toBeNull();
  });

  it("retries failed R2 deletes on the cron even when age expiry is off", async () => {
    const t = await newTourney();
    const key = await stored(t, "A", "2026-09-01T00:00:00Z");
    const failingProofs = { delete: vi.fn().mockRejectedValue(new Error("R2 unavailable")) } as unknown as R2Bucket;
    await expireOverCaps(db(), failingProofs, { ...defaults, screenshotsKept: 0 }, new Date(), log);
    expect((await lobbyOf(key))!.key).toBeNull();
    expect(await env.PROOFS.head(key)).not.toBeNull();
    expect(await db().prepare("SELECT bytes FROM screenshot_deletions WHERE key = ?").bind(key).first("bytes")).toBe(png.length);
    expect((await SELF.fetch(`https://example.com/api/screenshots/${key}`)).status).toBe(404);

    await expireOld(db(), env.PROOFS, defaults, new Date(), log);
    expect(await env.PROOFS.head(key)).toBeNull();
    expect(await db().prepare("SELECT key FROM screenshot_deletions").first()).toBeNull();
  });

  it("keeps replaced screenshots queued until R2 cleanup succeeds", async () => {
    const t = await newTourney();
    const key = await stored(t, "A", "2026-09-01T00:00:00Z");
    const lobby = (await findLobby(db(), Number(key.split("-")[1])))!;
    const next = screenshotKey(lobby.id, "image/png");
    expect(await stageScreenshot(db(), next, png.length, new Date(), defaults)).toBe(true);
    await env.PROOFS.put(next, png);
    await setScreenshot(db(), lobby, next, png.length, actionLog());
    const failingProofs = { delete: vi.fn().mockRejectedValue(new Error("R2 unavailable")) } as unknown as R2Bucket;
    await flushScreenshotDeletions(db(), failingProofs, defaults, log);
    expect(await env.PROOFS.head(key)).not.toBeNull();
    expect(await db().prepare("SELECT key FROM screenshot_deletions WHERE key = ?").bind(key).first()).not.toBeNull();
    expect((await findLobby(db(), lobby.id))!.screenshotKey).toBe(next);

    await flushScreenshotDeletions(db(), env.PROOFS, defaults, log);
    expect(await env.PROOFS.head(key)).toBeNull();
    expect(await env.PROOFS.head(next)).not.toBeNull();
  });
});

describe("tourney mutation integrity", () => {
  it("rolls back stale relinks and deletes with their dependent tournament changes", async () => {
    const lobby = await newLobby(await newTourney());
    const [first, winner, loser] = [await upload("000000000001", 4), await upload("000000000002", 3), await upload("000000000003", 2)];
    await adminOk(`lobbies/${lobby}`, { body: { matchId: first } });
    const snapshot = (await findLobby(db(), lobby))!;
    await adminOk(`lobbies/${lobby}`, { body: { matchId: winner } });
    const actions = await db().prepare("SELECT count(*) AS n FROM admin_actions").first("n");
    const dependent = [tournamentStatement(db(), [loser], true), tournamentStatement(db(), [first], false)];
    await expect(updateLobby(db(), snapshot, snapshot.label, loser, actionLog(), dependent)).rejects.toSatisfy(isLobbyChanged);
    await expect(deleteLobby(db(), snapshot, actionLog(), [tournamentStatement(db(), [winner], false)])).rejects.toSatisfy(isLobbyChanged);
    expect((await findLobby(db(), lobby))!.matchId).toBe(winner);
    const { results } = await db().prepare("SELECT id, tournament FROM matches ORDER BY id").all();
    expect(results).toEqual([{ id: first, tournament: 0 }, { id: winner, tournament: 1 }, { id: loser, tournament: 0 }]);
    expect(await db().prepare("SELECT count(*) AS n FROM admin_actions").first("n")).toBe(actions);
    await expectUpToDate();
  });

  it("rejects stale verification and screenshot writes after a replacement", async () => {
    const lobby = await newLobby(await newTourney());
    const match = await upload("000000000001", 2);
    await adminOk(`lobbies/${lobby}`, { body: { matchId: match } });
    await adminOk(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: png });
    const snapshot = (await findLobby(db(), lobby))!;
    await adminOk(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: png });
    const winner = (await findLobby(db(), lobby))!;
    await expect(setVerified(db(), snapshot, true, actionLog())).rejects.toSatisfy(isLobbyChanged);
    await expect(setScreenshot(db(), snapshot, null, null, actionLog())).rejects.toSatisfy(isLobbyChanged);
    expect((await admin(`lobbies/${lobby}/verify`, { body: { verified: true, version: snapshot.version } })).status).toBe(409);
    expect((await admin(`lobbies/${lobby}/verify`, { body: { verified: true } })).status).toBe(409);
    expect((await findLobby(db(), lobby))!.verifiedAt).toBeNull();
    expect((await findLobby(db(), lobby))!.screenshotKey).toBe(winner.screenshotKey);
    await verifyLobby(lobby);
    expect((await findLobby(db(), lobby))!.verifiedAt).not.toBeNull();
  });

  it("clears verification when a longer log changes a linked match at the same id", async () => {
    const startedAt = new Date(Date.now() - 2 * 3600000).toISOString();
    const send = (body: string) => SELF.fetch("https://example.com/api/upload", {
      method: "POST", body, headers: { Authorization: `Bearer ${hostToken}`, "X-Log-Started-At": startedAt },
    });
    expect((await send(matchLog({ rounds: 1, end: false }))).status).toBe(200);
    const match = await matchId("000000000001");
    const lobby = await newLobby(await newTourney());
    await adminOk(`lobbies/${lobby}`, { body: { matchId: match } });
    await adminOk(`lobbies/${lobby}/screenshot`, { method: "PUT", raw: png });
    await verifyLobby(lobby);
    const before = (await findLobby(db(), lobby))!;
    expect((await send(matchLog())).status).toBe(200);
    const after = (await findLobby(db(), lobby))!;
    expect(after).toMatchObject({ matchId: match, screenshotKey: before.screenshotKey, verifiedAt: null, verifiedBy: null });
    expect(after.version).toBeGreaterThan(before.version);
    expect((await admin(`lobbies/${lobby}/verify`, { body: { verified: true, version: before.version } })).status).toBe(409);
    await expect(setVerified(db(), before, true, actionLog())).rejects.toSatisfy(isLobbyChanged);
    await expectUpToDate();
  });

  it("keeps linked matches tournament weighted through the manual endpoint", async () => {
    const match = await upload("000000000001", 2);
    const lobby = await newLobby(await newTourney());
    await adminOk(`lobbies/${lobby}`, { body: { matchId: match } });
    expect((await admin(`matches/${match}/tournament`, { body: { tournament: false } })).status).toBe(409);
    // The transactional guard also catches a link committed after the manual endpoint's read.
    await expect(setTournament(db(), match, false, actionLog())).rejects.toSatisfy(isStale);
    expect(await db().prepare("SELECT tournament FROM matches WHERE id = ?").bind(match).first("tournament")).toBe(1);
    await expectUpToDate();
  });

  it("protects an in-flight screenshot reservation until it attaches", async () => {
    const lobby = (await findLobby(db(), await newLobby(await newTourney())))!;
    const key = screenshotKey(lobby.id, "image/png");
    const now = new Date();
    expect(await stageScreenshot(db(), key, png.length, now, defaults)).toBe(true);
    await env.PROOFS.put(key, png);
    const log = createLogger("error");
    await flushScreenshotDeletions(db(), env.PROOFS, defaults, log, now);
    expect(await env.PROOFS.head(key)).not.toBeNull();
    await setScreenshot(db(), lobby, key, png.length, actionLog());
    expect(await db().prepare("SELECT key FROM screenshot_deletions WHERE key = ?").bind(key).first()).toBeNull();
    await flushScreenshotDeletions(db(), env.PROOFS, defaults, log, new Date(now.getTime() + defaults.screenshotUploadGraceSeconds * 1000 + 1000));
    expect(await env.PROOFS.head(key)).not.toBeNull();
    expect((await findLobby(db(), lobby.id))!.screenshotKey).toBe(key);
  });

  it("refuses late attachment after cleanup can select the staged key", async () => {
    const lobby = (await findLobby(db(), await newLobby(await newTourney())))!;
    const key = screenshotKey(lobby.id, "image/png");
    const beforeGrace = new Date(Date.now() - defaults.screenshotUploadGraceSeconds * 1000 - 1000);
    expect(await stageScreenshot(db(), key, png.length, beforeGrace, defaults)).toBe(true);
    await env.PROOFS.put(key, png);
    expect(await pendingScreenshots(db(), defaults.screenshotExpiryBatch, new Date().toISOString())).toContain(key);
    await expect(setScreenshot(db(), lobby, key, png.length, actionLog())).rejects.toSatisfy(isLobbyChanged);
    expect((await findLobby(db(), lobby.id))!.screenshotKey).toBeNull();
    expect(await db().prepare("SELECT key FROM screenshot_deletions WHERE key = ?").bind(key).first()).not.toBeNull();
    await flushScreenshotDeletions(db(), env.PROOFS, defaults, createLogger("error"));
    expect(await env.PROOFS.head(key)).toBeNull();
  });

  it("stops storage growth at the caps while pending cleanup fails", async () => {
    const lobby = await newLobby(await newTourney());
    const pending = screenshotKey(lobby, "image/png");
    await env.PROOFS.put(pending, png);
    await queueScreenshot(db(), pending, png.length, new Date().toISOString());
    const next = screenshotKey(lobby, "image/png");
    expect(await stageScreenshot(db(), next, png.length, new Date(), { ...defaults, screenshotStorageMaxBytes: png.length })).toBe(false);
    expect(await stageScreenshot(db(), next, png.length, new Date(), { ...defaults, screenshotsKept: 1 })).toBe(false);
    expect(await db().prepare("SELECT key FROM screenshot_deletions WHERE key = ?").bind(next).first()).toBeNull();
    await flushScreenshotDeletions(db(), env.PROOFS, defaults, createLogger("error"));
    expect(await stageScreenshot(db(), next, png.length, new Date(), { ...defaults, screenshotsKept: 1 })).toBe(true);
    // A failed attachment can shorten the staging grace so cleanup retries immediately.
    await queueScreenshot(db(), next, png.length, new Date().toISOString());
    expect(await pendingScreenshots(db(), defaults.screenshotExpiryBatch, new Date().toISOString())).toContain(next);
  });
});

describe("site: tourneys", () => {
  it("lists upcoming tourneys soonest first, and past ones with each lobby's standings", async () => {
    const later = await newTourney({ name: "Later", startsAt: "2026-12-01T19:00:00Z" });
    const sooner = await newTourney({ name: "Sooner", startsAt: "2026-11-01T19:00:00Z" });
    const past = await newTourney({ name: "September Cup", startsAt: "2026-09-01T19:00:00Z", status: "done" });
    const lobby = await newLobby(past);
    await newLobby(past, "Lobby 2");
    const id = await upload("000000000001", 2);
    await adminOk(`lobbies/${lobby}`, { body: { matchId: id } });

    const d = await get<{ upcoming: Tourney[]; past: Tourney[]; hasMore: boolean }>("tourneys");
    expect(d.upcoming.map((t) => t.id)).toEqual([sooner, later]);
    expect(d.past.map((t) => t.id)).toEqual([past]);
    expect(d.hasMore).toBe(false);
    const [first, second] = d.past[0]!.lobbies;
    expect(first).toMatchObject({ label: "Lobby 1", matchId: id, screenshot: null, verified: false });
    // matchLog: Alpha wins round 1, Bravo round 2; no KILL lines.
    expect(first!.standings.map((s) => [s.place, s.name, s.wins, s.kills])).toEqual([
      [1, "Alpha", 1, 0],
      [1, "Bravo", 1, 0],
      [3, "Charlie", 0, 0],
      [3, "Delta", 0, 0],
    ]);
    expect(first!.standings.every((s) => s.ratingAfter !== null && s.ratingBefore === null)).toBe(true);
    expect(second).toMatchObject({ label: "Lobby 2", matchId: null, standings: [] });
  });

  it("pages past tourneys", async () => {
    for (let day = 1; day <= 3; day++) await newTourney({ name: `Cup ${day}`, startsAt: `2026-09-0${day}T19:00:00Z`, status: "done" });
    const config = { ...defaults, tourneysPageSize: 2 };
    const page = async (n: number) => (await (await handleSite(new Request(`https://example.com/api/tourneys?page=${n}`), db(), config))!.json()) as {
      past: Tourney[];
      hasMore: boolean;
    };
    expect((await page(1)).past.map((t) => t.name)).toEqual(["Cup 3", "Cup 2"]);
    expect((await page(1)).hasMore).toBe(true);
    expect((await page(2)).past.map((t) => t.name)).toEqual(["Cup 1"]);
    expect((await page(2)).hasMore).toBe(false);
  });

  it("doesn't show a lobby's match while it's in review", async () => {
    const tourney = await newTourney({ status: "done" });
    const lobby = await newLobby(tourney);
    const id = await upload("000000000001", 2);
    await adminOk(`lobbies/${lobby}`, { body: { matchId: id } });
    await db().prepare("UPDATE matches SET status = 'review' WHERE id = ?").bind(id).run();
    const { tourney: t } = await get<{ tourney: Tourney }>(`tourneys/${tourney}`);
    expect(t.lobbies[0]).toMatchObject({ matchId: null, standings: [] });
  });

  it("tags tourney matches on the match and player pages, and keeps one leaderboard", async () => {
    const tourney = await newTourney({ status: "done" });
    const lobby = await newLobby(tourney);
    const ranked = await upload("000000000001", 3);
    const cup = await upload("000000000002", 2);
    await adminOk(`lobbies/${lobby}`, { body: { matchId: cup } });

    expect((await get<{ match: Record<string, unknown> }>(`matches/${cup}`)).match).toMatchObject({
      tournament: true,
      tourney: { id: tourney, name: "October Cup", lobby: "Lobby 1" },
    });
    expect((await get<{ match: Record<string, unknown> }>(`matches/${ranked}`)).match).toMatchObject({ tournament: false, tourney: null });

    const alpha = await db().prepare("SELECT id FROM players WHERE name = 'Alpha'").first<number>("id");
    const { matches } = await get<{ matches: { id: number; tournament: boolean; tourney: unknown }[] }>(`players/${alpha}`);
    expect(matches.map((m) => [m.id, m.tournament, m.tourney !== null])).toEqual([
      [cup, true, true],
      [ranked, false, false],
    ]);

    const boards = await db().prepare("SELECT DISTINCT board FROM ratings").all<{ board: string }>();
    expect(boards.results).toEqual([{ board: "ranked" }]);
  });

  it("answers 404 for an unknown tourney or screenshot", async () => {
    expect((await SELF.fetch("https://example.com/api/tourneys/999")).status).toBe(404);
    expect((await SELF.fetch("https://example.com/api/screenshots/lobby-1-0000000000000000.png")).status).toBe(404);
    expect((await SELF.fetch("https://example.com/api/screenshots/nope")).status).toBe(404);
  });

  it("serves the Tourneys pages", async () => {
    expect(await (await SELF.fetch("https://example.com/tourneys")).text()).toContain('data-page="tourneys"');
    expect(await (await SELF.fetch("https://example.com/tourney?id=1")).text()).toContain('data-page="tourney"');
  });
});
