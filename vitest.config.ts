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
        bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations"), RATING_MATCHES_PER_RUN: "10", BOT_TOKEN: "bot-token" },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
