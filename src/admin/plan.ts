import { adminRejection, type HostTrust, type MatchStatus } from "../upload/plan";

/**
 * What an admin can do to a match or a host, decided before anything is written. Pure: the handler
 * reads the match or host, asks here, and writes the result with a guard on the status it read.
 */

export type MatchAction = "accept" | "reject" | "void" | "unvoid";
export const matchActions: readonly MatchAction[] = ["accept", "reject", "void", "unvoid"];

export interface MatchState {
  status: MatchStatus;
  rejection: { code: string; message: string } | null;
}

export type Transition = { ok: true; to: MatchState } | { ok: false; message: string };

/**
 * - `accept`: a match in review (or one an admin rejected) counts.
 * - `reject`: a match in review never counts. A longer copy keeps the rejection.
 * - `void`: an accepted match stops counting. A longer copy keeps the void.
 * - `unvoid`: it counts again, unless the log itself was rejected (a longer copy that arrived while
 *   it was void and has an `UNRANKED` line, say): that rejection comes back.
 */
export function matchTransition(action: MatchAction, from: MatchState, reason: string | null): Transition {
  const refuse = (message: string): Transition => ({ ok: false, message });
  switch (action) {
    case "accept":
      if (from.status === "review" || (from.status === "rejected" && from.rejection?.code === adminRejection)) {
        return { ok: true, to: { status: "accepted", rejection: null } };
      }
      return refuse("Only a match in review, or one an admin rejected, can be accepted");
    case "reject":
      if (from.status !== "review") return refuse("Only a match in review can be rejected. Void an accepted one");
      return { ok: true, to: { status: "rejected", rejection: { code: adminRejection, message: reason ?? "Rejected by an admin" } } };
    case "void":
      if (from.status !== "accepted") return refuse("Only an accepted match can be voided");
      return { ok: true, to: { status: "void", rejection: from.rejection } };
    case "unvoid":
      if (from.status !== "void") return refuse("The match isn't void");
      return { ok: true, to: { status: from.rejection ? "rejected" : "accepted", rejection: from.rejection } };
  }
}

/** Trust an admin can set. `revoked` is final: a revoked token never works again, so make a new one. */
export function trustChange(from: HostTrust, to: HostTrust): string | null {
  if (from === "revoked") return "The token is revoked. Create a new host token instead";
  if (from === to) return `The host is already ${to}`;
  return null;
}

/** A new host token: `bytes` random bytes as hex. */
export function newToken(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
