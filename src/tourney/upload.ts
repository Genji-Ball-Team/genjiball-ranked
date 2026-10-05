import type { Config } from "../config";
import { fail } from "../http";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import { readLimited } from "../upload/handler";
import { expireOverCaps, flushScreenshotDeletions, type ExpiryConfig } from "./expiry";
import { imageType, screenshotKey, type ImageType } from "./screenshot";
import { isLobbyChanged, queueScreenshot, setScreenshot, stageScreenshot, type LobbyLog, type LobbyRow } from "./store";

/**
 * Storing and deleting a lobby's verify screenshot (#28), for the admin API and the lobby's assigned
 * host alike: the same size and type limits, R2 key reservation, expiry and conflict handling.
 */

export type ScreenshotConfig = ExpiryConfig & Pick<Config, "screenshotMaxBytes">;

export interface ScreenshotContext {
  db: D1Database;
  proofs: R2Bucket;
  config: ScreenshotConfig;
  log: Logger;
  now: Date;
}

/**
 * Stores the request's body (PNG, JPEG or WebP, at most `screenshotMaxBytes`) as the lobby's
 * screenshot, replacing the old one, then applies the storage caps. `logFor` is the action to log,
 * given the image's size and type. Returns the error response, or how many screenshots expired.
 */
export async function storeScreenshot(
  c: ScreenshotContext,
  lobby: LobbyRow,
  request: Request,
  logFor: (image: { bytes: number; type: ImageType }) => LobbyLog,
): Promise<Response | { expired: number; bytes: number; type: ImageType }> {
  const max = c.config.screenshotMaxBytes;
  const tooLarge = () => fail(413, "too_large", `The image is larger than ${max} bytes`);
  if (Number(request.headers.get("Content-Length") ?? 0) > max) return tooLarge();
  const bytes = await readLimited(request, max);
  if (!bytes) return tooLarge();
  if (!bytes.length) return fail(400, "empty", "The body is empty: send the image");
  const type = imageType(bytes);
  if (!type) return fail(415, "unsupported_type", "Send a PNG, JPEG or WebP image");

  const key = screenshotKey(lobby.id, type);
  await flushScreenshotDeletions(c.db, c.proofs, c.config, c.log);
  if (!(await stageScreenshot(c.db, key, bytes.length, new Date(), c.config))) {
    return fail(409, "conflict", "Screenshot cleanup is pending and storage is full. Try again after cleanup succeeds");
  }
  try {
    await c.proofs.put(key, bytes, { httpMetadata: { contentType: type } });
    await setScreenshot(c.db, lobby, key, bytes.length, logFor({ bytes: bytes.length, type }));
  } catch (error) {
    // Keep failed or conflicting uploads discoverable even if R2 cleanup fails.
    await queueScreenshot(c.db, key, bytes.length, isoSeconds(new Date()));
    await flushScreenshotDeletions(c.db, c.proofs, c.config, c.log);
    if (isLobbyChanged(error)) return changed();
    throw error;
  }
  let expired: string[] = [];
  try {
    expired = await expireOverCaps(c.db, c.proofs, c.config, c.now, c.log);
  } catch (error) {
    // The upload is stored; the next upload tries again.
    c.log.error("screenshot expiry failed", { lobby: lobby.id, error: String(error) });
  }
  return { expired: expired.length, bytes: bytes.length, type };
}

/** Deletes the lobby's screenshot (R2 cleanup is queued in the same transaction). Returns the error response, or null. */
export async function deleteScreenshot(c: ScreenshotContext, lobby: LobbyRow, log: LobbyLog): Promise<Response | null> {
  if (!lobby.screenshotKey) return fail(409, "conflict", "The lobby has no screenshot");
  try {
    await setScreenshot(c.db, lobby, null, null, log);
  } catch (error) {
    if (isLobbyChanged(error)) return changed();
    throw error;
  }
  await flushScreenshotDeletions(c.db, c.proofs, c.config, c.log);
  return null;
}

function changed(): Response {
  return fail(409, "conflict", "The lobby changed at the same time. Reload and try again");
}
