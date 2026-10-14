/** An API error: `{ "error": "<code>", "message": "<for people>" }` (docs/api.md). */
export interface ApiError {
  error: string;
  message: string;
}

export function fail(status: number, error: string, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error, message } satisfies ApiError, { status, headers });
}

/** The 405 for a method the route doesn't take. `allow` is the `Allow` header: `GET, POST`. */
export function notAllowed(allow: string, message = `Use ${allow}`): Response {
  return fail(405, "method_not_allowed", message, { Allow: allow });
}

/** A positive id from a path segment or a parameter, or null. */
export function positiveId(value: string | null | undefined): number | null {
  return value != null && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : null;
}

/** A page number or a count from a parameter, from 1, or null. */
export function pageNumber(value: string | null): number | null {
  return value !== null && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : null;
}

/** The token of `Authorization: Bearer <token>`, or null. */
export function bearerToken(request: Request): string | null {
  return /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim() || null;
}

/** The text as a JSON object, or what's wrong with it. `shape` ends the message: `{ name }`. */
export function jsonObject(text: string, shape?: string): Record<string, unknown> | string {
  const hint = shape ? `: ${shape}` : "";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return `The body must be JSON${hint}`;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return `The body must be a JSON object${hint}`;
  return data as Record<string, unknown>;
}

/** The body as a JSON object (`jsonObject`), or what's wrong with it, also when it passes `limit` bytes. */
export async function readJsonObject(request: Request, limit: number, shape: string): Promise<Record<string, unknown> | string> {
  const bytes = await readLimited(request, limit);
  if (!bytes) return `The body is larger than ${limit} bytes`;
  return jsonObject(new TextDecoder().decode(bytes), shape);
}

/**
 * The body, or `null` once it passes `limit` bytes. Counts what is read, since a chunked request has
 * no `Content-Length`, and stops reading there.
 */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
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
