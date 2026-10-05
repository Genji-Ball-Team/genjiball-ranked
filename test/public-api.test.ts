import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { sha256 } from "../src/upload/handler";
import { isPrivate, isPublicRead, privateRoutes, publicReadRoutes } from "../src/public";

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
