import type { Env } from "./env";

/**
 * Every tunable of the server, with its default. Nothing else in src/ hard-codes one of these
 * numbers: read it from the config. A wrangler.toml var with the same name in SCREAMING_SNAKE_CASE
 * overrides the default (see `fromEnv`).
 */
export const defaults = {
  /** error, info or debug. debug logs every parsed line and why a match was rejected. */
  logLevel: "info" as LogLevel,

  /** Log format versions (the `format` field of `GBR`) the parser accepts. */
  acceptedLogFormats: [1] as number[],
};

export type Config = typeof defaults;
export type LogLevel = "error" | "info" | "debug";

const logLevels: readonly LogLevel[] = ["error", "info", "debug"];

/** The config for one request: the defaults, overridden by the vars that are set. */
export function loadConfig(env: Partial<Env>): Config {
  const config = structuredClone(defaults);
  const logLevel = env.LOG_LEVEL?.trim().toLowerCase();
  if (logLevel && (logLevels as string[]).includes(logLevel)) {
    config.logLevel = logLevel as LogLevel;
  }
  return config;
}
