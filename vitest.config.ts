import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime with a local D1. Every migration is applied
// before each test file (test/setup.ts), so tests always see the current schema.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // RATING_MATCHES_PER_RUN: a test can fill more than one run without passing maxUploadsPerHour.
        // BOT_TOKEN: the Discord bot's secret, for /api/bot/*.
        // PUBLIC_EDGE_CACHE: off, or a read would get the answer an earlier test cached (test/public.test.ts turns it on).
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          RATING_MATCHES_PER_RUN: "10",
          BOT_TOKEN: "bot-token",
          PUBLIC_EDGE_CACHE: "false",
        },
        // BOT: the Discord bot's Worker isn't here; it answers with no titles (test/titles.test.ts brings its own).
        serviceBindings: { BOT: () => Response.json({ titles: [] }) },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
