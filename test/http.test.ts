import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defaults, notARegion } from "../src/config";
import { bearerToken, jsonObject, pageNumber, positiveId } from "../src/http";

/** The request helpers every handler shares (src/http.ts), and the errors they answer. */

describe("request helpers", () => {
  it("reads positive ids", () => {
    expect(positiveId("42")).toBe(42);
    expect(positiveId("1234567890123456")).toBe(1234567890123456);
    for (const bad of [null, undefined, "", "0", "-1", "01", "1.5", "abc", "10000000000000000"]) expect(positiveId(bad)).toBeNull();
  });

  it("reads page numbers and counts", () => {
    expect(pageNumber("3")).toBe(3);
    for (const bad of [null, "", "0", "1000000", "x"]) expect(pageNumber(bad)).toBeNull();
  });

  it("reads a bearer token", () => {
    const auth = (value?: string) => new Request("https://example.com", { headers: value === undefined ? {} : { Authorization: value } });
    expect(bearerToken(auth("Bearer abc "))).toBe("abc");
    for (const bad of [undefined, "", "Bearer ", "Bearer   ", "Basic abc"]) expect(bearerToken(auth(bad))).toBeNull();
  });

  it("reads a JSON object, or says what's wrong", () => {
    expect(jsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(jsonObject("nope")).toBe("The body must be JSON");
    expect(jsonObject("[1]", "{ name }")).toBe("The body must be a JSON object: { name }");
    expect(jsonObject("null", "{ name }")).toBe("The body must be a JSON object: { name }");
  });

  it("names the regions in a bad region's message", () => {
    expect(notARegion(defaults.regions, "X-Region")).toBe("X-Region must be one of eu, na");
  });
});

describe("error answers", () => {
  const send = (path: string, method = "GET", body?: string) => SELF.fetch(`https://example.com${path}`, { method, body });

  it.each([
    ["/api/leaderboard", "POST", "GET, HEAD", "Use GET"],
    ["/api/players/1/history", "DELETE", "GET, HEAD", "Use GET"],
    ["/api/upload", "GET", "POST", "Use POST"],
    ["/api/host/me", "POST", "GET", "Use GET"],
    ["/api/host/lobby", "GET", "PUT, DELETE", "Use PUT for a heartbeat, DELETE to close the lobby"],
    ["/api/host/tourneys", "POST", "GET", "Use GET"],
    ["/api/host/lobbies/1/screenshot", "POST", "PUT, DELETE", "Use PUT or DELETE"],
    ["/api/tourneys/1/signups", "GET", "POST", "Use POST"],
  ])("%s answers %s with a 405", async (path, method, allow, message) => {
    const res = await send(path, method);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe(allow);
    expect(await res.json()).toEqual({ error: "method_not_allowed", message });
  });

  it("answers 404 for an unknown path under a site route, whatever the method", async () => {
    for (const method of ["GET", "POST"]) {
      const res = await send("/api/players/1/unknown", method);
      expect(res.status, method).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("checks the region before the route and the method", async () => {
    for (const [path, method] of [["/api/leaderboard?region=mars", "POST"], ["/api/players/1/unknown?region=mars", "GET"], ["/api/players/1?region=mars", "DELETE"]]) {
      const res = await send(path!, method);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request", message: "region must be one of eu, na" });
    }
  });

  it("answers an unknown region with the regions", async () => {
    const res = await send("/api/leaderboard?region=mars");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request", message: "region must be one of eu, na" });
  });

  it("answers a sign-up that isn't a JSON object", async () => {
    const res = await send("/api/tourneys/1/signups", "POST", "[]");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request", message: "The body must be a JSON object: { name }" });
  });
});
