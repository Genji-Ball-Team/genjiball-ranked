import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** The site's pages carry site/_headers' policy; the Worker's own answers one that allows nothing. */
const pagePolicy = /^default-src 'none'; script-src 'self' https:\/\/static\.cloudflareinsights\.com; .*style-src-elem 'self' 'sha256-/;
const apiPolicy = "default-src 'none'; frame-ancestors 'none'";

function expectSecure(res: Response) {
  expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
}

describe("security headers", () => {
  it("gives a page the site's Content-Security-Policy", async () => {
    for (const path of ["/", "/player?id=1", "/no-such-page"]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      await res.arrayBuffer();
      expect(res.headers.get("Content-Security-Policy"), path).toMatch(pagePolicy);
      expectSecure(res);
    }
  });

  it("gives the Worker's own answers a policy that allows nothing", async () => {
    for (const path of ["/api/health", "/api/nope", "/api/leaderboard?region=eu", "/robots.txt", "/api/admin/hosts"]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      await res.arrayBuffer();
      expect(res.headers.get("Content-Security-Policy"), path).toBe(apiPolicy);
      expectSecure(res);
    }
  });

  it("keeps CORS on the public API", async () => {
    const res = await SELF.fetch("https://example.com/api/leaderboard?region=eu");
    await res.arrayBuffer();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
