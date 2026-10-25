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
