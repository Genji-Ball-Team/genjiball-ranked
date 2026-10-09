import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { sha256 } from "../src/upload/handler";

/** The Discord bot's tourney sign-ups (`/api/bot/tourneys/:id/signups`): one list with the page's. */

const db = () => env.DB;
const adminToken = "admin-token";
const botToken = "bot-token";
const site = "https://example.com";
const kenzo = "100000000000000001";
const tidal = "100000000000000002";

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  await db().batch([
    ...["tourney_signups", "tourney_lobbies", "tourneys", "admin_actions", "admins"].map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
  ]);
});

async function adminOk<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await SELF.fetch(`${site}/api/admin/${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res.json();
}

async function newTourney() {
  const { tourney } = await adminOk<{ tourney: { id: number } }>("tourneys", { name: "October Cup", region: "eu", startsAt: "2026-10-10T19:00:00Z" });
  await adminOk(`tourneys/${tourney.id}/lobbies`, { label: "Lobby 1", capacity: 2 });
  return tourney.id;
}

function bot(path: string, { method = "GET", body = undefined as unknown, token = botToken } = {}) {
  return SELF.fetch(`${site}/api/bot/tourneys/${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}` },
  });
}

interface Result {
  discordUserId: string;
  status: string;
  signup: { name: string; signedUpAt: string } | null;
}
interface Registered {
  results: Result[];
  capacity: number;
  signups: { open: boolean; count: number; full: boolean };
}

async function register(id: number, signups: { discordUserId: string; name: string }[]): Promise<Registered> {
  const res = await bot(`${id}/signups`, { method: "POST", body: { signups } });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res.json();
}

const statuses = (r: Registered) => r.results.map((x) => x.status);

function pageSignUp(id: number, name: string) {
  return SELF.fetch(`${site}/api/tourneys/${id}/signups`, {
    method: "POST",
    body: JSON.stringify({ name }),
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
  });
}

async function pageNames(id: number): Promise<string[]> {
  const res = await SELF.fetch(`${site}/api/tourneys/${id}`);
  return ((await res.json()) as { tourney: { signups: { names: string[] } } }).tourney.signups.names;
}

describe("the bot's sign-ups", () => {
  it("needs the bot token, and is private", async () => {
    const id = await newTourney();
    expect((await bot(`${id}/signups`, { token: "wrong" })).status).toBe(401);
    expect((await SELF.fetch(`${site}/api/bot/tourneys/${id}/signups`)).status).toBe(401);
    const ok = await bot(`${id}/signups`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("signs Discord users up onto the page's list, past capacity too", async () => {
    const id = await newTourney();
    expect((await pageSignUp(id, "Ada")).status).toBe(201);
    const res = await register(id, [
      { discordUserId: kenzo, name: "Kenzo" },
      { discordUserId: tidal, name: "Tidal" },
    ]);
    expect(statuses(res)).toEqual(["created", "created"]);
    expect(res.results[0]!.signup).toMatchObject({ name: "Kenzo" });
    // 3 sign-ups for a capacity of 2: taken, and full.
    expect(res.signups).toEqual({ open: true, count: 3, full: true });
    expect(await pageNames(id)).toEqual(["Ada", "Kenzo", "Tidal"]);

    const list = (await (await bot(`${id}/signups`)).json()) as { entries: { name: string; discordUserId: string | null }[] };
    expect(list.entries.map((e) => [e.name, e.discordUserId])).toEqual([
      ["Ada", null],
      ["Kenzo", kenzo],
      ["Tidal", tidal],
    ]);
    // Admins see which came from Discord.
    const { signups } = await adminOk<{ signups: { name: string; discordUserId: string | null }[] }>(`tourneys/${id}/signups`);
    expect(signups.map((s) => s.discordUserId)).toEqual([null, kenzo, tidal]);
  });

  it("answers a user already signed up, and isn't rate-limited by IP", async () => {
    const id = await newTourney();
    await register(id, [{ discordUserId: kenzo, name: "Kenzo" }]);
    const again = await register(id, [{ discordUserId: kenzo, name: "Someone else" }]);
    expect(statuses(again)).toEqual(["exists"]);
    expect(again.results[0]!.signup!.name).toBe("Kenzo");

    const many = Array.from({ length: defaults.tourneySignupsPerHour + 5 }, (_, i) => ({ discordUserId: `2000000000000000${10 + i}`, name: `Player ${i}` }));
    expect(statuses(await register(id, many)).every((s) => s === "created")).toBe(true);
  });

  it("lets a Discord user claim a name signed up from the page, but not another Discord user's", async () => {
    const id = await newTourney();
    await pageSignUp(id, "Kenzo");
    const res = await register(id, [{ discordUserId: kenzo, name: "kenzo" }]);
    expect(statuses(res)).toEqual(["linked"]);
    expect(res.results[0]!.signup!.name).toBe("Kenzo");
    expect(res.signups.count).toBe(1);

    expect(statuses(await register(id, [{ discordUserId: tidal, name: "KENZO" }]))).toEqual(["name_taken"]);
    // Two users with one name in a request: the first gets it.
    expect(statuses(await register(id, [
      { discordUserId: "100000000000000003", name: "Twin" },
      { discordUserId: "100000000000000004", name: "twin" },
    ]))).toEqual(["created", "name_taken"]);
    // The page's sign-up of the name answers the claimed one.
    expect((await pageSignUp(id, "Kenzo")).status).toBe(200);
  });

  it("keeps an admin's removal", async () => {
    const id = await newTourney();
    await register(id, [{ discordUserId: kenzo, name: "Kenzo" }]);
    await pageSignUp(id, "Tidal");
    const { signups } = await adminOk<{ signups: { id: number }[] }>(`tourneys/${id}/signups`);
    for (const s of signups) await adminOk(`signups/${s.id}`, { removed: true });

    const res = await register(id, [
      { discordUserId: kenzo, name: "Kenzo" },
      { discordUserId: tidal, name: "Tidal" },
    ]);
    expect(statuses(res)).toEqual(["removed", "removed"]);
    expect(res.results.map((r) => r.signup)).toEqual([null, null]);
    // Unregistering doesn't undo the removal.
    expect(await (await bot(`${id}/signups/${kenzo}`, { method: "DELETE" })).json()).toMatchObject({ removed: false });
    expect((await adminOk<{ signups: unknown[] }>(`tourneys/${id}/signups`)).signups).toHaveLength(2);
  });

  it("unregisters a Discord user", async () => {
    const id = await newTourney();
    await pageSignUp(id, "Kenzo");
    await register(id, [{ discordUserId: kenzo, name: "Kenzo" }, { discordUserId: tidal, name: "Tidal" }]);
    const res = await bot(`${id}/signups/${kenzo}`, { method: "DELETE" });
    expect(await res.json()).toMatchObject({ removed: true, name: "Kenzo", signups: { count: 1 } });
    expect(await pageNames(id)).toEqual(["Tidal"]);
    expect(await (await bot(`${id}/signups/${kenzo}`, { method: "DELETE" })).json()).toMatchObject({ removed: false, name: null });
    // They can sign up again.
    expect(statuses(await register(id, [{ discordUserId: kenzo, name: "Kenzo" }]))).toEqual(["created"]);
  });

  it("closes once the tourney leaves scheduled", async () => {
    const id = await newTourney();
    await register(id, [{ discordUserId: kenzo, name: "Kenzo" }]);
    await adminOk(`tourneys/${id}`, { status: "live" });
    const res = await bot(`${id}/signups`, { method: "POST", body: { signups: [{ discordUserId: tidal, name: "Tidal" }] } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "closed" });
    expect((await bot(`${id}/signups/${kenzo}`, { method: "DELETE" })).status).toBe(409);
    expect(await pageNames(id)).toEqual(["Kenzo"]);
  });

  it("refuses a bad body, an unknown tourney or route", async () => {
    const id = await newTourney();
    for (const body of [
      {},
      { signups: [] },
      { signups: [{ discordUserId: "nope", name: "Kenzo" }] },
      { signups: [{ discordUserId: kenzo, name: "" }] },
      { signups: [{ discordUserId: kenzo, name: "A" }, { discordUserId: kenzo, name: "B" }] },
      { signups: Array.from({ length: defaults.botSignupsPerRequest + 1 }, (_, i) => ({ discordUserId: `3000000000000000${10 + i}`, name: `P${i}` })) },
    ]) {
      expect((await bot(`${id}/signups`, { method: "POST", body })).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await bot("999/signups")).status).toBe(404);
    expect((await bot(`999/signups`, { method: "POST", body: { signups: [{ discordUserId: kenzo, name: "Kenzo" }] } })).status).toBe(404);
    expect((await bot(`${id}/other`)).status).toBe(404);
    expect((await bot(`${id}/signups`, { method: "PUT" })).status).toBe(405);
    expect(await pageNames(id)).toEqual([]);
  });
});
