/**
 * Tourney verify screenshots (#28): the image types we take and their R2 keys. The type comes from
 * the file's first bytes, not from what the client says, so any tool's PNG, JPEG or WebP works and
 * nothing else is served back as an image.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/webp";

/** The image's type from its magic bytes, or `null` if it isn't a PNG, JPEG or WebP. */
export function imageType(bytes: Uint8Array): ImageType | null {
  const starts = (offset: number, ...sig: number[]) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  // RIFF....WEBP
  if (starts(0, 0x52, 0x49, 0x46, 0x46) && starts(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

const extensions: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** A new key for a lobby's screenshot. Random, so a replaced image gets a new URL and caches can keep it forever. */
export function screenshotKey(lobbyId: number, type: ImageType): string {
  const random = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `lobby-${lobbyId}-${random}.${extensions[type]}`;
}

/** Whether `key` has the shape `screenshotKey` makes: anything else isn't looked up in R2. */
export function isScreenshotKey(key: string): boolean {
  return /^lobby-[1-9]\d{0,15}-[0-9a-f]{16}\.(png|jpg|webp)$/.test(key);
}

/** The URL the site shows a screenshot at (`GET /api/screenshots/:key`). */
export function screenshotUrl(key: string | null): string | null {
  return key === null ? null : `/api/screenshots/${key}`;
}
