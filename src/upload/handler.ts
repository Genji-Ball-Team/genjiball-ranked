import type { Config } from "../config";
import { fail, type ApiError } from "../http";
import type { Logger } from "../log";
import { parseLegacyLog } from "../parser/legacy";
import { parseLog } from "../parser/parse";
import type { ParsedMatch } from "../parser/types";
import { rateNewMatches, type UpdateConfig } from "../rating/update";
import { isoSeconds } from "../time";
import { matchRows, planUpload, type MatchAction, type MatchPlan, type MatchStatus } from "./plan";
import { countRecentUploads, findHost, findStoredCopies, findUploadByHash, writeUpload, type Host } from "./store";

/**
 * `POST /api/upload`: the host tool sends a Workshop log file (#5).
 *
 * - Body: the file's text. `Authorization: Bearer <host token>`.
 * - `X-Log-File` (optional): the file name, `Log-<date>-<time>.txt`.
 * - `X-Log-Started-At` (optional): when the file was started, ISO 8601 with a time zone. The file
 *   name has no time zone, so the host tool sends this; without it, the upload time is used.
 *
 * The response says what happened to each match in the file (`UploadResponse`).
 */

export interface UploadResponse {
  /**
   * `stored`: the file was stored and at least one match was new or longer than before.
   * `unchanged`: every match was already stored as long or longer; nothing was written.
   * `duplicate`: this exact file was uploaded before.
   */
  result: "stored" | "unchanged" | "duplicate";
  uploadId: number | null;
  matches: MatchResult[];
}

export interface MatchResult {
  matchKey: string;
  lineCount: number;
  /** `insert`: new. `replace`: longer than the stored copy. `repoint`/`skip`: the stored copy stays. */
  action: MatchAction;
  /** The match's status now: `accepted` counts, `review` waits for an admin, `rejected` never counts. */
  status: MatchStatus;
  rejection: { code: string; message: string } | null;
  reviewReasons: string[];
}

export type UploadError = ApiError;

export type UploadConfig = UpdateConfig &
  Pick<
    Config,
    | "acceptedLogFormats"
    | "maxUploadBytes"
    | "maxUploadsPerHour"
    | "insertChunkRows"
    | "minMatchPlayers"
    | "untrustedHostUploads"
    | "legacyBotNames"
    | "legacyGameVersion"
    | "legacyRoundGapSeconds"
    | "legacyResurrectSeconds"
  >;

const hourMs = 60 * 60 * 1000;

export async function handleUpload(request: Request, db: D1Database, config: UploadConfig, log: Logger): Promise<Response> {
  if (request.method !== "POST") {
    return fail(405, "method_not_allowed", "Use POST", { Allow: "POST" });
  }

  const host = await authHost(request, db);
  if (host instanceof Response) return host;

  const now = new Date();
  const recent = await countRecentUploads(db, host.id, isoSeconds(new Date(now.getTime() - hourMs)));
  if (recent >= config.maxUploadsPerHour) {
    log.info("upload rate limited", { host: host.id, recent });
    return fail(429, "rate_limited", `At most ${config.maxUploadsPerHour} uploads an hour`, { "Retry-After": "3600" });
  }

  const bytes = await readBody(request, config);
  if (bytes instanceof Response) return bytes;
  return storeLog(db, config, log, { host, bytes, request, now, legacy: false });
}

/**
 * `GET /api/host/me`: checks a host token, for the host tool's settings screen.
 * `{ host: { id, name, trust } }`, or the 401 / 403 an upload with that token would get.
 */
export async function handleHostMe(request: Request, db: D1Database): Promise<Response> {
  if (request.method !== "GET") {
    return fail(405, "method_not_allowed", "Use GET", { Allow: "GET" });
  }
  const host = await authHost(request, db);
  if (host instanceof Response) return host;
  return Response.json({ host: { id: host.id, name: host.name, trust: host.trust } });
}

/** The host whose token the request carries, or the error: no or unknown token (401), revoked (403). */
async function authHost(request: Request, db: D1Database): Promise<Host | Response> {
  const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim();
  if (!token) return fail(401, "unauthorized", "Send the host token as Authorization: Bearer <token>");
  const host = await findHost(db, await sha256(token));
  if (!host) return fail(401, "unauthorized", "Unknown host token");
  if (host.trust === "revoked") return fail(403, "revoked", "This host token has been revoked");
  return host;
}

export interface StoreLog {
  host: Host;
  bytes: Uint8Array;
  /** For `X-Log-File` and `X-Log-Started-At`. */
  request: Request;
  now: Date;
  /** A v1.3.2 log, imported by an admin (#13): read with the legacy parser. */
  legacy: boolean;
  /** Written in the upload's transaction (the admin action log of an import). */
  extra?: (db: D1Database) => D1PreparedStatement[];
}

/** The file's body, or the error response when it's empty or too large. */
export async function readBody(request: Request, config: Pick<Config, "maxUploadBytes">): Promise<Uint8Array | Response> {
  const declaredSize = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredSize > config.maxUploadBytes) return tooLarge(config);
  const bytes = await readLimited(request, config.maxUploadBytes);
  if (!bytes) return tooLarge(config);
  if (!bytes.length) return fail(400, "empty", "The body is empty: send the log file's text");
  return bytes;
}

