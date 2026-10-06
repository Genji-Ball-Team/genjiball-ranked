import type { Config } from "../config";
import { isoSeconds } from "../time";

/**
 * The tourney code values (#25): what the host tool writes into the game's `TOURNEY - generated`
 * rule (GenjiBall-CE#143) for the lobby's assigned host. Pure: no D1.
 */

export type CodeConfig = Pick<Config, "tourneyCodeLeadMinutes" | "tourneyRoundLimit">;

/** A new `lobbyKey`: `digits` random digits, as text (it may start with 0). */
export function newLobbyKey(digits: number): string {
  return [...crypto.getRandomValues(new Uint32Array(digits))].map((n) => n % 10).join("");
}

/** The lobby's round limit: its own, or `tourneyRoundLimit`. */
export function roundLimitOf(roundLimit: number | null, config: Pick<Config, "tourneyRoundLimit">): number {
  return roundLimit ?? config.tourneyRoundLimit;
}

/** Players the lobby holds: its own capacity, or `tourneyLobbyCapacity`. */
export function capacityOf(capacity: number | null, config: Pick<Config, "tourneyLobbyCapacity">): number {
  return capacity ?? config.tourneyLobbyCapacity;
}

export interface CodeLobby {
  label: string;
  lobbyKey: string | null;
  roundLimit: number | null;
  matchId: number | null;
  tourneyName: string;
  tourneyStartsAt: string;
  tourneyStatus: string;
}

export interface TourneyCode {
  lobbyKey: string;
  roundLimit: number;
  /** The tourney's name and the lobby's label, for the game's display label. */
  name: string;
  label: string;
}

/** When the code values become available: `tourneyCodeLeadMinutes` before the start. */
export function codeFrom(startsAt: string, config: CodeConfig): string {
  return isoSeconds(new Date(Date.parse(startsAt) - config.tourneyCodeLeadMinutes * 60 * 1000));
}

/**
 * The code values, or null outside the window: from `codeFrom` until the lobby is done (its match
 * is linked, or the tourney is done or cancelled).
 */
export function tourneyCode(lobby: CodeLobby, config: CodeConfig, now: Date): TourneyCode | null {
  if (lobby.tourneyStatus !== "scheduled" && lobby.tourneyStatus !== "live") return null;
  if (lobby.matchId !== null || lobby.lobbyKey === null) return null;
  if (now.getTime() < Date.parse(codeFrom(lobby.tourneyStartsAt, config))) return null;
  return { lobbyKey: lobby.lobbyKey, roundLimit: roundLimitOf(lobby.roundLimit, config), name: lobby.tourneyName, label: lobby.label };
}
