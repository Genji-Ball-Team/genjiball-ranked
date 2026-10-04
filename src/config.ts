import type { Env } from "./env";

/**
 * Every tunable of the server, with its default. Nothing else in src/ hard-codes one of these
 * numbers: read it from the config. A wrangler.toml var with the same name in SCREAMING_SNAKE_CASE
 * overrides the default (see `loadConfig`).
 */
export const defaults = {
  /** error, info or debug. debug logs every parsed line and why a match was rejected. */
  logLevel: "info" as LogLevel,
  /**
   * The test server (test environment in wrangler.toml, #37): every page shows a banner saying its
   * ratings aren't real. `TEST_SERVER = "true"` turns it on.
   */
  testServer: false,

  /** Log format versions (the `format` field of `GBR`) the parser accepts. */
  acceptedLogFormats: [1] as number[],

  /**
   * Largest log file the upload endpoint takes, in bytes. A match is about 30 KB and a new match
   * starts its own file, so this is plenty; it also keeps one upload inside the free plan's CPU time
   * and its 50 queries per request (see docs/database.md).
   */
  maxUploadBytes: 512 * 1024,
  /** Stored uploads per host token per hour. Past it, uploads get 429 until the hour has passed. */
  maxUploadsPerHour: 60,
  /** Rows per bulk insert statement. Smaller is more statements; bigger risks D1's size limits. */
  insertChunkRows: 2000,
  /** A match needs this many different players in its rated rounds, or it's rejected (`too_few_players`). */
  minMatchPlayers: 4,
  /** What happens to a match from an untrusted host: `review` (admins accept it) or `reject`. */
  untrustedHostUploads: "review" as "review" | "reject",

  /**
   * Legacy v1.3.2 logs (#4, docs/legacy.md). A round one of these AI bots played in isn't rated: new
   * logs reject a whole match with a bot, but a legacy file is often a long lobby where a bot was in
   * only some rounds.
   */
  legacyBotNames: ["Genji Bot", "zSh4d0Ws bozo"] as string[],
  /** `game_version` stored for a legacy match: the log doesn't say. */
  legacyGameVersion: "1.3.2",
  /**
   * Shortest time between a legacy round's last death and the next round's first, in seconds: the
   * game waits 2.25 s and counts down 5 s, and the ball still has to fly. Deaths closer together
   * are in one round. Real v1.3.2 logs never go below 7.6 s between rounds.
   */
  legacyRoundGapSeconds: 7,
  /** v1.3.2 resurrects everyone this many seconds after a round is won (0.25 s and 2 s waits). */
  legacyResurrectSeconds: 2.25,

  /** Random bytes in a new host token (shown once, as hex). 32 bytes can't be guessed. */
  hostTokenBytes: 32,
  /** Most rows an admin list returns (matches, hosts, actions). The newest come first. */
  adminListLimit: 100,
  /** Longest host name or reason an admin can enter, in characters. */
  adminTextMaxLength: 200,

  /**
   * OpenSkill (Plackett-Luce) parameters for the ratings (`src/rating/`). A new player starts at
   * `ratingMu` ± `ratingSigma`; `ratingBeta` is how much one performance varies around the skill.
   * These are openskill's defaults (`npm run tune:rating` found no better beta on the v1.3.2 logs).
   */
  ratingMu: 25,
  ratingSigma: 25 / 3,
  ratingBeta: 25 / 6,
  /** Uncertainty added per match's worth of rounds, so ratings can still move after many games. */
  ratingTau: 25 / 100,
  /**
   * Damping: one round moves a rating about 1/N of what a full rated game would. Higher is a
   * steadier leaderboard but a slower one to learn: a player keeps climbing toward their real level
   * for longer. 1 rates every round as a full game. On the v1.3.2 logs, 6 predicts rounds nearly as
   * well as 1 to 5 (docs/rating.md, "Tuning"), and players reach their level sooner than at 10+.
   */
  ratingRoundsPerMatch: 6,

  /**
   * A match with no MATCH_END is rated once this many hours have passed since it started: until
   * then, a longer copy may still arrive. A complete match is rated as soon as it's uploaded.
   */
  ratingIncompleteGraceHours: 6,
  /**
   * Most matches rated in one go (one upload, one cron run). Rating costs about 0.5 ms of CPU a
   * match and the free plan allows 10 ms an invocation, so a long recompute is spread over runs.
   */
  ratingMatchesPerRun: 10,

  /**
   * Display rating: an Elo-like number for the leaderboard and the tiers, from the conservative
   * rating mu − z·sigma. A new player shows `displayCenter`; above it each point of mu is worth
   * `displayScale`. Below it the number eases toward `displayFloor` and never reaches it: a bad
   * player settles in the 900s instead of sinking, and climbs again as they improve (the curve has
   * the same slope on both sides of the center). `displayZ` is 0, so a player's number follows mu
   * alone and doesn't drift up as sigma shrinks.
   */
  displayZ: 0,
  displayCenter: 1000,
  displayScale: 70,
  displayFloor: 900,

  /**
   * Tournaments: a match an admin marks as a tournament counts `tournamentWeight` times a normal
   * one, because each of its rounds is damped to 1/(`ratingRoundsPerMatch` ÷ weight). Tournaments are
   * rare and meant to matter, so a good one climbs fast.
   */
  tournamentWeight: 3,
  /**
   * The most display points anyone can gain or lose in one tournament. The cap is the same both
   * ways, so tournaments don't add points to the ladder: one bad or lucky tournament can't swing a
   * rating too far, and the rating already expects a weak player to finish behind strong ones.
   */
  tournamentMaxChange: 200,

  /**
   * Tiers with a rank tag in game and on the site, lowest first. A player is in the highest tier
   * whose threshold their display rating reaches; below the first, no tier. Labels and colours
   * (Apprentice is new) match GenjiBall-CE v1.3.3R `src/features/rank-tags.opy`.
   */
  tiers: [
    { label: "Apprentice", color: [205, 127, 50], threshold: 1300 },
    { label: "Master", color: [255, 215, 0], threshold: 1600 },
    { label: "Grandmaster", color: [255, 140, 0], threshold: 1900 },
    { label: "Ascendant", color: [60, 160, 255], threshold: 2200 },
    { label: "Champion", color: [150, 0, 0], threshold: 2500 },
    { label: "God", color: [160, 160, 160], threshold: 2800 },
  ] as Tier[],

  /**
   * Rated rounds a player needs before they show on the leaderboard and get a tier: until then they
   * are provisional, so a newcomer's lucky start isn't shown. On the v1.3.2 logs, a player is rarely
   * above where they end up after 20 rounds (docs/rating.md, "Tuning").
   */
  minRankedRounds: 20,
  /**
   * A player with no rated round in this many days is inactive: they stay on the leaderboard with
   * an "Inactive since <last played>" mark, and get no rank tag in game.
   */
  inactiveAfterDays: 30,
  /** Players per leaderboard page. */
  leaderboardPageSize: 50,
  /** Matches on a player page, newest first. */
  playerRecentMatches: 20,
  /**
   * Most names in the rank tags (`/api/rank-tags`), the best ones. Each costs Workshop elements;
   * GenjiBall-CE docs/rank-tags.md asks for under about 500.
   */
  rankTagsMaxNames: 500,
  /** How long the rank tags may be cached, in seconds. Tags only need to change about once a day. */
  rankTagsCacheSeconds: 60 * 60,
  /** How long a browser may keep a public read (leaderboard, player, match), in seconds. */
  publicCacheSeconds: 60,
};

export type Config = typeof defaults;
export type LogLevel = "error" | "info" | "debug";

export interface Tier {
  label: string;
  /** RGB, 0–255. */
  color: [number, number, number];
  /** Lowest display rating in the tier. */
  threshold: number;
}

const logLevels: readonly LogLevel[] = ["error", "info", "debug"];

/** The config for one request: the defaults, overridden by the vars that are set. */
export function loadConfig(env: Partial<Env>): Config {
  const config = structuredClone(defaults);
  const logLevel = env.LOG_LEVEL?.trim().toLowerCase();
  if (logLevel && (logLevels as string[]).includes(logLevel)) {
    config.logLevel = logLevel as LogLevel;
  }
  if (env.TEST_SERVER !== undefined) config.testServer = env.TEST_SERVER.trim().toLowerCase() === "true";
  return config;
}
