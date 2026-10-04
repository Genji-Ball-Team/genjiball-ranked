import type { Config } from "../config";
import { fail } from "../http";
import type { Logger } from "../log";
import type { UpdateConfig } from "../rating/update";
import type { UploadConfig } from "../upload/handler";
import type { Admin } from "./store";

/** What every admin route gets, and the helpers they share to read a request and answer it. */

export type AdminConfig = UpdateConfig &
  UploadConfig &
  Pick<Config, "hostTokenBytes" | "adminListLimit" | "adminTextMaxLength" | "tourneyNotesMaxLength" | "screenshotMaxBytes">;

export interface Context {
  db: D1Database;
  /** R2: tourney verify screenshots. */
  proofs: R2Bucket;
  config: AdminConfig;
  log: Logger;
  admin: Admin;
  now: Date;
}

export class BadRequest extends Error {}

/** The JSON object body, or `{}` when there's none. */
export async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new BadRequest("The body must be JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new BadRequest("The body must be a JSON object");
  return data as Record<string, unknown>;
}

/** An optional text field, trimmed. `null` when it's missing or blank. */
export function text(value: unknown, config: AdminConfig, field: string, max = config.adminTextMaxLength): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BadRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new BadRequest(`${field} is longer than ${max} characters`);
  return trimmed || null;
}

export function notAllowed(allow: string): Response {
  return fail(405, "method_not_allowed", `Use ${allow}`, { Allow: allow });
}

export function changedMeanwhile(): Response {
  return fail(409, "conflict", "Another admin changed it at the same time. Reload and try again");
}
