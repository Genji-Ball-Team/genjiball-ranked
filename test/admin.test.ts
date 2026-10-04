import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { matchTransition, trustChange } from "../src/admin/plan";
import { isStale, setMatchState, setTournament } from "../src/admin/store";
import { defaults, loadConfig } from "../src/config";
import { createLogger } from "../src/log";
import { readState } from "../src/rating/store";
import { recomputeRatings } from "../src/rating/update";
import { sha256, type UploadResponse } from "../src/upload/handler";
import { expectUpToDate, historyTable, matchId, matchLog, ratingsTable } from "./helpers";

const db = () => env.DB;
const log = createLogger("error");
const adminToken = "admin-token";
const tokens = { trusted: "trusted-token", untrusted: "untrusted-token" };

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = ["admin_actions", "admins", "events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts"];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO admins (id, name, token_hash, revoked_at) VALUES (2, 'Gone', ?, '2026-01-01T00:00:00Z')").bind(await sha256("revoked-admin")),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust) VALUES (1, 'trusted', ?, 'trusted')").bind(await sha256(tokens.trusted)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust) VALUES (2, 'untrusted', ?, 'untrusted')").bind(await sha256(tokens.untrusted)),
  ]);
});

function admin(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
  const token = init.token === undefined ? adminToken : init.token;
  return SELF.fetch(`https://example.com/api/admin/${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function adminOk<T = Record<string, unknown>>(path: string, init: Parameters<typeof admin>[1] = {}): Promise<T> {
  const res = await admin(path, init);
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res.json();
}

async function upload(body: string, startedAt: string, token = tokens.trusted): Promise<UploadResponse> {
  const res = await SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, "X-Log-Started-At": startedAt },
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function actions() {
  const { results } = await db()
    .prepare("SELECT admin_id AS adminId, action, match_id AS matchId, host_id AS hostId, detail FROM admin_actions ORDER BY id")
    .all<{ adminId: number; action: string; matchId: number | null; hostId: number | null; detail: string | null }>();
  return results.map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
}

async function status(id: number) {
  return db().prepare("SELECT status, rejection_code AS code, rated_at AS ratedAt FROM matches WHERE id = ?").bind(id).first();
}

describe("admin: sign-in", () => {
  it("needs an admin token", async () => {
    expect((await admin("me", { token: null })).status).toBe(401);
    expect((await admin("me", { token: "nope" })).status).toBe(401);
    expect((await admin("me", { token: tokens.trusted })).status).toBe(401);
  });

  it("refuses a revoked admin token", async () => {
    expect((await admin("me", { token: "revoked-admin" })).status).toBe(401);
  });

  it("says who is signed in", async () => {
    expect(await adminOk("me")).toEqual({ admin: { id: 1, name: "Ada" } });
  });

  it("checks the token before the route", async () => {
    expect((await admin("nope", { token: null })).status).toBe(401);
    expect((await admin("nope")).status).toBe(404);
  });
});

describe("admin: hosts", () => {
  it("creates a host token, shown once and stored as its SHA-256", async () => {
    const res = await admin("hosts", { body: { name: "  New host  ", trust: "trusted" } });
    expect(res.status).toBe(201);
    const { host, token } = await res.json<{ host: { id: number; name: string; trust: string }; token: string }>();
    expect(host).toMatchObject({ name: "New host", trust: "trusted" });
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const stored = await db().prepare("SELECT token_hash AS hash FROM hosts WHERE id = ?").bind(host.id).first<{ hash: string }>();
    expect(stored!.hash).toBe(await sha256(token));
    expect(JSON.stringify(await adminOk("hosts"))).not.toContain(token);

    const uploaded = await upload(matchLog(), "2026-09-01T20:00:00Z", token);
    expect(uploaded.matches[0]).toMatchObject({ status: "accepted" });
    expect(await actions()).toEqual([{ adminId: 1, action: "host_create", matchId: null, hostId: host.id, detail: { name: "New host", trust: "trusted" } }]);
  });

  it("makes a new host untrusted by default", async () => {
    const { host } = await adminOk<{ host: { trust: string } }>("hosts", { body: { name: "Someone" } });
    expect(host.trust).toBe("untrusted");
  });

  it("checks what it's sent", async () => {
    expect((await admin("hosts", { body: {} })).status).toBe(400);
    expect((await admin("hosts", { body: { name: "x".repeat(201) } })).status).toBe(400);
    expect((await admin("hosts", { body: { name: "x", trust: "revoked" } })).status).toBe(400);
    expect((await admin("hosts", { method: "POST" })).status).toBe(400);
    const res = await SELF.fetch("https://example.com/api/admin/hosts", { method: "POST", body: "{", headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(400);
    expect(await actions()).toEqual([]);
  });

  it("sets trust, and logs the change", async () => {
    const { host } = await adminOk<{ host: { trust: string } }>("hosts/2/trust", { body: { trust: "trusted" } });
    expect(host.trust).toBe("trusted");
    expect((await upload(matchLog(), "2026-09-01T20:00:00Z", tokens.untrusted)).matches[0]).toMatchObject({ status: "accepted" });
    expect((await admin("hosts/2/trust", { body: { trust: "trusted" } })).status).toBe(409);
    expect(await actions()).toEqual([{ adminId: 1, action: "host_trust", matchId: null, hostId: 2, detail: { from: "untrusted", to: "trusted" } }]);
  });

  it("revokes a token for good", async () => {
    await adminOk("hosts/1/revoke", { method: "POST" });
    const res = await SELF.fetch("https://example.com/api/upload", { method: "POST", body: matchLog(), headers: { Authorization: `Bearer ${tokens.trusted}` } });
    expect(res.status).toBe(403);
    expect((await admin("hosts/1/trust", { body: { trust: "trusted" } })).status).toBe(409);
    expect((await admin("hosts/1/revoke", { method: "POST" })).status).toBe(409);
    expect((await actions()).map((a) => a.action)).toEqual(["host_revoke"]);
  });

  it("404s an unknown host", async () => {
    expect((await admin("hosts/99/revoke", { method: "POST" })).status).toBe(404);
  });
});

describe("admin: review queue", () => {
  it("lists matches in review with their reasons", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z", tokens.untrusted);
    const { matches } = await adminOk<{ matches: Record<string, unknown>[] }>("matches?status=review");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      matchKey: "000000000001",
      hostName: "untrusted",
      status: "review",
      reviewReasons: ["untrusted_host"],
      rejection: null,
      complete: true,
      rated: false,
      players: ["Alpha", "Bravo", "Charlie", "Delta"],
    });
    expect((await adminOk<{ matches: unknown[] }>("matches")).matches).toHaveLength(1);
    expect((await adminOk<{ matches: unknown[] }>("matches?status=accepted")).matches).toHaveLength(0);
    expect((await admin("matches?status=nope")).status).toBe(400);
  });

  it("accepting the newest match rates it now", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    await upload(matchLog({ key: "000000000002" }), "2026-09-02T20:00:00Z", tokens.untrusted);
    const id = await matchId("000000000002");

    const res = await adminOk<{ match: { status: string }; ratingsStale: boolean }>(`matches/${id}/accept`, { method: "POST" });
    expect(res).toMatchObject({ match: { status: "accepted" }, ratingsStale: false });
    expect((await status(id))!.ratedAt).not.toBeNull();
    await expectUpToDate();
    expect(await actions()).toEqual([{ adminId: 1, action: "match_accept", matchId: id, hostId: 2, detail: { from: "review", to: "accepted" } }]);
  });

  it("accepting a late match re-rates the later ones", async () => {
    await upload(matchLog({ key: "000000000002" }), "2026-09-01T20:00:00Z", tokens.untrusted);
    await upload(matchLog({ players: ["Bravo", "Alpha", "Charlie", "Delta"] }), "2026-09-02T20:00:00Z");
    const id = await matchId("000000000002");

    const res = await adminOk<{ ratingsStale: boolean }>(`matches/${id}/accept`, { method: "POST" });
    expect(res.ratingsStale).toBe(false);
    expect(await historyTable()).toHaveLength(8);
    await expectUpToDate();
  });

  it("rejecting keeps the match out, even when a longer copy arrives", async () => {
    await upload(matchLog({ rounds: 1, end: false }), "2026-09-01T20:00:00Z", tokens.untrusted);
    const id = await matchId("000000000001");
    await adminOk(`matches/${id}/reject`, { body: { reason: "Smurf lobby" } });
    expect(await status(id)).toMatchObject({ status: "rejected", code: "admin" });

    const longer = await upload(matchLog(), "2026-09-01T20:00:00Z", tokens.untrusted);
    expect(longer.matches[0]).toMatchObject({ action: "replace", status: "rejected", rejection: { code: "admin", message: "Smurf lobby" } });
    expect(await status(id)).toMatchObject({ status: "rejected", code: "admin" });
    expect(await ratingsTable()).toEqual([]);

    // An admin can still change their mind.
    await adminOk(`matches/${id}/accept`, { method: "POST" });
    expect(await status(id)).toMatchObject({ status: "accepted", code: null });
    await expectUpToDate();
    expect((await actions()).map((a) => [a.action, a.detail])).toEqual([
      ["match_reject", { from: "review", to: "rejected", reason: "Smurf lobby" }],
      ["match_accept", { from: "rejected", to: "accepted" }],
    ]);
  });

  it("refuses an action that doesn't fit the status", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    const id = await matchId("000000000001");
    expect((await admin(`matches/${id}/accept`, { method: "POST" })).status).toBe(409);
    expect((await admin(`matches/${id}/reject`, { method: "POST" })).status).toBe(409);
    expect((await admin(`matches/${id}/unvoid`, { method: "POST" })).status).toBe(409);
    expect((await admin("matches/999/void", { method: "POST" })).status).toBe(404);
    expect((await admin(`matches/${id}/explode`, { method: "POST" })).status).toBe(404);
    expect((await admin(`matches/${id}/void`)).status).toBe(405);
    expect(await actions()).toEqual([]);
  });
});

describe("admin: void", () => {
  async function threeMatches() {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    await upload(matchLog({ key: "000000000002", players: ["Bravo", "Alpha", "Echo", "Delta"] }), "2026-09-02T20:00:00Z");
    await upload(matchLog({ key: "000000000003" }), "2026-09-03T20:00:00Z");
    await expectUpToDate();
  }

  it("voids a rated match and recomputes the ratings straight away", async () => {
    await threeMatches();
    const id = await matchId("000000000002");
    const res = await adminOk<{ match: { status: string }; ratingsStale: boolean }>(`matches/${id}/void`, { body: { reason: "Bots" } });
    expect(res).toMatchObject({ match: { status: "void" }, ratingsStale: false });
    expect(await status(id)).toMatchObject({ status: "void", ratedAt: null });
    expect((await historyTable()).some((h) => h.matchId === id)).toBe(false);
    // Echo only played the voided match.
    expect(await ratingsTable()).toHaveLength(4);
    await expectUpToDate();
  });

  it("leaves a long tail to the cron", async () => {
    // What the worker runs with: RATING_MATCHES_PER_RUN in vitest.config.ts.
    const config = loadConfig(env);
    const count = config.ratingMatchesPerRun + 3;
    for (let i = 1; i <= count; i++) {
      await upload(matchLog({ key: String(i).padStart(12, "0") }), `2026-09-${String(i).padStart(2, "0")}T20:00:00Z`);
    }
    const res = await adminOk<{ ratingsStale: boolean }>(`matches/${await matchId("000000000001")}/void`, { method: "POST" });
    expect(res.ratingsStale).toBe(true);
    // The cron carries on.
    while (!(await recomputeRatings(db(), config, new Date(), log)).done);
    await expectUpToDate();
  });

  it("keeps a void through a longer copy, and un-voids", async () => {
    await upload(matchLog({ rounds: 1, end: false }), "2026-09-01T20:00:00Z");
    const id = await matchId("000000000001");
    await adminOk(`matches/${id}/void`, { method: "POST" });
    expect((await upload(matchLog(), "2026-09-01T20:00:00Z")).matches[0]).toMatchObject({ action: "replace", status: "void" });

    const res = await adminOk<{ match: { status: string }; ratingsStale: boolean }>(`matches/${id}/unvoid`, { method: "POST" });
    expect(res).toMatchObject({ match: { status: "accepted" }, ratingsStale: false });
    expect((await status(id))!.ratedAt).not.toBeNull();
    await expectUpToDate();
    expect((await actions()).map((a) => a.action)).toEqual(["match_void", "match_unvoid"]);
  });

  it("an un-voided match whose log was rejected meanwhile stays rejected", async () => {
    await upload(matchLog({ rounds: 1, end: false }), "2026-09-01T20:00:00Z");
    const id = await matchId("000000000001");
    await adminOk(`matches/${id}/void`, { method: "POST" });
    const unranked = matchLog().replace("JOIN|1.00|4|Delta", "JOIN|1.00|4|Delta\r\n[00:00:01] UNRANKED|1.00|BOT");
    expect((await upload(unranked, "2026-09-01T20:00:00Z")).matches[0]).toMatchObject({ status: "void" });

    const res = await adminOk<{ match: { status: string } }>(`matches/${id}/unvoid`, { method: "POST" });
    expect(res.match.status).toBe("rejected");
    expect(await ratingsTable()).toEqual([]);
  });

  it("refuses when another admin changed the match first", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    const id = await matchId("000000000001");
    // The guard: a status that changed after the read fails the whole batch.
    const write = setMatchState(db(), id, "review", { status: "accepted", rejection: null }, { adminId: 1, action: "match_accept", matchId: id, at: "2026-09-01T00:00:00Z" });
    await expect(write).rejects.toSatisfy(isStale);
    expect(await actions()).toEqual([]);
    expect((await readState(db())).staleFrom).toBeNull();
  });
});

describe("admin: tournaments", () => {
  it("marks a rated match as a tournament and re-rates it, so it counts more", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    await expectUpToDate();
    const id = await matchId("000000000001");
    const moved = async () => (await ratingsTable()).map((r) => Math.abs((r.display as number) - defaults.displayCenter));
    const normal = await moved();

    const res = await adminOk<{ match: { tournament: boolean }; ratingsStale: boolean }>(`matches/${id}/tournament`, { body: { tournament: true } });
    expect(res).toMatchObject({ match: { tournament: true }, ratingsStale: false });
    await expectUpToDate();
    const tourney = await moved();
    tourney.forEach((m, i) => expect(m).toBeGreaterThanOrEqual(normal[i]!));
    expect(Math.max(...tourney)).toBeGreaterThan(Math.max(...normal));
    expect((await actions()).at(-1)).toMatchObject({ action: "match_tournament", matchId: id, detail: { tournament: true } });

    await adminOk(`matches/${id}/tournament`, { body: { tournament: false } });
    await expectUpToDate();
    expect(await moved()).toEqual(normal);
  });

  it("checks what it's sent", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    const id = await matchId("000000000001");
    expect((await admin(`matches/${id}/tournament`, { body: {} })).status).toBe(400);
    expect((await admin(`matches/${id}/tournament`, { body: { tournament: false } })).status).toBe(409);
    expect((await admin(`matches/${id}/tournament`)).status).toBe(405);
    expect((await admin("matches/99999/tournament", { body: { tournament: true } })).status).toBe(404);
  });

  it("refuses when another admin changed the flag first", async () => {
    await upload(matchLog(), "2026-09-01T20:00:00Z");
    const id = await matchId("000000000001");
    expect(await adminOk(`matches/${id}`)).toMatchObject({ match: { tournament: false } });
    await adminOk(`matches/${id}/tournament`, { body: { tournament: true } });
    const before = await actions();
    // The guard: marking it again from a stale read fails the whole batch.
    const write = setTournament(db(), id, true, { adminId: 1, action: "match_tournament", matchId: id, at: "2026-09-01T00:00:00Z" });
    await expect(write).rejects.toSatisfy(isStale);
    expect(await actions()).toEqual(before);
  });
});

describe("admin: action log", () => {
  it("lists the newest actions first, with the admin's name", async () => {
    await adminOk("hosts/2/trust", { body: { trust: "trusted" } });
    await adminOk("hosts/1/revoke", { method: "POST" });
    const { actions: list } = await adminOk<{ actions: { admin: string; action: string; detail: unknown }[] }>("actions");
    expect(list.map((a) => [a.admin, a.action])).toEqual([
      ["Ada", "host_revoke"],
      ["Ada", "host_trust"],
    ]);
    expect(list[1]!.detail).toEqual({ from: "untrusted", to: "trusted" });
  });
});

describe("admin: rules", () => {
  const review = { status: "review" as const, rejection: null };
  it("decides which match actions are allowed", () => {
    expect(matchTransition("accept", review, null)).toEqual({ ok: true, to: { status: "accepted", rejection: null } });
    expect(matchTransition("reject", review, null)).toEqual({ ok: true, to: { status: "rejected", rejection: { code: "admin", message: "Rejected by an admin" } } });
    expect(matchTransition("accept", { status: "rejected", rejection: { code: "unranked", message: "" } }, null).ok).toBe(false);
    expect(matchTransition("void", review, null).ok).toBe(false);
    expect(matchTransition("unvoid", { status: "void", rejection: null }, null)).toEqual({ ok: true, to: { status: "accepted", rejection: null } });
  });

  it("never un-revokes a host", () => {
    expect(trustChange("revoked", "trusted")).not.toBeNull();
    expect(trustChange("trusted", "trusted")).not.toBeNull();
    expect(trustChange("untrusted", "revoked")).toBeNull();
  });
});

describe("admin page", () => {
  it("is served", async () => {
    const res = await SELF.fetch("https://example.com/admin.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Admin – Genji Ball Ranked</title>");
  });
});
