import { handleAdmin } from "./admin/handler";
import { queryBudget } from "./budget";
import { loadConfig, type Config } from "./config";
import type { Env } from "./env";
import { fail } from "./http";
import { clearStaleLobbies, handleHostLobby } from "./lobby/handler";
import { createLogger, type Logger } from "./log";
import { isPrivate, isPublicRead, isPublicWrite, isSameOrigin, preflight, signupRoute, withPrivateHeaders, withPublicHeaders } from "./public";
import { updateRatings } from "./rating/update";
import { updateRecords } from "./records/update";
import { handleSite } from "./site/handler";
import { expireOld } from "./tourney/expiry";
import { handleHostTourneyLobby, handleHostTourneys } from "./tourney/host";
import { handleSignup } from "./tourney/signups";
import { handleHostMatches, handleHostMe, handleUpload } from "./upload/handler";

// Static files in public/ are served before the Worker runs, so this only sees the other paths.
export default {
  async fetch(request, env): Promise<Response> {
    const config = loadConfig(env);
    const log = createLogger(config.logLevel);
    const url = new URL(request.url);

    // A public write (a tourney sign-up): same origin only, never cached (src/public.ts).
    if (isPublicWrite(request.method, url.pathname)) {
      if (!isSameOrigin(request)) return withPrivateHeaders(fail(403, "cross_origin", "Sign up from the site's own pages"));
      return withPrivateHeaders(await route(request, env, config, log, url));
    }
    // Every public read route gets CORS and caching headers here, not in its handler (src/public.ts).
    if (isPublicRead(url.pathname)) {
      if (request.method === "OPTIONS") return preflight(config);
      return withPublicHeaders(request, await route(request, env, config, log, url), config);
    }
    // Routes behind a token: never kept by a browser or a shared cache.
    if (isPrivate(url.pathname)) return withPrivateHeaders(await route(request, env, config, log, url));
    return route(request, env, config, log, url);
  },

  // The cron in wrangler.toml: rates incomplete matches whose grace period has passed, and
  // recomputes the ratings when they're stale (docs/rating.md). Then keeps the records pages up to
  // date (src/records/update.ts, docs/database.md "Records"). Also retries queued screenshot
  // deletes and expires screenshots past screenshotKeepDays, when that's set (src/tourney/expiry.ts).
  // And deletes the live lobbies whose heartbeats stopped (src/lobby/handler.ts).
  async scheduled(controller, env): Promise<void> {
    const config = loadConfig(env);
    const log = createLogger(config.logLevel);
    const now = new Date(controller.scheduledTime);
    // D1's queries an invocation, less what the cleanup keeps (stale lobbies, screenshots): the
    // ratings and records count theirs and leave what might not fit to the next run.
    const queries = queryBudget(env.DB, config.d1QueriesPerInvocation - config.cronCleanupQueries);
    try {
      // One of the `cronCleanupQueries` kept back from the budget.
      await clearStaleLobbies(env.DB, config, now, log);
    } catch (error) {
      // Stale lobbies aren't listed anyway: the next run deletes them.
      log.error("stale lobby cleanup failed", { error: String(error) });
    }
    try {
      await updateRatings(queries.db, config, now, log, undefined, queries);
    } finally {
      try {
        // Records follow the ratings, but don't wait for them to succeed.
        await updateRecords(queries.db, config, now, log, queries);
      } finally {
        // Screenshot cleanup must keep retrying even when rating work fails.
        await expireOld(env.DB, env.PROOFS, config, now, log);
      }
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, config: Config, log: Logger, url: URL): Promise<Response> {
  if (url.pathname === "/api/health") {
    const db = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return Response.json({ ok: db?.ok === 1 }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/api/upload") {
    return handleUpload(request, env.DB, config, log);
  }

  if (url.pathname === "/api/host/me") {
    return handleHostMe(request, env.DB);
  }

  if (url.pathname === "/api/host/matches") {
    return handleHostMatches(request, env.DB, config);
  }

  if (url.pathname === "/api/host/lobby") {
    return handleHostLobby(request, env.DB, config, log);
  }

  if (url.pathname === "/api/host/tourneys") {
    return handleHostTourneys(request, env.DB, config, new Date());
  }

  if (url.pathname.startsWith("/api/host/lobbies/")) {
    return handleHostTourneyLobby(request, env.DB, env.PROOFS, config, log);
  }

  if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
    return handleAdmin(request, env.DB, env.PROOFS, config, log);
  }

  if (signupRoute.test(url.pathname)) {
    return handleSignup(request, env.DB, config, log);
  }

  if (url.pathname.startsWith("/api/")) {
    const site = await handleSite(request, env.DB, config, new Date(), env.PROOFS);
    if (site) return site;
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  log.debug("no asset or route", { path: url.pathname });
  return env.ASSETS.fetch(request);
}
