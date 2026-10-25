import { hex } from "./bytes";
import type { Config } from "./config";

/**
 * The public read API (#10, docs/api.md "Public API"): CORS and caching for every public route, in
 * one place, so a route gets them by being listed here rather than by its handler remembering to.
 *
 * A path is public when its first segment after `/api/` is in `publicReadRoutes`. Every answer on
 * one gets `Access-Control-Allow-Origin: *`; an `OPTIONS` is answered as a CORS preflight allowing
 * only `GET` and `HEAD`. A 2xx without its own `Cache-Control` gets `publicCacheSeconds`, a JSON 200
 * gets an `ETag` (and a `304` for a matching `If-None-Match`), and an error is never cached. The
 * routes behind a token (`privateRoutes`) never get CORS headers, and are never cached.
 */

export type PublicConfig = Pick<Config, "publicCacheSeconds" | "corsMaxAgeSeconds" | "publicEdgeCache">;

/**
 * First path segments of the public read routes: `/api/<segment>` and everything under it. A new
 * public route adds its segment here. An unknown path under one is still a `404`.
 */
export const publicReadRoutes: readonly string[] = [
  "health",
  "server",
  "leaderboard",
  "titles",
  "tiers",
  "players",
  "matches",
  "tourneys",
  "lobbies",
  "head-to-head",
  "records",
  "recent",
  "rules",
  "rank-tags",
  "screenshots",
];

/** First path segments that need a token: never public, whatever `publicReadRoutes` says. */
export const privateRoutes: readonly string[] = ["admin", "host", "upload", "bot"];

/** A tourney sign-up: `/api/tourneys/:id/signups` (src/tourney/signups.ts). */
export const signupRoute = /^\/api\/tourneys\/[^/]+\/signups\/?$/;

/**
 * Public writes: the routes anyone may `POST` to without a token (a tourney sign-up, #31). They're
 * for the site's own pages, so they're same-origin only: no CORS headers (the preflight of a public
 * path allows only `GET` and `HEAD`), a request whose `Origin` is another site's is refused, and
 * every answer is `Cache-Control: no-store`, like a private route's.
 */
const publicWrites: readonly RegExp[] = [signupRoute];

/** Whether this is a public write (`POST /api/tourneys/:id/signups`). */
export function isPublicWrite(method: string, pathname: string): boolean {
  return method === "POST" && publicWrites.some((route) => route.test(pathname));
}

/** Whether a public write comes from this site's own pages: no `Origin` (not a browser), or this origin. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}

/** Response headers a page on another origin may read besides the CORS-safelisted ones. */
const exposedHeaders = "ETag";

/** Whether the path is a public read route (`/api/leaderboard`, `/api/players/12`, ...). */
export function isPublicRead(pathname: string): boolean {
  const parts = pathname.split("/");
  if (parts[1] !== "api") return false;
  const segment = parts[2] ?? "";
  return publicReadRoutes.includes(segment) && !privateRoutes.includes(segment);
}

/** Whether the path is behind a token: `/api/admin`, `/api/host/...`, `/api/upload`, `/api/bot/...` (`privateRoutes`). */
export function isPrivate(pathname: string): boolean {
  const parts = pathname.split("/");
  return parts[1] === "api" && privateRoutes.includes(parts[2] ?? "");
}

/** A private route's answer with `Cache-Control: no-store`: it's for one token's holder, never for a shared cache. */
export function withPrivateHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The answer to an `OPTIONS` on a public route: a CORS preflight allowing `GET` and `HEAD` from anywhere. */
export function preflight(config: PublicConfig): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD",
      // `*` allows any request header except Authorization, which no public route reads.
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": String(config.corsMaxAgeSeconds),
      Allow: "GET, HEAD, OPTIONS",
    },
  });
}

