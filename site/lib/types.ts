// What the site reads from the public API (docs/api.md, "Site"). Written out here rather than
// imported from src/: the Worker's code is typed for the Workers runtime, the site for the browser.

export interface Region {
  id: string;
  label: string;
}

/** `GET /api/server`. */
export interface Server {
  testServer: boolean;
  regions: Region[];
  /** Regions whose ratings are being recomputed. */
  ratingsUpdating: string[];
}

/** A tier: RGB 0–255, `threshold` the display rating it starts at. */
export interface Tier {
  label: string;
  color: [number, number, number];
  threshold: number;
}

/** A row of `GET /api/leaderboard`. */
export interface LeaderboardPlayer {
  rank: number;
  id: number;
  name: string;
  rating: number;
  rounds: number;
  wins: number;
  lastPlayedAt: string;
  tier: Tier | null;
  siteTier: Tier | null;
  inactiveSince: string | null;
}

/** `GET /api/leaderboard`. */
export interface Leaderboard {
  region: string;
  page: number;
  pageSize: number;
  hasMore: boolean;
  players: LeaderboardPlayer[];
}

/** God or Demigod (`GET /api/titles`). */
export type TitleName = "God" | "Demigod";

/** `GET /api/titles`. */
export interface Titles {
  region: string;
  titles: (LeaderboardPlayer & { title: TitleName })[];
}

/** A row of `GET /api/players?search=`. */
export interface FoundPlayer {
  id: number;
  name: string;
  rating: number | null;
  tier: Tier | null;
  matchedAlias: string | null;
}

/** `GET /api/players?search=`. */
export interface FoundPlayers {
  region: string;
  players: FoundPlayer[];
}

/** A player's rating in one region (`GET /api/players/{id}`): a leaderboard row, `rank` null off it. */
export interface PlayerRating extends Omit<LeaderboardPlayer, "rank"> {
  rank: number | null;
  nextTier: Tier | null;
}

/** A match on a player's page. */
export interface PlayerMatch {
  id: number;
  playedAt: string;
  map: string | null;
  legacy: boolean;
  void: boolean;
  tournament: boolean;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

/** Who a player eliminates most, or is eliminated by most. */
export interface Rival {
  id: number;
  name: string;
  kills: number;
  rounds: number;
}

/** `GET /api/players/{id}`. */
export interface PlayerPage {
  region: string;
  player: {
    id: number;
    name: string;
    alt: boolean;
    aliases: string[];
    regions: string[];
    rating: PlayerRating | null;
  };
  matches: PlayerMatch[];
  mostEliminated: Rival[];
  mostEliminatedBy: Rival[];
}

/** A point of `GET /api/players/{id}/history`: the rating after a match. */
export interface HistoryPoint {
  matchId: number;
  playedAt: string;
  rating: number;
}

/** `GET /api/players/{id}/history`. */
export interface History {
  region: string;
  player: { id: number; name: string };
  matches: number;
  points: HistoryPoint[];
  peak: HistoryPoint | null;
  streak: number;
  bestStreak: number;
  form: {
    rounds: number;
    wins: number;
    averagePosition: number;
    /** Newest first. */
    results: { matchId: number; round: number; position: number; players: number }[];
  };
}
