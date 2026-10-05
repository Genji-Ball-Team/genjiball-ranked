import { createScheduledController, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import worker from "../src/index";
import { handleHostLobby } from "../src/lobby/handler";
import { createLogger } from "../src/log";
import { handleSite } from "../src/site/handler";
import { sha256 } from "../src/upload/handler";

const db = () => env.DB;
const log = createLogger("error");
const tokens = { eu: "eu-token", na: "na-token", nohome: "nohome-token", revoked: "revoked-token" };
const t0 = new Date("2026-10-05T20:00:00Z");
const later = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  await db().batch([db().prepare("DELETE FROM live_lobbies"), db().prepare("DELETE FROM hosts")]);
  const hosts: [number, string, string, string, string | null][] = [
    [1, "Kenzo", tokens.eu, "trusted", "eu"],
    [2, "Mira", tokens.na, "untrusted", "na"],
    [3, "Drifter", tokens.nohome, "trusted", null],
    [4, "Gone", tokens.revoked, "revoked", "eu"],
  ];
  await db().batch(
    await Promise.all(
      hosts.map(async ([id, name, token, trust, region]) =>
        db()
          .prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (?, ?, ?, ?, ?)")
          .bind(id, name, await sha256(token), trust, region),
      ),
    ),
  );
});

function request(method: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/host/lobby", {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

/** A heartbeat at `now`, through the handler so the test sets the time. */
function heartbeat(token: string | null, body: unknown = { players: 4 }, now = t0, headers: Record<string, string> = {}) {
  return handleHostLobby(request("PUT", token, body, headers), db(), defaults, log, now);
}

async function list(query = "", now = t0) {
  const res = (await handleSite(new Request(`https://example.com/api/lobbies${query}`), db(), defaults, now))!;
  return { res, body: (await res.json()) as { region: string; lobbies: Record<string, unknown>[] } };
}

describe("PUT /api/host/lobby (heartbeat)", () => {
  it("opens a lobby the site lists in the host's region", async () => {
    const res = await heartbeat(tokens.eu, { players: 6, name: "  Kenzo's ranked  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lobby: { region: "eu", name: "Kenzo's ranked", players: 6, openedAt: "2026-10-05T20:00:00Z", seenAt: "2026-10-05T20:00:00Z" },
      heartbeatSeconds: defaults.lobbyHeartbeatSeconds,
      ttlSeconds: defaults.lobbyTtlSeconds,
    });
    const { res: read, body } = await list("?region=eu", later(10));
    expect(read.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.lobbiesCacheSeconds}`);
    expect(body).toEqual({
      region: "eu",
      lobbies: [{ hostName: "Kenzo", name: "Kenzo's ranked", players: 6, openedAt: "2026-10-05T20:00:00Z", seenAt: "2026-10-05T20:00:00Z", tourney: null }],
    });
  });

  it("works through the Worker's route", async () => {
    const res = await SELF.fetch("https://example.com/api/host/lobby", {
      method: "PUT",
      body: JSON.stringify({ players: 2 }),
      headers: { Authorization: `Bearer ${tokens.eu}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lobby: { region: "eu", name: null, players: 2 } });
    const read = await SELF.fetch("https://example.com/api/lobbies?region=eu");
    expect(((await read.json()) as { lobbies: unknown[] }).lobbies).toHaveLength(1);
  });

  it("keeps the regions apart", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    await heartbeat(tokens.na, { players: 8 });
    const eu = await list("?region=eu");
    const na = await list("?region=na");
    expect(eu.body.region).toBe("eu");
    expect(eu.body.lobbies.map((l) => l.hostName)).toEqual(["Kenzo"]);
    expect(na.body.region).toBe("na");
    expect(na.body.lobbies.map((l) => l.hostName)).toEqual(["Mira"]);
  });

  it("uses X-Region over the home region", async () => {
    const res = await heartbeat(tokens.eu, { players: 4 }, t0, { "X-Region": "NA" });
    expect(await res.json()).toMatchObject({ lobby: { region: "na" } });
    expect((await list("?region=na")).body.lobbies.map((l) => l.hostName)).toEqual(["Kenzo"]);
    expect((await list("?region=eu")).body.lobbies).toEqual([]);
  });

  it("falls back to the home region without X-Region", async () => {
    const res = await heartbeat(tokens.na, { players: 4 });
    expect(await res.json()).toMatchObject({ lobby: { region: "na" } });
  });

  it("answers 422 no_region for a host with no home region and no X-Region, and stores nothing", async () => {
    const res = await heartbeat(tokens.nohome);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "no_region" });
    expect(await db().prepare("SELECT count(*) AS n FROM live_lobbies").first("n")).toBe(0);
    const ok = await heartbeat(tokens.nohome, { players: 3 }, t0, { "X-Region": "eu" });
    expect(ok.status).toBe(200);
  });

  it("answers 400 for an X-Region that isn't a region", async () => {
    const res = await heartbeat(tokens.eu, { players: 4 }, t0, { "X-Region": "asia" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
  });

  it("checks the host token", async () => {
    expect((await heartbeat(null)).status).toBe(401);
    expect((await heartbeat("unknown")).status).toBe(401);
    const revoked = await heartbeat(tokens.revoked);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ error: "revoked" });
  });

  it("answers 405 for another method", async () => {
    const res = await handleHostLobby(request("GET", tokens.eu), db(), defaults, log, t0);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PUT, DELETE");
  });

  it("rejects a bad body", async () => {
    const bad = [
      "not json",
      "[1]",
      {},
      { players: -1 },
      { players: 2.5 },
      { players: "4" },
      { players: defaults.lobbyPlayersMax + 1 },
      { players: 4, name: 7 },
      { players: 4, name: "x".repeat(defaults.lobbyNameMaxLength + 1) },
      JSON.stringify({ players: 4, name: "x".repeat(defaults.lobbyBodyMaxBytes) }),
    ];
    for (const body of bad) {
      const res = await heartbeat(tokens.eu, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
    expect(await db().prepare("SELECT count(*) AS n FROM live_lobbies").first("n")).toBe(0);
  });

  it("refreshes the lobby, keeping when it opened", async () => {
    await heartbeat(tokens.eu, { players: 4, name: "Lobby" });
    const res = await heartbeat(tokens.eu, { players: 7 }, later(60));
    expect(await res.json()).toMatchObject({
      lobby: { players: 7, name: null, openedAt: "2026-10-05T20:00:00Z", seenAt: "2026-10-05T20:01:00Z" },
    });
    expect(await db().prepare("SELECT count(*) AS n FROM live_lobbies").first("n")).toBe(1);
  });

  it("rate limits a heartbeat sooner than lobbyHeartbeatMinSeconds, writing nothing", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    const res = await heartbeat(tokens.eu, { players: 5 }, later(defaults.lobbyHeartbeatMinSeconds - 1));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(res.headers.get("Retry-After")).toBe(String(defaults.lobbyHeartbeatMinSeconds));
    expect((await list()).body.lobbies).toMatchObject([{ players: 4 }]);
    expect((await heartbeat(tokens.eu, { players: 5 }, later(defaults.lobbyHeartbeatMinSeconds))).status).toBe(200);
  });

  it("drops a lobby whose heartbeats stopped, and a new heartbeat opens a new one", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    expect((await list("", later(defaults.lobbyTtlSeconds - 1))).body.lobbies).toHaveLength(1);
    expect((await list("", later(defaults.lobbyTtlSeconds))).body.lobbies).toEqual([]);
    const res = await heartbeat(tokens.eu, { players: 4 }, later(defaults.lobbyTtlSeconds + 30));
    expect(await res.json()).toMatchObject({ lobby: { openedAt: "2026-10-05T20:03:30Z" } });
  });

  it("opens a new lobby when the region changes", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    const res = await heartbeat(tokens.eu, { players: 4 }, later(60), { "X-Region": "na" });
    expect(await res.json()).toMatchObject({ lobby: { region: "na", openedAt: "2026-10-05T20:01:00Z" } });
  });

  it("doesn't list a lobby once its host is revoked", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    await db().prepare("UPDATE hosts SET trust = 'revoked' WHERE id = 1").run();
    expect((await list()).body.lobbies).toEqual([]);
  });
});

