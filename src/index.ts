import { loadConfig } from "./config";
import type { Env } from "./env";
import { createLogger } from "./log";

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

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    log.debug("no asset or route", { path: url.pathname });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
