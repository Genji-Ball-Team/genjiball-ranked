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

export type PublicConfig = Pick<Config, "publicCacheSeconds" | "corsMaxAgeSeconds">;

/**
 * First path segments of the public read routes: `/api/<segment>` and everything under it. A new
 * public route adds its segment here. Some are listed before their routes exist (`lobbies`,
 * `head-to-head`, `records`): an unknown path under them is still a `404`.
 */
export const publicReadRoutes: readonly string[] = [
  "health",
  "server",
  "leaderboard",
  "players",
  "matches",
  "tourneys",
  "lobbies",
  "head-to-head",
  "records",
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

/** A weak ETag from the body's SHA-256: the same answer gets the same tag. */
async function weakEtag(body: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const hex = [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `W/"${hex}"`;
}

/** `If-None-Match` against an ETag, compared weakly (RFC 9110): `W/"x"` matches `"x"`. */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}
