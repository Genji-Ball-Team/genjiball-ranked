/** Bindings and vars from wrangler.toml. Every var is optional: src/config.ts has the defaults. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** R2: tourney verify screenshots (#28). */
  PROOFS: R2Bucket;
  LOG_LEVEL?: string;
  TEST_SERVER?: string;
  RATING_MATCHES_PER_RUN?: string;
  /** Secret: the Discord bot's token for `/api/bot/*` (`wrangler secret put BOT_TOKEN`). Unset: those routes refuse everyone. */
  BOT_TOKEN?: string;
  /** Service binding to the Discord bot's Worker, for who has a title (`src/site/titles.ts`). Unset: no titles. */
  BOT?: Fetcher;
}
