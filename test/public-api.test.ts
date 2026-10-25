import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { sha256 } from "../src/bytes";
import worker from "../src/index";
import { isPrivate, isPublicRead, privateRoutes, publicReadRoutes } from "../src/public";
import { countingDb } from "./helpers";

/** CORS and caching for the public read routes (#10, src/public.ts). */

const origin = { Origin: "https://community-tool.example" };

describe("public API: CORS and caching", () => {
  it("answers a public GET with CORS, the default Cache-Control and an ETag", async () => {
    const res = await SELF.fetch("https://example.com/api/leaderboard", { headers: origin });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.publicCacheSeconds}`);
    expect(res.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{24}"$/);
    expect(await res.json()).toMatchObject({ region: "eu", players: [] });
  });

  it("answers 304 to a matching If-None-Match, still with CORS", async () => {
    const first = await SELF.fetch("https://example.com/api/server");
    const etag = first.headers.get("ETag")!;
    await first.arrayBuffer();
    const again = await SELF.fetch("https://example.com/api/server", { headers: { ...origin, "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(again.headers.get("ETag")).toBe(etag);
    expect(await again.text()).toBe("");

    const other = await SELF.fetch("https://example.com/api/server", { headers: { "If-None-Match": 'W/"stale"' } });
    expect(other.status).toBe(200);
  });

  it("keeps a route's own Cache-Control", async () => {
    const res = await SELF.fetch("https://example.com/api/rank-tags");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.rankTagsCacheSeconds}`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("gives each site route the default Cache-Control or its own", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO players (id, name) VALUES (902, 'Cache One'), (903, 'Cache Two')").run();
    const lifetime = (seconds: number) => `public, max-age=${seconds}`;
    const routes: [string, number][] = [
      ["/api/leaderboard", defaults.publicCacheSeconds],
      ["/api/server", defaults.publicCacheSeconds],
      ["/api/players?search=cache", defaults.publicCacheSeconds],
      ["/api/players/902", defaults.publicCacheSeconds],
      ["/api/players/902/history", defaults.publicCacheSeconds],
      ["/api/players/902/stats", defaults.publicCacheSeconds],
      ["/api/head-to-head?a=902&b=903", defaults.publicCacheSeconds],
      ["/api/matches?after=0", defaults.publicCacheSeconds],
      ["/api/records", defaults.publicCacheSeconds],
      ["/api/tourneys", defaults.publicCacheSeconds],
      ["/api/rank-tags", defaults.rankTagsCacheSeconds],
      ["/api/lobbies", defaults.lobbiesCacheSeconds],
    ];
    for (const [path, seconds] of routes) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control"), path).toBe(lifetime(seconds));
      await res.arrayBuffer();
    }
  });

  it("never caches an error on a public route, and still allows reading it", async () => {
    for (const path of ["/api/matches/999999", "/api/leaderboard?region=mars", "/api/players/nope"]) {
      const res = await SELF.fetch(`https://example.com${path}`, { headers: origin });
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
    }
    const post = await SELF.fetch("https://example.com/api/leaderboard", { method: "POST", headers: origin });
    expect(post.status).toBe(405);
    expect(post.headers.get("Cache-Control")).toBe("no-store");
  });

  it("gives the live lobbies CORS, keeping their own Cache-Control", async () => {
    const res = await SELF.fetch("https://example.com/api/lobbies?region=na", { headers: origin });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.lobbiesCacheSeconds}`);
    expect(await res.json()).toMatchObject({ region: "na", lobbies: [] });
    const preflightRes = await SELF.fetch("https://example.com/api/lobbies", { method: "OPTIONS", headers: { ...origin, "Access-Control-Request-Method": "GET" } });
    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers a CORS preflight on a public route, allowing only GET and HEAD", async () => {
    const res = await SELF.fetch("https://example.com/api/players/1", {
      method: "OPTIONS",
      headers: { ...origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "if-none-match" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("*");
    expect(res.headers.get("Access-Control-Max-Age")).toBe(String(defaults.corsMaxAgeSeconds));
  });

  it("gives no CORS headers on the admin, host and upload routes, and never lets them be cached", async () => {
    const paths = [
      "/api/admin",
      "/api/admin/me",
      "/api/admin/matches",
      "/api/host/me",
      "/api/host/matches",
      "/api/host/lobby",
      "/api/host/tourneys",
      "/api/host/lobbies/1/screenshot",
      "/api/upload",
    ];
    for (const path of paths) {
      for (const method of ["GET", "OPTIONS", "POST", "PUT"]) {
        const res = await SELF.fetch(`https://example.com${path}`, {
          method,
          headers: { ...origin, "Access-Control-Request-Method": "GET" },
        });
        expect(res.headers.get("Access-Control-Allow-Origin"), `${method} ${path}`).toBeNull();
        expect(res.headers.get("Access-Control-Allow-Methods"), `${method} ${path}`).toBeNull();
        expect(res.headers.get("Cache-Control"), `${method} ${path}`).toBe("no-store");
        await res.arrayBuffer();
      }
    }
  });

  it("answers a successful private read with no-store too", async () => {
    await env.DB.prepare("DELETE FROM hosts WHERE id = 901").run();
    await env.DB.prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (901, 'cache-test', ?, 'trusted', 'eu')")
      .bind(await sha256("cache-test-token"))
      .run();
    const res = await SELF.fetch("https://example.com/api/host/me", { headers: { ...origin, Authorization: "Bearer cache-test-token" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await res.json()).toMatchObject({ host: { name: "cache-test" } });
  });

  it("gives no CORS headers on paths that aren't a public route", async () => {
    const res = await SELF.fetch("https://example.com/api/nope", { headers: origin });
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("decides by the first path segment, and never for a private one", () => {
    expect(isPublicRead("/api/leaderboard")).toBe(true);
    expect(isPublicRead("/api/players/12/history")).toBe(true);
    expect(isPublicRead("/api/head-to-head")).toBe(true);
    expect(isPublicRead("/api/lobbies")).toBe(true);
    expect(isPublicRead("/api/leaderboards")).toBe(false);
    expect(isPublicRead("/api/admin/matches")).toBe(false);
    expect(isPublicRead("/api/host/me")).toBe(false);
    expect(isPublicRead("/api/upload")).toBe(false);
    expect(isPublicRead("/leaderboard")).toBe(false);
    expect(publicReadRoutes.filter((r) => privateRoutes.includes(r))).toEqual([]);
    expect(isPrivate("/api/admin")).toBe(true);
    expect(isPrivate("/api/host/lobbies/3/screenshot")).toBe(true);
    expect(isPrivate("/api/upload")).toBe(true);
    expect(isPrivate("/api/hosts")).toBe(false);
    expect(isPrivate("/api/leaderboard")).toBe(false);
  });
});

/** Public reads through Cloudflare's cache (`publicEdgeCache`, src/public.ts). Off for the other tests. */
describe("public API: edge cache", () => {
  // Each test asks for URLs of its own: the cache outlives a test.
  let n = 0;
  const unique = (path: string) => `https://example.com/api/${path}${path.includes("?") ? "&" : "?"}edge=${++n}-${Date.now()}`;

  async function read(url: string, headers: Record<string, string> = {}) {
    const counted = countingDb(env.DB);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(url, { headers }), { ...env, DB: counted.db, PUBLIC_EDGE_CACHE: "true" }, ctx);
    await waitOnExecutionContext(ctx);
    return { res, queries: counted.queries() };
  }

  it("answers a second GET of a URL from the cache, with no D1 read, and a 304 from it", async () => {
    const url = unique("leaderboard?region=eu");
    const first = await read(url);
    expect(first.res.status).toBe(200);
    expect(first.queries).toBeGreaterThan(0);
    const etag = first.res.headers.get("ETag")!;
    const body = await first.res.json();
    // The time it was made, so a browser counts the time it was kept here.
    const made = first.res.headers.get("Date");
    expect(made).toBeTruthy();

    const second = await read(url, origin);
    expect(second.queries).toBe(0);
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get("ETag")).toBe(etag);
    expect(second.res.headers.get("Date")).toBe(made);
    expect(second.res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await second.res.json()).toEqual(body);

    const unchanged = await read(url, { "If-None-Match": etag });
    expect(unchanged.queries).toBe(0);
    expect(unchanged.res.status).toBe(304);
  });

  it("never keeps an error or a no-store answer", async () => {
    const missing = unique("players/987654?region=eu");
    expect((await read(missing)).res.status).toBe(404);
    const again = await read(missing);
    expect(again.res.status).toBe(404);
    expect(again.queries).toBeGreaterThan(0);

    const health = unique("health");
    await read(health);
    expect((await read(health)).queries).toBe(1);
  });

  it("leaves a HEAD to the Worker", async () => {
    const url = unique("server");
    await read(url);
    const counted = countingDb(env.DB);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(url, { method: "HEAD" }), { ...env, DB: counted.db, PUBLIC_EDGE_CACHE: "true" }, ctx);
    expect(res.status).toBe(200);
  });
});
