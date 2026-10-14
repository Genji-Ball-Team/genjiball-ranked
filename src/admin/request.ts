import type { QueryBudget } from "../budget";
import { findRegion, type Config } from "../config";
import { fail } from "../http";
import type { Logger } from "../log";
import { anyStale } from "../rating/store";
import { updateRatings, type UpdateConfig } from "../rating/update";
import type { ExpiryConfig } from "../tourney/expiry";
import type { UploadConfig } from "../upload/handler";
import type { Admin } from "./store";

/** What every admin route gets, and the helpers they share to read a request and answer it. */

export type AdminConfig = UpdateConfig &
  UploadConfig &
  ExpiryConfig &
  Pick<
    Config,
    | "hostTokenBytes"
    | "adminListLimit"
    | "adminTextMaxLength"
    | "tourneyNotesMaxLength"
    | "screenshotMaxBytes"
    | "tourneyRoundLimit"
    | "tourneyRoundLimitMax"
    | "tourneyLobbyCapacity"
    | "tourneyLobbyCapacityMax"
    | "tourneyLobbyKeyDigits"
    | "tourneyLobbyKeyAttempts"
    | "playerNameMaxLength"
    | "playerMergeMaxPairRows"
    | "playerSearchMinLength"
  >;

export interface Context {
  /** Counts its queries (`queries`). */
  db: D1Database;
  /** The request's D1 queries, from its first (`queriesPerRequest`). */
  queries: QueryBudget;
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

/** A region id from the config's `regions`. */
export function regionField(value: unknown, config: AdminConfig, field: string): string {
  const region = typeof value === "string" ? findRegion(config.regions, value) : null;
  if (!region) throw new BadRequest(`${field} must be one of ${config.regions.map((r) => r.id).join(", ")}`);
  return region.id;
}

export function notAllowed(allow: string): Response {
  return fail(405, "method_not_allowed", `Use ${allow}`, { Allow: allow });
}

/**
 * After an admin change to matches that may be rated: brings the regions' ratings up to date as far
 * as the request's D1 queries go, like a cron run, keeping one for the stale check (no `regions`:
 * nothing to rate). The cron finishes the rest. Returns whether the ratings are still stale.
 */
export async function rerate(ctx: Context, regions: readonly string[], about: Record<string, unknown>): Promise<boolean> {
  try {
    if (regions.length) await updateRatings(ctx.db, ctx.config, ctx.now, ctx.log, regions, { ...ctx.queries, left: () => ctx.queries.left() - 1 });
    return await anyStale(ctx.db);
  } catch (error) {
    // The change is stored; the cron rates or recomputes.
    ctx.log.error("rating after admin action failed", { ...about, error: String(error) });
    return true;
  }
}

export function changedMeanwhile(): Response {
  return fail(409, "conflict", "Another admin changed it at the same time. Reload and try again");
}
