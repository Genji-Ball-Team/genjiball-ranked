/** An API error: `{ "error": "<code>", "message": "<for people>" }` (docs/api.md). */
export interface ApiError {
  error: string;
  message: string;
}

export function fail(status: number, error: string, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error, message } satisfies ApiError, { status, headers });
}