/** Parses a log file and stores its matches: the upload endpoint and the legacy import share it. */
export async function storeLog(db: D1Database, config: UploadConfig, log: Logger, s: StoreLog): Promise<Response> {
  const { host, bytes, request, now } = s;
  const contentHash = await sha256(bytes);
  const existing = await findUploadByHash(db, contentHash);
  if (existing) {
    log.debug("duplicate upload", { host: host.id, upload: existing.id });
    return Response.json({ result: "duplicate", uploadId: existing.id, matches: [] } satisfies UploadResponse);
  }

  const text = new TextDecoder().decode(bytes);
  let parsedMatches: ParsedMatch[];
  if (s.legacy) {
    const match = parseLegacyLog(text, {
      botNames: config.legacyBotNames,
      gameVersion: config.legacyGameVersion,
      roundGapSeconds: config.legacyRoundGapSeconds,
      resurrectSeconds: config.legacyResurrectSeconds,
    });
    if (!match) return fail(422, "not_legacy", "No KILL line: this isn't a v1.3.2 log");
    if (parseLog(text, { acceptedFormats: config.acceptedLogFormats }).matches.length) {
      return fail(422, "not_legacy", "This file has a GBR line: upload it as a ranked log, not a legacy one");
    }
    // Legacy logs have no matchKey. Each file is its own match, keyed by its content; the import
    // script leaves out a file that's the start of a longer one (docs/legacy.md).
    parsedMatches = [{ ...match, matchKey: `legacy-${contentHash.slice(0, 16)}` }];
  } else {
    const parsed = parseLog(text, { acceptedFormats: config.acceptedLogFormats });
    if (!parsed.matches.length) {
      return parsed.legacy
        ? fail(422, "legacy_log", "This is a v1.3.2 log (KILL lines, no GBR). Old logs are imported by an admin, not uploaded")
        : fail(422, "not_ranked", "No GBR line: this file has no ranked match");
    }
    parsedMatches = parsed.matches;
  }

  const keys = parsedMatches.map((m) => m.matchKey).filter((key) => key !== "");
  const stored = await findStoredCopies(db, host.id, keys);
  const plans = planUpload(parsedMatches, stored, host.trust, config);
  for (const plan of plans) {
    log.debug("match", {
      matchKey: plan.matchKey,
      action: plan.action,
      status: plan.status,
      lines: plan.lineCount,
      rejection: plan.rejection,
      review: plan.reviewReasons,
      problems: plan.match.problems,
    });
  }

  const matches = plans.map(result);
  if (!plans.some((p) => p.action === "insert" || p.action === "replace")) {
    return Response.json({ result: "unchanged", uploadId: null, matches } satisfies UploadResponse);
  }

  const receivedAt = isoSeconds(now);
  const playedAt = startedAt(request.headers.get("X-Log-Started-At"), now) ?? receivedAt;
  let uploadId: number;
  try {
    uploadId = await writeUpload(db, {
      hostId: host.id,
      contentHash,
      rawLog: await gzip(bytes),
      rawSize: bytes.length,
      fileName: request.headers.get("X-Log-File")?.trim().slice(0, 255) || null,
      playedAt,
      now: receivedAt,
      plans,
      rows: matchRows(plans, playedAt),
      chunkRows: config.insertChunkRows,
      extra: s.extra?.(db) ?? [],
    });
  } catch (error) {
    // Another upload of the same file or match was written between our reads and this write.
    // Nothing was written (the batch is one transaction); trying again sees the other upload.
    if (String(error).includes("UNIQUE constraint failed")) {
      log.info("upload conflict", { host: host.id, error: String(error) });
      return fail(409, "conflict", "Another upload of this match was being stored at the same time. Try again");
    }
    throw error;
  }
  log.info("upload stored", { host: host.id, upload: uploadId, matches: matches.map((m) => `${m.matchKey}:${m.action}:${m.status}`) });

  if (plans.some((p) => (p.action === "insert" || p.action === "replace") && p.status === "accepted")) {
    try {
      await rateNewMatches(db, config, now, log);
    } catch (error) {
      // The match is stored and still unrated: the cron rates it.
      log.error("rating after upload failed", { upload: uploadId, error: String(error) });
    }
  }
  return Response.json({ result: "stored", uploadId, matches } satisfies UploadResponse);
}

function result(plan: MatchPlan): MatchResult {
  return {
    matchKey: plan.matchKey,
    lineCount: plan.lineCount,
    action: plan.action,
    status: plan.status,
    rejection: plan.rejection,
    reviewReasons: plan.reviewReasons,
  };
}

function tooLarge(config: Pick<Config, "maxUploadBytes">): Response {
  return fail(413, "too_large", `The file is larger than ${config.maxUploadBytes} bytes`);
}

/**
 * The body, or `null` once it passes `limit` bytes. Counts what is read, since a chunked request has
 * no `Content-Length`, and stops reading there.
 */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** `X-Log-Started-At`, if it's a valid time that isn't in the future. */
function startedAt(header: string | null, now: Date): string | null {
  if (!header) return null;
  const time = new Date(header);
  if (Number.isNaN(time.getTime()) || time > now) return null;
  return isoSeconds(time);
}

export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
