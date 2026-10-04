/** Bindings and vars from wrangler.toml. Every var is optional: src/config.ts has the defaults. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** R2: tourney verify screenshots (#28). */
  PROOFS: R2Bucket;
  LOG_LEVEL?: string;
  TEST_SERVER?: string;
  RATING_MATCHES_PER_RUN?: string;
}
