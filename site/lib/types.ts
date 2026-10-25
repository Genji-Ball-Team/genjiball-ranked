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
  /** Only the active players, ranked among themselves (`?active=1`). */
  active: boolean;
  /** Days back `change` counts from. */
  changeDays: number;
  hasMore: boolean;
  /** `change`: rating now minus a week ago, null when they had none then. */
  players: (LeaderboardPlayer & { change: number | null })[];
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
  /** Their place in the match, as on the match page. */
  place: number | null;
  roundWins: number;
}

/** `GET /api/players/{id}/matches`: older matches. */
export interface PlayerMatches {
  region: string;
  matches: PlayerMatch[];
  hasMore: boolean;
}

/** A player in a match of `GET /api/recent`, in place order. */
export interface RecentPlayer {
  id: number;
  name: string;
  place: number;
  roundWins: number;
  kills: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

/** `GET /api/recent`: the region's newest matches. */
export interface RecentMatches {
  region: string;
  matches: (Omit<PlayerMatch, "ratingBefore" | "ratingAfter" | "place" | "roundWins"> & { players: RecentPlayer[] })[];
  hasMore: boolean;
}

/** The climbers of `GET /api/records`: who gained most over the last `days`. */
export interface Climbers {
  days: number;
  players: { player: { id: number; name: string }; rating: number; change: number }[];
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
  moreMatches: boolean;
  mostEliminated: Rival[];
  mostEliminatedBy: Rival[];
  /** Kills of theirs on other players and deaths by another player's kill, in the region's accepted matches. */
  eliminations: { kills: number; deaths: number };
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
  peak: (HistoryPoint & { siteTier: Tier | null }) | null;
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

/** A player's whole match on `GET /api/matches/{id}`: `place` is their overall place, 1 the winner. */
export interface MatchPlayer {
  id: number;
  name: string;
  rounds: number;
  wins: number;
  roundWins: number;
  kills: number;
  deflects: number;
  touches: number;
  longestStreak: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
  place: number;
}

/** Where a player finished one round: no position if they left or were away. */
export interface Placement {
  playerId: number;
  name: string;
  position: number | null;
  left: boolean;
  afk: boolean;
  kills: number;
  deflects: number;
  touches: number;
}

export interface Round {
  number: number;
  /** `NONE`: everyone died, replayed. `ABORT`: stopped before anyone won. */
  result: "WIN" | "NONE" | "ABORT";
  rated: boolean;
  /** Why a round isn't rated, when the log broke. */
  broken: string | string[] | null;
  winner: number | null;
  placements: Placement[];
}

/** `GET /api/matches/{id}`. */
export interface Match {
  id: number;
  region: string;
  playedAt: string;
  map: string | null;
  preset: string | null;
  gameVersion: string;
  legacy: boolean;
  void: boolean;
  complete: boolean;
  tournament: boolean;
  tourney: { id: number; name: string; lobby: string } | null;
  players: MatchPlayer[];
  rounds: Round[];
}

/** `GET /api/rules`: how ranked works, from the server's config. */
export interface Rules {
  tiers: (Tier & { siteOnly: boolean })[];
  titles: { label: string; max: number }[];
  minRankedRounds: number;
  inactiveAfterDays: number;
  newPlayerRating: number;
  matchMaxChange: number;
  floor: number;
  tournament: { maxGain: number; winnerBonus: number; maxLoss: { below: number | null; maxLoss: number }[] };
}
