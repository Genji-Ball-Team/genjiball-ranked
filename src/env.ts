/** Bindings and vars from wrangler.toml. Every var is optional: src/config.ts has the defaults. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LOG_LEVEL?: string;
  TEST_SERVER?: string;
}
