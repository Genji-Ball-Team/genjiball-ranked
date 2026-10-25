// What the tourney pages read from the public API (docs/api.md, "Site": `/api/tourneys`) and the
// small pieces the list and the tourney's own page share.
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/icon.js";
import { html, type Html } from "./html";

export type TourneyStatus = "scheduled" | "live" | "done" | "cancelled";

export interface Standing {
  place: number;
  id: number;
  name: string;
  wins: number;
  kills: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

export interface Lobby {
  id: number;
  label: string;
  capacity: number;
  /** `null` until the lobby's match is linked and public. */
  matchId: number | null;
  void: boolean;
  /** The screenshot's URL. */
  screenshot: string | null;
  /** Deleted to stay inside the storage caps. */
  screenshotExpired: boolean;
  verified: boolean;
  standings: Standing[];
}

export interface Signups {
  open: boolean;
  count: number;
  full: boolean;
  /** Only on `GET /api/tourneys/:id`. */
  names?: string[];
}

export interface Tourney {
  id: number;
  name: string;
  region: string;
  startsAt: string;
  status: TourneyStatus;
  notes: string | null;
  capacity: number;
  signups: Signups;
  lobbies: Lobby[];
}

/** `GET /api/tourneys`. */
export interface TourneyList {
  region: string;
  page: number;
  hasMore: boolean;
  upcoming: Tourney[];
  past: Tourney[];
}

/** `POST /api/tourneys/:id/signups`. */
export interface SignupAnswer {
  signup: { name: string };
  created: boolean;
  signups: Signups;
}

export const tourneyLink = (id: number): string => `/tourney?id=${id}`;

/** The grey chip for a tourney that is on now or was called off. */
export function statusChip(status: TourneyStatus): Html | "" {
  if (status === "live") return html`<gb-chip>Live</gb-chip>`;
  if (status === "cancelled") return html`<gb-chip class="cancelled">Cancelled</gb-chip>`;
  return "";
}

export const verifiedChip = (verified: boolean): Html =>
  verified
    ? html`<gb-chip title="An admin checked the screenshot against the standings">Verified</gb-chip>`
    : html`<gb-chip class="unverified" title="No admin has checked the screenshot against the standings yet">Unverified</gb-chip>`;

export const fullChip: Html = html`<gb-chip title="More players signed up than the lobbies hold: the admins add a lobby">Full</gb-chip>`;

/** The cup, in gold: only beside a winner. */
export const cup: Html = html`<gb-icon class="cup" name="tourney"></gb-icon>`;

export const played = (t: Tourney): boolean => t.lobbies.some((l) => l.standings.length > 0);
export const winners = (lobby: Lobby): Standing[] => lobby.standings.filter((s) => s.place === 1);

/** "8 / 10 signed up", the capacity being the sum of the lobbies'. */
export const signedUp = (t: Tourney): string => `${t.signups.count}${t.capacity ? ` / ${t.capacity}` : ""} signed up`;

/** "in 3 days", "in 5 hours": how far off an upcoming tourney is. */
export function until(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "starting now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const hours = ms / 3600000;
  if (hours < 1) return rtf.format(Math.ceil(ms / 60000), "minute");
  if (hours < 36) return rtf.format(Math.round(hours), "hour");
  return rtf.format(Math.round(hours / 24), "day");
}
