import type { LogLevel } from "./config";

const rank: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };

export interface Logger {
  error(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}

/** Logs to the Worker console (`wrangler tail`), dropping lines below `level`. */
export function createLogger(level: LogLevel): Logger {
  const at = (lineLevel: LogLevel) => (message: string, data?: unknown) => {
    if (rank[lineLevel] > rank[level]) return;
    const line = data === undefined ? { level: lineLevel, message } : { level: lineLevel, message, data };
    (lineLevel === "error" ? console.error : console.log)(JSON.stringify(line));
  };
  return { error: at("error"), info: at("info"), debug: at("debug") };
}
