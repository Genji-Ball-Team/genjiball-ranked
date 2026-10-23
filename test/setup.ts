import { applyD1Migrations, env } from "cloudflare:test";
import { defaults } from "../src/config";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The test logs have two-round matches, which would rate nobody with the first 3 rounds unrated.
// Tests rate every round; the ones for `ratingUnratedRounds` set it themselves.
defaults.ratingUnratedRounds = 0;
