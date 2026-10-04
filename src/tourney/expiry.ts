import type { Config } from "../config";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import { expireScreenshots, listOlderThan, listOverCaps } from "./store";

/**
 * Keeps the verify screenshots inside their storage caps: at most `screenshotsKept` of them and
 * `screenshotStorageMaxBytes` in all, and none older than `screenshotKeepDays` when that's set. The
 * oldest go first. An expired screenshot leaves its lobby's result and verified mark as they were.
 */

export type ExpiryConfig = Pick<Config, "screenshotsKept" | "screenshotStorageMaxBytes" | "screenshotKeepDays" | "screenshotExpiryBatch">;

/** After an upload, the only time storage grows: applies every cap. Returns the keys deleted. */
export async function expireOverCaps(db: D1Database, proofs: R2Bucket, config: ExpiryConfig, now: Date, log: Logger): Promise<string[]> {
  const keys = await listOverCaps(db, config.screenshotsKept, config.screenshotStorageMaxBytes, cutoff(config, now));
  return remove(db, proofs, keys, now, log);
}

/** On the cron: deletes screenshots past `screenshotKeepDays`, through an index. Nothing to do when it's 0. */
export async function expireOld(db: D1Database, proofs: R2Bucket, config: ExpiryConfig, now: Date, log: Logger): Promise<string[]> {
  if (config.screenshotKeepDays <= 0) return [];
  const keys = await listOlderThan(db, cutoff(config, now), config.screenshotExpiryBatch);
  return remove(db, proofs, keys, now, log);
}

/** Screenshots taken before this are past `screenshotKeepDays`. `""` (before everything) when there's no age limit. */
function cutoff(config: ExpiryConfig, now: Date): string {
  if (config.screenshotKeepDays <= 0) return "";
  return isoSeconds(new Date(now.getTime() - config.screenshotKeepDays * 24 * 60 * 60 * 1000));
}

/** The rows first, then R2: a failed R2 delete leaves an orphan object, never a lobby pointing at nothing. */
async function remove(db: D1Database, proofs: R2Bucket, keys: string[], now: Date, log: Logger): Promise<string[]> {
  if (!keys.length) return keys;
  await expireScreenshots(db, keys, isoSeconds(now));
  try {
    // R2 deletes up to 1000 keys a call.
    for (let i = 0; i < keys.length; i += 1000) await proofs.delete(keys.slice(i, i + 1000));
  } catch (error) {
    log.error("screenshot expiry: R2 delete failed", { keys: keys.length, error: String(error) });
  }
  log.info("screenshot expiry", { deleted: keys.length });
  log.debug("screenshot expiry: keys", { keys });
  return keys;
}
