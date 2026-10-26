import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { robotsTxt, sitemapXml } from "../src/site/robots";

describe("worker", () => {
  it("reports health with a working D1", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns JSON 404 for unknown API paths", async () => {
    const res = await SELF.fetch("https://example.com/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("serves the website", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Genji Ball Ranked");
  });

  it("answers a page that isn't there with the 404 page and a 404 status", async () => {
    const res = await SELF.fetch("https://example.com/no-such-page");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain('data-page="not-found"');
  });

  it("lets search engines in, all but the admin page, and points them at the sitemap", async () => {
    const res = await SELF.fetch("https://example.com/robots.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Disallow: /admin");
    expect(body).not.toContain("Disallow: /\n");
    expect(body).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("lists each page once per region in the sitemap", async () => {
    const res = await SELF.fetch("https://example.com/sitemap.xml");
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain("<loc>https://example.com/?region=eu</loc>");
    expect(body).toContain("<loc>https://example.com/records?region=na</loc>");
    expect(body).not.toContain("admin");
  });
});

describe("robots on the test server", () => {
  it("keeps search engines out and has no sitemap", async () => {
    const config = { testServer: true, regions: [{ id: "eu", label: "Europe" }] };
    expect(await robotsTxt(config, "https://test.example").text()).toBe("User-agent: *\nDisallow: /\n");
    expect(sitemapXml(config, "https://test.example").status).toBe(404);
  });
});