/** Adds the public headers to a public route's answer: CORS, `Cache-Control`, `ETag`; a `304` when the client's copy is current. */
export async function withPublicHeaders(request: Request, response: Response, config: PublicConfig): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", exposedHeaders);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (response.status < 200 || response.status >= 300) {
    // A 404 can turn into a match a minute later (accepted from review): never keep an error.
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, init);
  }
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", `public, max-age=${config.publicCacheSeconds}`);

  let body: ReadableStream | ArrayBuffer | null = response.body;
  if (response.status === 200 && !headers.has("ETag") && headers.get("Content-Type")?.startsWith("application/json")) {
    body = await response.arrayBuffer();
    headers.set("ETag", await weakEtag(body));
  }
  const etag = headers.get("ETag");
  if (response.status === 200 && etag && matchesEtag(request.headers.get("If-None-Match"), etag)) {
    if (body instanceof ReadableStream) await body.cancel();
    for (const name of ["Content-Type", "Content-Length", "Content-Disposition"]) headers.delete(name);
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, init);
}

/**
 * A public read through Cloudflare's cache in this data centre (`publicEdgeCache`): the first `GET` of
 * a URL runs `answer`, and every visitor's `GET` of it until its `Cache-Control` lifetime ends gets
 * that copy, with no D1 read. Keyed by the URL alone: no public route reads a request header. Only a
 * `200` that's `public` with a `max-age` is kept, never an error. A copy is answered with what's left
 * of its lifetime as its `max-age`, so a browser keeps it no longer than the first visitor's. (The
 * zone's Browser Cache TTL rewrites the `Cache-Control` of anything from the cache, and the edge sets
 * its own `Date`: the copy carries its lifetime and when it was made in headers of its own.) Then the
 * public headers as for any public read, a `304` included.
 */
export async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  config: PublicConfig,
  answer: () => Promise<Response>,
): Promise<Response> {
  if (!config.publicEdgeCache || request.method !== "GET") return withPublicHeaders(request, await answer(), config);
  const key = new Request(request.url, { method: "GET" });
  const cache = caches.default;
  const kept = await cache.match(key).catch(() => undefined);
  const copy = kept && fromEdge(kept);
  if (copy) return withPublicHeaders(request, copy, config);

  const fresh = await withPublicHeaders(key, await answer(), config);
  const lifetime = edgeLifetime(fresh);
  if (lifetime) {
    const stored = new Response(fresh.clone().body, fresh);
    stored.headers.set(edgeMade, String(Date.now()));
    stored.headers.set(edgeLifetimeHeader, String(lifetime));
    ctx.waitUntil(cache.put(key, stored).catch(() => {}));
  }
  return withPublicHeaders(request, fresh, config);
}

const edgeMade = "GB-Edge-Made";
const edgeLifetimeHeader = "GB-Edge-Lifetime";

/** How long Cloudflare's cache may keep this answer, in seconds: a `200`, `public`, with a `max-age` above 0. */
function edgeLifetime(response: Response): number | null {
  const control = response.headers.get("Cache-Control") ?? "";
  const maxAge = Number(/\bmax-age=(\d+)/.exec(control)?.[1] ?? 0);
  if (response.status !== 200 || !/\bpublic\b/.test(control) || /no-store|private/.test(control) || maxAge <= 0) return null;
  return maxAge;
}

/** A copy from the cache, with `max-age` what's left of its lifetime; null for one without its own headers. */
function fromEdge(kept: Response): Response | null {
  const made = Number(kept.headers.get(edgeMade));
  const lifetime = Number(kept.headers.get(edgeLifetimeHeader));
  if (!made || !lifetime) return null;
  const headers = new Headers(kept.headers);
  headers.delete(edgeMade);
  headers.delete(edgeLifetimeHeader);
  const left = Math.max(0, lifetime - Math.floor((Date.now() - made) / 1000));
  headers.set("Cache-Control", `public, max-age=${left}`);
  return new Response(kept.body, { status: kept.status, statusText: kept.statusText, headers });
}

/** A weak ETag from the body's SHA-256: the same answer gets the same tag. */
async function weakEtag(body: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return `W/"${hex(hash.slice(0, 12))}"`;
}

/** `If-None-Match` against an ETag, compared weakly (RFC 9110): `W/"x"` matches `"x"`. */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}
