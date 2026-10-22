/* global console, process */
import { statSync } from "node:fs";
import { basename } from "node:path";

/** Exits unless `url` (the user's `server`) is https, or http to this computer: the token goes in a header. */
export function requireSecureServer(url, server) {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    console.error(`Use an https:// server URL (http:// only for localhost), not ${server}`);
    process.exit(1);
  }
}

/** When a Workshop log was started: from its file name (this computer's time zone), else its modified time. */
export function startedAt(file) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(basename(file));
  return m ? new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : statSync(file).mtime;
}
