import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { createLogger } from "../src/log";
import { handleSignup } from "../src/tourney/signups";
import { sha256 } from "../src/upload/handler";
import { expectUpToDate, matchId, matchLog } from "./helpers";

/** Tourney sign-ups (#31), lobby capacity and the admin's clean-up (#24). */

const db = () => env.DB;
const adminToken = "admin-token";
const hostToken = "trusted-token";
const site = "https://example.com";

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = [
    "tourney_signups",
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
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'trusted', ?, 'trusted', 'eu')").bind(await sha256(hostToken)),
  ]);
});

function admin(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return SELF.fetch(`${site}/api/admin/${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

async function adminOk<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await admin(path, body);
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res.json();
}

async function newTourney(fields: Record<string, unknown> = {}) {
  const { tourney } = await adminOk<{ tourney: { id: number } }>("tourneys", {
    name: "October Cup",
    region: "eu",
    startsAt: "2026-10-10T19:00:00+02:00",
    ...fields,
  });
  return tourney.id;
}

async function newLobby(tourneyId: number, fields: Record<string, unknown> = {}) {
  const { lobby } = await adminOk<{ lobby: { id: number } }>(`tourneys/${tourneyId}/lobbies`, { label: "Lobby 1", ...fields });
  return lobby.id;
}

function signUp(tourneyId: number | string, name: unknown, { ip = "203.0.113.7", origin = site as string | null, raw = undefined as string | undefined } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  return SELF.fetch(`${site}/api/tourneys/${tourneyId}/signups`, { method: "POST", body: raw ?? JSON.stringify({ name }), headers });
}

interface Signups {
  open: boolean;
  count: number;
  full: boolean;
  names?: string[];
}
interface PublicTourney {
  id: number;
  capacity: number;
  signups: Signups;
  lobbies: { capacity: number }[];
}

async function publicTourney(id: number): Promise<PublicTourney> {
  const res = await SELF.fetch(`${site}/api/tourneys/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { tourney: PublicTourney }).tourney;
}

async function upcoming(): Promise<PublicTourney[]> {
  const res = await SELF.fetch(`${site}/api/tourneys?region=eu`);
  return ((await res.json()) as { upcoming: PublicTourney[] }).upcoming;
}