describe("DELETE /api/host/lobby (close)", () => {
  it("closes the host's lobby", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    await heartbeat(tokens.na, { players: 4 });
    const res = await handleHostLobby(request("DELETE", tokens.eu), db(), defaults, log, later(5));
    expect(await res.json()).toEqual({ closed: true });
    expect((await list("?region=eu")).body.lobbies).toEqual([]);
    expect((await list("?region=na")).body.lobbies).toHaveLength(1);
  });

  it("says when no lobby was open, and checks the token", async () => {
    expect(await (await handleHostLobby(request("DELETE", tokens.eu), db(), defaults, log)).json()).toEqual({ closed: false });
    expect((await handleHostLobby(request("DELETE", null), db(), defaults, log)).status).toBe(401);
  });

  it("lets a closed lobby open again at once", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    await handleHostLobby(request("DELETE", tokens.eu), db(), defaults, log, later(5));
    const res = await heartbeat(tokens.eu, { players: 4 }, later(10));
    expect(await res.json()).toMatchObject({ lobby: { openedAt: "2026-10-05T20:00:10Z" } });
  });
});

describe("GET /api/lobbies", () => {
  it("answers for the first region without ?region=", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    const { body } = await list();
    expect(body.region).toBe(defaults.regions[0]!.id);
    expect(body.lobbies).toHaveLength(1);
  });

  it("answers 400 for a region that isn't one", async () => {
    const { res, body } = await list("?region=asia");
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ error: "bad_request" });
  });

  it("lists the longest open first", async () => {
    await heartbeat(tokens.eu, { players: 4 }, later(30));
    await heartbeat(tokens.nohome, { players: 4 }, t0, { "X-Region": "eu" });
    expect((await list("", later(40))).body.lobbies.map((l) => l.hostName)).toEqual(["Drifter", "Kenzo"]);
  });

  it("only takes GET", async () => {
    const res = (await handleSite(new Request("https://example.com/api/lobbies", { method: "POST" }), db(), defaults))!;
    expect(res.status).toBe(405);
  });
});

describe("cron", () => {
  beforeEach(async () => {
    await db().prepare("INSERT OR IGNORE INTO rating_state (board) VALUES ('eu'), ('na')").run();
  });

  it("deletes the lobbies whose heartbeats stopped and keeps the others", async () => {
    await heartbeat(tokens.eu, { players: 4 });
    await heartbeat(tokens.na, { players: 4 }, later(defaults.lobbyTtlSeconds));
    const now = later(defaults.lobbyTtlSeconds + 1);
    await worker.scheduled(createScheduledController({ scheduledTime: now, cron: "*/10 * * * *" }), env);
    const { results } = await db().prepare("SELECT host_id AS hostId FROM live_lobbies").all<{ hostId: number }>();
    expect(results).toEqual([{ hostId: 2 }]);
  });
});
