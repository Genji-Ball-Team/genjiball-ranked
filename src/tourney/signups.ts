import type { Config } from "../config";
import { fail } from "../http";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import { readLimited, sha256 } from "../upload/handler";
import { nameKey } from "../upload/plan";
import { insertSignup, readSignupState, type SignupState } from "./signupStore";

/**
 * `POST /api/tourneys/:id/signups` (#31): a player types their in-game name to say they're coming.
 * No login and nothing enforced: it tells admins how many lobbies to set up (#24). Body
 * `{ "name": "Kenzo" }`.
 *
 * - Only while the tourney is `scheduled`: sign-ups close when it goes live, is done or cancelled.
 * - A name signs up once per tourney, whatever its case (spaces around it dropped). Signing up again
 *   answers the first sign-up and writes nothing. A name an admin removed can't sign up again.
 * - Sign-ups past the tourney's capacity are taken: the page lists them past "full", and admins add
 *   a lobby. `tourneySignupsMax` bounds what one tourney stores.
 * - At most `tourneySignupsPerHour` stored sign-ups per IP an hour (only its SHA-256 is stored).
 *
 * A public write, not a public read: same origin only, never cached (src/public.ts). Two queries:
 * the state, then the insert.
 */

export type SignupConfig = Pick<
  Config,
  | "playerNameMaxLength"
  | "tourneyLobbyCapacity"
  | "tourneySignupsPerHour"
  | "tourneySignupsMax"
  | "tourneySignupBodyMaxBytes"
>;

const hourMs = 60 * 60 * 1000;

/** The sign-up counts a tourney shows: `full` once the sign-ups reach a capacity it has. */
export function signupSummary(status: string, count: number, capacity: number) {
  return { open: status === "scheduled", count, full: capacity > 0 && count >= capacity };
}

export async function handleSignup(request: Request, db: D1Database, config: SignupConfig, log: Logger, now = new Date()): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST", { Allow: "POST" });
  const idParam = new URL(request.url).pathname.split("/")[3] ?? "";
  if (!/^[1-9]\d{0,15}$/.test(idParam)) return fail(404, "not_found", "No such tourney");
  const tourneyId = Number(idParam);

  const name = await readName(request, config);
  if (typeof name !== "string") return fail(400, "bad_request", name.error);
  const key = nameKey(name);
  const ipHash = await sha256(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const since = isoSeconds(new Date(now.getTime() - hourMs));
  const read = () => readSignupState(db, tourneyId, key, ipHash, since, config.tourneyLobbyCapacity);

  let state = await read();
  const refused = refusal(state, config);
  if (refused) return refused;
  const at = isoSeconds(now);
  const signedUpAt = await insertSignup(db, { tourneyId, name, nameKey: key, ipHash, at, max: config.tourneySignupsMax });
  if (signedUpAt) {
    log.info("tourney sign-up", { tourney: tourneyId, name });
    return answer(201, name, signedUpAt, true, { ...state!, count: state!.count + 1 });
  }
  // Something changed between the read and the write: the same name, the tourney started, the cap.
  state = await read();
  return refusal(state, config) ?? fail(409, "conflict", "The sign-ups changed meanwhile. Try again");
}

/**
 * Why the sign-up can't be stored, or the answer for a name already signed up; null when it can be.
 * The name's own sign-up comes first: someone checking theirs after the start still sees it.
 */
function refusal(state: SignupState | null, config: SignupConfig): Response | null {
  if (!state) return fail(404, "not_found", "No such tourney");
  if (state.existing?.removed) return fail(409, "removed", "An admin removed this name from the sign-ups");
  if (state.existing) return answer(200, state.existing.name, state.existing.signedUpAt, false, state);
  if (state.status !== "scheduled") return fail(409, "closed", "Sign-ups are closed: the tourney has started, ended or been cancelled");
  if (state.recent >= config.tourneySignupsPerHour) {
    return fail(429, "rate_limited", `At most ${config.tourneySignupsPerHour} sign-ups an hour`, { "Retry-After": "3600" });
  }
  if (state.stored >= config.tourneySignupsMax) return fail(409, "too_many", `This tourney has ${config.tourneySignupsMax} sign-ups: ask on the Discord`);
  return null;
}

function answer(status: number, name: string, signedUpAt: string, created: boolean, state: SignupState): Response {
  return Response.json(
    { signup: { name, signedUpAt }, created, capacity: state.capacity, signups: signupSummary(state.status, state.count, state.capacity) },
    { status },
  );
}

/** The trimmed name from the body, or what's wrong with it. */
async function readName(request: Request, config: SignupConfig): Promise<string | { error: string }> {
  const bytes = await readLimited(request, config.tourneySignupBodyMaxBytes);
  if (!bytes) return { error: `The body is larger than ${config.tourneySignupBodyMaxBytes} bytes` };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: "The body must be JSON: { name }" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "The body must be a JSON object: { name }" };
  const { name } = body as Record<string, unknown>;
  if (typeof name !== "string") return { error: "name must be a string: your in-game name" };
  const trimmed = name.trim();
  if (!trimmed) return { error: "name is required" };
  if ([...trimmed].length > config.playerNameMaxLength) return { error: `name is longer than ${config.playerNameMaxLength} characters` };
  // Control characters aren't in game names, and would garble the lists.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { error: "name can't contain control characters" };
  return trimmed;
}