describe("signing up", () => {
  it("takes a name, counts it on both tourney routes, and lists it on the tourney's own", async () => {
    const id = await newTourney();
    await newLobby(id);
    const res = await signUp(id, "  Kenzo ");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ signup: { name: "Kenzo" }, created: true, capacity: 10, signups: { open: true, count: 1, full: false } });
    // A public write: never cached, no CORS.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();

    await signUp(id, "Tidal");
    const t = await publicTourney(id);
    expect(t.capacity).toBe(10);
    expect(t.lobbies[0]!.capacity).toBe(10);
    expect(t.signups).toEqual({ open: true, count: 2, full: false, names: ["Kenzo", "Tidal"] });
    const [listed] = await upcoming();
    // The list counts them, without the names.
    expect(listed!.signups).toEqual({ open: true, count: 2, full: false });
  });

  it("counts a name once per tourney, whatever its case and spaces", async () => {
    const id = await newTourney();
    expect((await signUp(id, "Kenzo")).status).toBe(201);
    const again = await signUp(id, " kENZO  ", { ip: "198.51.100.1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ signup: { name: "Kenzo" }, created: false, signups: { count: 1 } });
    // Another tourney is another sign-up.
    const other = await newTourney({ name: "November Cup" });
    expect((await signUp(other, "kenzo")).status).toBe(201);
    expect((await publicTourney(id)).signups.names).toEqual(["Kenzo"]);
  });

  it("refuses a missing, blank, too long or garbled name", async () => {
    const id = await newTourney();
    for (const name of [undefined, "", "   ", 42, "x".repeat(defaults.playerNameMaxLength + 1), "Ken\u0000zo"]) {
      const res = await signUp(id, name);
      expect(res.status, String(name)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
    expect((await signUp(id, null, { raw: "not json" })).status).toBe(400);
    expect((await signUp(id, null, { raw: JSON.stringify({ name: "x".repeat(defaults.tourneySignupBodyMaxBytes) }) })).status).toBe(400);
    // The limit is in characters, as for a display name.
    expect((await signUp(id, "\u{1D50A}".repeat(defaults.playerNameMaxLength))).status).toBe(201);
    expect((await publicTourney(id)).signups.count).toBe(1);
  });

  it("answers 404 for an unknown tourney, 405 for another method", async () => {
    expect((await signUp(999, "Kenzo")).status).toBe(404);
    expect((await signUp("nope", "Kenzo")).status).toBe(404);
    const get = await SELF.fetch(`${site}/api/tourneys/1/signups`);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
  });

  it("closes once the tourney leaves scheduled, but still answers a name that signed up", async () => {
    const id = await newTourney();
    await signUp(id, "Kenzo");
    for (const status of ["live", "done", "cancelled"]) {
      await adminOk(`tourneys/${id}`, { status });
      const res = await signUp(id, "Tidal");
      expect(res.status, status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "closed" });
      expect((await signUp(id, "kenzo")).status, status).toBe(200);
      expect((await publicTourney(id)).signups).toMatchObject({ open: false, count: 1 });
    }
  });

  it("is same-origin only", async () => {
    const id = await newTourney();
    const res = await signUp(id, "Kenzo", { origin: "https://elsewhere.example" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cross_origin" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await publicTourney(id)).signups.count).toBe(0);
    // No Origin (not a browser) is fine, as is the site's own.
    expect((await signUp(id, "Kenzo", { origin: null })).status).toBe(201);
    // The CORS preflight of the path allows only reads.
    const preflight = await SELF.fetch(`${site}/api/tourneys/${id}/signups`, { method: "OPTIONS", headers: { Origin: "https://elsewhere.example" } });
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD");
  });

  it("rate-limits stored sign-ups per IP an hour", async () => {
    const id = await newTourney();
    for (let i = 0; i < defaults.tourneySignupsPerHour; i++) {
      expect((await signUp(id, `Player ${i}`)).status).toBe(201);
    }
    // A name already signed up writes nothing, so it still answers.
    expect((await signUp(id, "Player 0")).status).toBe(200);
    const limited = await signUp(id, "One too many");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3600");
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    // Across tourneys too, but not for another IP.
    expect((await signUp(await newTourney({ name: "Other" }), "Kenzo")).status).toBe(429);
    expect((await signUp(id, "One too many", { ip: "198.51.100.1" })).status).toBe(201);
    // Only the hash of the IP is stored.
    const stored = await db().prepare("SELECT DISTINCT ip_hash FROM tourney_signups WHERE ip_hash = ?").bind(await sha256("203.0.113.7")).all();
    expect(stored.results).toHaveLength(1);
    expect(await db().prepare("SELECT count(*) AS n FROM tourney_signups WHERE ip_hash LIKE '%203.0%'").first("n")).toBe(0);
  });

  it("takes sign-ups past capacity and says full, up to tourneySignupsMax", async () => {
    const id = await newTourney();
    await newLobby(id, { capacity: 2 });
    const config = { ...defaults, tourneySignupsMax: 3 };
    const log = createLogger("error");
    const post = (name: string, ip = "203.0.113.7") =>
      handleSignup(new Request(`${site}/api/tourneys/${id}/signups`, { method: "POST", body: JSON.stringify({ name }), headers: { "CF-Connecting-IP": ip } }), db(), config, log);
    expect(await (await post("A")).json()).toMatchObject({ capacity: 2, signups: { count: 1, full: false } });
    expect(await (await post("B")).json()).toMatchObject({ signups: { count: 2, full: true } });
    const over = await post("C");
    expect(over.status).toBe(201);
    expect(await over.json()).toMatchObject({ signups: { count: 3, full: true } });
    const capped = await post("D", "198.51.100.1");
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({ error: "too_many" });
    expect((await publicTourney(id)).signups).toEqual({ open: true, count: 3, full: true, names: ["A", "B", "C"] });
  });

  it("isn't full without lobbies: there's no capacity yet", async () => {
    const id = await newTourney();
    await signUp(id, "Kenzo");
    expect(await publicTourney(id)).toMatchObject({ capacity: 0, signups: { count: 1, full: false } });
  });
});

describe("lobby capacity", () => {
  it("defaults to tourneyLobbyCapacity, can be set from 1 to the max, and sums up for the tourney", async () => {
    const id = await newTourney();
    const first = await newLobby(id);
    await newLobby(id, { label: "Lobby 2", capacity: 6 });
    const { tourneys } = await adminOk<{ tourneys: { id: number; capacity: number; signups: Signups; lobbies: { capacity: number; capacityDefault: boolean }[] }[] }>("tourneys");
    expect(tourneys[0]).toMatchObject({ capacity: defaults.tourneyLobbyCapacity + 6, signups: { count: 0, full: false } });
    expect(tourneys[0]!.lobbies.map((l) => [l.capacity, l.capacityDefault])).toEqual([[defaults.tourneyLobbyCapacity, true], [6, false]]);

    const { lobby } = await adminOk<{ lobby: { capacity: number; capacityDefault: boolean } }>(`lobbies/${first}`, { capacity: defaults.tourneyLobbyCapacityMax });
    expect(lobby).toMatchObject({ capacity: defaults.tourneyLobbyCapacityMax, capacityDefault: false });
    expect((await publicTourney(id)).capacity).toBe(defaults.tourneyLobbyCapacityMax + 6);
    expect((await adminOk<{ lobby: { capacity: number } }>(`lobbies/${first}`, { capacity: null })).lobby.capacity).toBe(defaults.tourneyLobbyCapacity);

    for (const capacity of [0, -1, 2.5, "10", defaults.tourneyLobbyCapacityMax + 1]) {
      expect((await admin(`lobbies/${first}`, { capacity })).status, String(capacity)).toBe(400);
    }
    const action = await db().prepare("SELECT detail FROM admin_actions WHERE action = 'lobby_edit' ORDER BY id DESC LIMIT 1").first<{ detail: string }>();
    expect(JSON.parse(action!.detail)).toMatchObject({ capacity: null });
  });
});

describe("admin: sign-ups", () => {
  interface AdminSignup {
    id: number;
    name: string;
    removedAt: string | null;
    removedBy: string | null;
  }

  it("lists every sign-up, removes one as the admin's (logged), and restores it", async () => {
    const id = await newTourney();
    await signUp(id, "Kenzo");
    await signUp(id, "Troll");
    const { signups } = await adminOk<{ signups: AdminSignup[] }>(`tourneys/${id}/signups`);
    expect(signups.map((s) => s.name)).toEqual(["Kenzo", "Troll"]);
    expect(signups[0]).not.toHaveProperty("ipHash");
    const troll = signups[1]!;

    const { signup } = await adminOk<{ signup: AdminSignup }>(`signups/${troll.id}`, { removed: true });
    expect(signup).toMatchObject({ name: "Troll", removedBy: "Ada" });
    expect(signup.removedAt).not.toBeNull();
    expect((await publicTourney(id)).signups).toMatchObject({ count: 1, names: ["Kenzo"] });
    // Still listed for admins, marked removed.
    expect((await adminOk<{ signups: AdminSignup[] }>(`tourneys/${id}/signups`)).signups[1]).toMatchObject({ name: "Troll", removedBy: "Ada" });
    // The name can't sign up again.
    const again = await signUp(id, "troll");
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "removed" });
    expect((await admin(`signups/${troll.id}`, { removed: true })).status).toBe(409);

    await adminOk(`signups/${troll.id}`, { removed: false });
    expect((await publicTourney(id)).signups.names).toEqual(["Kenzo", "Troll"]);

    const { results } = await db().prepare("SELECT action, detail FROM admin_actions WHERE action LIKE 'signup_%' ORDER BY id").all<{ action: string; detail: string }>();
    expect(results.map((r) => [r.action, JSON.parse(r.detail)])).toEqual([
      ["signup_remove", { tourney: id, signup: troll.id, name: "Troll" }],
      ["signup_restore", { tourney: id, signup: troll.id, name: "Troll" }],
    ]);
  });

  it("refuses a bad body, an unknown sign-up or tourney, and other methods", async () => {
    const id = await newTourney();
    await signUp(id, "Kenzo");
    const [{ id: signupId }] = (await adminOk<{ signups: AdminSignup[] }>(`tourneys/${id}/signups`)).signups as [AdminSignup];
    expect((await admin(`signups/${signupId}`, { removed: "yes" })).status).toBe(400);
    expect((await admin("signups/999", { removed: true })).status).toBe(404);
    expect((await admin("tourneys/999/signups")).status).toBe(404);
    expect((await admin(`signups/${signupId}`)).status).toBe(405);
    expect((await admin(`tourneys/${id}/signups`, {})).status).toBe(405);
  });
});

describe("admin: move a lobby's match back to ranked", () => {
  it("is unlinking: the match stops being a tournament, is rated as ranked, and the log names it", async () => {
    const id = await newTourney();
    const lobby = await newLobby(id);
    const res = await SELF.fetch(`${site}/api/upload`, {
      method: "POST",
      body: matchLog({ key: "000000000001" }),
      headers: { Authorization: `Bearer ${hostToken}`, "X-Log-Started-At": new Date(Date.now() - 2 * 3600000).toISOString() },
    });
    expect(res.status).toBe(200);
    const match = await matchId("000000000001");
    await adminOk(`lobbies/${lobby}`, { matchId: match });

    await adminOk(`lobbies/${lobby}`, { matchId: null });
    expect(await db().prepare("SELECT tournament FROM matches WHERE id = ?").bind(match).first("tournament")).toBe(0);
    await expectUpToDate();
    const action = await db()
      .prepare("SELECT match_id AS matchId, detail FROM admin_actions WHERE action = 'lobby_edit' ORDER BY id DESC LIMIT 1")
      .first<{ matchId: number; detail: string }>();
    expect(action!.matchId).toBe(match);
    expect(JSON.parse(action!.detail)).toMatchObject({ matchId: null, fromMatchId: match });
  });
});
