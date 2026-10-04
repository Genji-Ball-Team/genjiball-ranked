import type { Config } from "../config";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import { expireScreenshots, forgetScreenshots, listOlderThan, listOverCaps, pendingScreenshots } from "./store";

/**
 * Keeps the verify screenshots inside their storage caps: at most `screenshotsKept` of them and
 * `screenshotStorageMaxBytes` in all, and none older than `screenshotKeepDays` when that's set. The
 * oldest go first. An expired screenshot leaves its lobby's result and verified mark as they were.
 */

export type ExpiryConfig = Pick<Config, "screenshotsKept" | "screenshotStorageMaxBytes" | "screenshotKeepDays" | "screenshotExpiryBatch" | "screenshotUploadGraceSeconds">;

/** After an upload, the only time storage grows: applies every cap. Returns the keys deleted. */
export async function expireOverCaps(db: D1Database, proofs: R2Bucket, config: ExpiryConfig, now: Date, log: Logger): Promise<string[]> {
  await flushScreenshotDeletions(db, proofs, config, log, now);
  const keys = await listOverCaps(db, config.screenshotsKept, config.screenshotStorageMaxBytes, cutoff(config, now));
  return remove(db, proofs, keys, config, now, log);
}

/** On the cron: deletes screenshots past `screenshotKeepDays`, through an index. Nothing to do when it's 0. */
export async function expireOld(db: D1Database, proofs: R2Bucket, config: ExpiryConfig, now: Date, log: Logger): Promise<string[]> {
  await flushScreenshotDeletions(db, proofs, config, log, now);
  if (config.screenshotKeepDays <= 0) return [];
  const keys = await listOlderThan(db, cutoff(config, now), config.screenshotExpiryBatch);
  return remove(db, proofs, keys, config, now, log);
}

/** Screenshots taken before this are past `screenshotKeepDays`. `""` (before everything) when there's no age limit. */
function cutoff(config: ExpiryConfig, now: Date): string {
  if (config.screenshotKeepDays <= 0) return "";
  return isoSeconds(new Date(now.getTime() - config.screenshotKeepDays * 24 * 60 * 60 * 1000));
}

/** Retries a bounded batch of pending deletes, retaining every failed key for the next run. */
export async function flushScreenshotDeletions(db: D1Database, proofs: R2Bucket, config: ExpiryConfig, log: Logger, now = new Date()): Promise<void> {
  const keys = await pendingScreenshots(db, config.screenshotExpiryBatch, isoSeconds(now));
  if (!keys.length) return;
  try {
    // R2 deletes up to 1000 keys a call (the platform limit).
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await proofs.delete(batch);
      await forgetScreenshots(db, batch);
    }
  } catch (error) {
    log.error("screenshot cleanup: delete failed", { keys: keys.length, error: String(error) });
  }
}

/** Queue and detach in one D1 batch, then delete R2 objects. Failures stay queued and counted. */
async function remove(db: D1Database, proofs: R2Bucket, keys: string[], config: ExpiryConfig, now: Date, log: Logger): Promise<string[]> {
  if (!keys.length) return keys;
  await expireScreenshots(db, keys, isoSeconds(now));
  await flushScreenshotDeletions(db, proofs, config, log, now);
  log.info("screenshot expiry", { expired: keys.length });
  log.debug("screenshot expiry: keys", { keys });
  return keys;
}
