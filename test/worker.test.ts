import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
});
