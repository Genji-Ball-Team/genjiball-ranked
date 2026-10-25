// The admin API's answers (docs/api.md, "Admin"), as far as the pages read them.

export type MatchStatus = "review" | "accepted" | "void" | "rejected";
export type TourneyStatus = "scheduled" | "live" | "done" | "cancelled";
export type Trust = "trusted" | "untrusted" | "revoked";

export interface Rejection {
  code: string;
  message?: string | null;
}

export interface AdminMatch {
  id: number;
  region: string | null;
  status: MatchStatus;
  playedAt: string;
  hostId: number;
  hostName: string;
  players: string[];
  reviewReasons: string[];
  rejection: Rejection | null;
  tournament: boolean;
  complete: boolean;
  rated: boolean;
  map?: string | null;
  preset?: string | null;
  lineCount: number;
}

export interface Lobby {
  id: number;
  version: number;
  label: string;
  hostId: number | null;
  hostName: string | null;
  roundLimit: number;
  roundLimitDefault: boolean;
  capacity: number;
  capacityDefault: boolean;
  matchId: number | null;
  screenshotKey: string | null;
  screenshotExpiredAt?: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
}

export interface AdminTourney {
  id: number;
  name: string;
  region: string;
  startsAt: string;
  notes: string | null;
  status: TourneyStatus;
  capacity: number;
  signups: { count: number; open: boolean };
  lobbies: Lobby[];
}

export interface Signup {
  id: number;
  name: string;
  discordUserId?: string | null;
  signedUpAt: string;
  removedAt: string | null;
  removedBy: string | null;
}

export interface Host {
  id: number;
  name: string;
  trust: Trust;
  region: string | null;
  createdAt: string;
  lastUploadAt: string | null;
}

export interface FoundPlayer {
  id: number;
  name: string;
  aliases: string[];
}

export interface Alias {
  id: number;
  name: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface AdminPlayer {
  id: number;
  name: string;
  nameFixed: boolean;
  alt: boolean;
  mergedInto: number | null;
  createdAt: string;
  aliases: Alias[];
  ratings: { region: string; rating: number; rounds: number; wins: number; lastPlayedAt: string | null }[];
  matches: number;
}

export interface Merge {
  id: number;
  from: { id: number; name: string };
  into: { id: number; name: string };
  aliases: string[];
  mergedBy: string;
  mergedAt: string;
  undoneBy: string | null;
  undoneAt: string | null;
}

export interface AdminAction {
  at: string;
  admin: string;
  action: string;
  matchId: number | null;
  hostId: number | null;
  detail: unknown;
}

/** What most writes answer with besides their own object. */
export interface Stale {
  ratingsStale?: boolean;
}

export interface ParsedMatch {
  matchKey: string;
  action: string;
  status: MatchStatus;
  region: string | null;
  gameVersion?: string | null;
  settings?: { map?: string | null } | null;
  players: { name: string }[];
  ratedRounds: number;
  rounds: unknown[];
  kills?: number | null;
  complete: boolean;
  storedMatchId?: number | null;
  reviewReasons: string[];
  rejection?: { message: string } | null;
  problems: { line: number; message: string }[];
}

export interface ParseAnswer {
  upload: { status: number; result?: string; error?: string; message?: string; matches?: unknown[] };
  duplicateOf?: number | null;
  parser: { error?: { message: string } | null; matches: ParsedMatch[]; warnings: (string | { message?: string })[] };
}
