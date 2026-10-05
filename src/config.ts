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

  /**
   * The regions, which play apart (#47): each has its own matches, leaderboard, hosts and tourneys.
   * `id` is what the API takes (`?region=`, `X-Region`) and the leaderboard's `board` in D1. The
   * first is the one a site read without `?region=` shows. A new region needs nothing else: its
   * rating state row is made the first time it's rated.
   */
  regions: [
    { id: "eu", label: "Europe" },
    { id: "na", label: "North America" },
  ] as Region[],

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
  /**
   * A match needs this many different players in its rated rounds, or it's rejected (`too_few_players`).
   * 2: a 1v1 counts. A match with no rated round at all (restarted at once, only `NONE` rounds) never does.
   */
  minMatchPlayers: 2,
  /** What happens to a match from an untrusted host: `review` (admins accept it) or `reject`. */
  untrustedHostUploads: "review" as "review" | "reject",
  /** Most match keys the host tool can ask the status of in one `GET /api/host/matches`. */
  hostMatchKeysMax: 50,

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
   * Damping: one round moves mu about 1/N as far as a full rated game would (sigma isn't damped).
   * Higher is a steadier leaderboard but a slower one to learn: a player keeps climbing toward their
   * real level for longer. 1 rates every round as a full game. On the v1.3.2 logs, 4 predicts rounds
   * as well as the old damping of 6 did with sigma damped too (docs/rating.md, "Tuning").
   */
  ratingRoundsPerMatch: 4,
  /**
   * The most display points anyone can gain or lose in one match (a tournament has its own cap). A
   * safety net: a long lobby against much weaker players can't lift a rating far in one evening.
   * On the v1.3.2 logs it barely changes how well rounds are predicted.
   */
  ratingMatchMaxChange: 150,

  /**
   * A match with no MATCH_END is rated once this many hours have passed since it started: until
   * then, a longer copy may still arrive. A complete match is rated as soon as it's uploaded.
   */
  ratingIncompleteGraceHours: 6,
  /**
   * Most matches rated in one go (one upload, one cron run); a longer recompute is spread over runs.
   * Rating costs about 0.5 ms of CPU a match. The Workers Standard plan allows 30 s an invocation,
   * so 100 is far inside it, and a run's history rows (about 150 bytes each, a dozen a match) stay
   * well under D1's 2 MB per bound value. On the free plan (10 ms CPU, 100k rows written a day),
   * set `RATING_MATCHES_PER_RUN = "10"`.
   */
  ratingMatchesPerRun: 100,

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
   * Tourneys page (#31): past tourneys per page, newest first. Each lobby's standings read its
   * match's rounds and events (about 600 rows), so a page of 10 two-lobby tourneys is about 12k rows.
   */
  tourneysPageSize: 10,
  /** Longest tourney notes an admin can enter, in characters. */
  tourneyNotesMaxLength: 1000,
  /**
   * Rounds a tourney lobby plays when an admin doesn't set its own round limit (#22, #24). The game's
   * tourney rule gets it from the host tool (GenjiBall-CE#143).
   */
  tourneyRoundLimit: 30,
  /** Highest round limit an admin can set: the game's "tournament rounds" setting goes up to 50. */
  tourneyRoundLimitMax: 50,
  /**
   * How long before a tourney's start its assigned hosts get the tourney code values (`lobbyKey`,
   * round limit) from `GET /api/host/tourneys`, in minutes (#25). They stay available until the
   * lobby has a match or the tourney is done or cancelled.
   */
  tourneyCodeLeadMinutes: 60,
  /** Random digits in a lobby's `lobbyKey`, the server's id for it in the game's tourney rule and log. */
  tourneyLobbyKeyDigits: 12,
  /** New lobby keys tried when adding a lobby, should one already be taken (about 1 in 10^12 per lobby). */
  tourneyLobbyKeyAttempts: 3,
  /** Largest verify screenshot (#28), in bytes. A 1440p PNG of the standings is about 2 MB. */
  screenshotMaxBytes: 8 * 1024 * 1024,
  /**
   * How long a browser may keep a verify screenshot, in seconds. A replaced screenshot gets a new
   * key, so an image never changes under its URL. Keep this bounded so removed screenshots age out
   * of existing browser and shared caches within an hour.
   */
  screenshotCacheSeconds: 60 * 60,
  /**
   * Storage caps for verify screenshots: past either one, the oldest are deleted after each upload
   * (the lobby keeps its result and verified mark). R2's free tier holds 10 GB; 8 GB leaves room.
   */
  screenshotsKept: 3000,
  screenshotStorageMaxBytes: 8 * 1024 * 1024 * 1024,
  /** Screenshots older than this many days are deleted by the cron. 0: kept until a cap is reached. */
  screenshotKeepDays: 0,
  /** Most screenshots the cron deletes in one run; the next run goes on. */
  screenshotExpiryBatch: 100,
  /** Staged uploads may attach for this long before orphan cleanup can delete their reserved key. */
  screenshotUploadGraceSeconds: 15 * 60,

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
   * Rated rounds a player needs before they show on the leaderboard and get a tier. Low, so someone
   * who drops into one lobby sees themselves on it; `ratingMatchMaxChange` keeps a lucky first match
   * from putting them high.
   */
  minRankedRounds: 3,
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
  /** Most players a name search (`/api/players?search=`) answers. 25 is what Discord's autocomplete shows. */
  playerSearchLimit: 25,
  /**
   * Fewest characters a name search takes. Each search reads every alias (a "contains" match can't
   * use an index), so one letter isn't allowed to match half the players.
   */
  playerSearchMinLength: 2,
  /** Most matches one read of the match feed (`/api/matches?after=`) answers. */
  matchFeedLimit: 20,
  /** How long a browser may keep a public read (leaderboard, player, match), in seconds. */
  publicCacheSeconds: 60,

  /**
   * Live lobbies (#11): how often the host tool sends a heartbeat while a ranked lobby is open, in
   * seconds. The heartbeat's answer says this, so the host tool follows the server. A heartbeat of an
   * open lobby is one row written, opening one two, closing one: a lobby open an hour is about 62
   * (docs/database.md, "Live lobbies").
   */
  lobbyHeartbeatSeconds: 60,
  /**
   * Shortest time between a host's heartbeat and its last heartbeat or close, in seconds. A sooner one
   * gets 429 and writes nothing. A close keeps the row, so a host tool gone wrong, even one closing
   * and reopening in a loop, can't cost more than 6 rows a minute.
   */
  lobbyHeartbeatMinSeconds: 30,
  /** A lobby with no heartbeat for this long is gone: it isn't listed, and the cron deletes it. Three missed heartbeats. */
  lobbyTtlSeconds: 180,
  /** Longest lobby name a heartbeat can send, in characters. */
  lobbyNameMaxLength: 64,
  /** Most players a heartbeat can report: an Overwatch custom game holds 12. */
  lobbyPlayersMax: 12,
  /** Largest heartbeat body, in bytes. The JSON is a few dozen. */
  lobbyBodyMaxBytes: 1024,
  /** How long a browser may keep the live lobby list (`/api/lobbies`), in seconds. */
  lobbiesCacheSeconds: 15,
};

export type Config = typeof defaults;
export type LogLevel = "error" | "info" | "debug";

export interface Region {
  /** Lowercase letters: `eu`. */
  id: string;
  label: string;
}

/** The region with this id, or null when it isn't one of `regions`. */
export function findRegion(regions: readonly Region[], id: string | null | undefined): Region | null {
  const key = id?.trim().toLowerCase();
  return regions.find((region) => region.id === key) ?? null;
}

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
  const matchesPerRun = Number(env.RATING_MATCHES_PER_RUN);
  if (Number.isInteger(matchesPerRun) && matchesPerRun > 0) config.ratingMatchesPerRun = matchesPerRun;
  return config;
}
