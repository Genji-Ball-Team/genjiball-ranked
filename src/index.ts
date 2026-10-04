import { handleAdmin } from "./admin/handler";
import { loadConfig } from "./config";
import type { Env } from "./env";
import { createLogger } from "./log";
import { updateRatings } from "./rating/update";
import { handleSite } from "./site/handler";
import { expireOld } from "./tourney/expiry";
import { handleHostMatches, handleHostMe, handleUpload } from "./upload/handler";

// Static files in public/ are served before the Worker runs, so this only sees the other paths.
export default {
  async fetch(request, env): Promise<Response> {
    const config = loadConfig(env);
    const log = createLogger(config.logLevel);
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const db = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return Response.json({ ok: db?.ok === 1 });
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

    if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
      return handleAdmin(request, env.DB, env.PROOFS, config, log);
    }

    if (url.pathname.startsWith("/api/")) {
      const site = await handleSite(request, env.DB, config, new Date(), env.PROOFS);
      if (site) return site;
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    log.debug("no asset or route", { path: url.pathname });
    return env.ASSETS.fetch(request);
  },

  // The cron in wrangler.toml: rates incomplete matches whose grace period has passed, and
  // recomputes the ratings when they're stale (docs/rating.md). Also retries queued screenshot
  // deletes and expires screenshots past screenshotKeepDays, when that's set (src/tourney/expiry.ts).
  async scheduled(controller, env): Promise<void> {
    const config = loadConfig(env);
    const log = createLogger(config.logLevel);
    const now = new Date(controller.scheduledTime);
    try {
      await updateRatings(env.DB, config, now, log);
    } finally {
      // Screenshot cleanup must keep retrying even when rating work fails.
      await expireOld(env.DB, env.PROOFS, config, now, log);
    }
  },
} satisfies ExportedHandler<Env>;
