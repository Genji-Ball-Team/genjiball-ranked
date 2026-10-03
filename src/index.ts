import { loadConfig } from "./config";
import type { Env } from "./env";
import { createLogger } from "./log";
import { updateRatings } from "./rating/update";
import { handleUpload } from "./upload/handler";

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

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    log.debug("no asset or route", { path: url.pathname });
    return env.ASSETS.fetch(request);
  },

  // The cron in wrangler.toml: rates incomplete matches whose grace period has passed, and
  // recomputes the ratings when they're stale (docs/rating.md).
  async scheduled(controller, env): Promise<void> {
    const config = loadConfig(env);
    await updateRatings(env.DB, config, new Date(controller.scheduledTime), createLogger(config.logLevel));
  },
} satisfies ExportedHandler<Env>;
