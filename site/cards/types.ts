// The data a page hands to the share sheet (share.ts) for its card. Plain values: the styles in
// this folder draw it.
import type { Tier, TitleName } from "../lib/types";

/** What every card has: the post's link and words, and what to call the downloaded file. */
interface CardBase {
  /** The downloaded file's name, before the size: "Name-eu". Anything but letters and digits becomes a dash. */
  file: string;
  /** Where the post links to. */
  url: string;
  /** The post's title (Reddit) and the image's alt text. */
  title: string;
  /** The post's text (X, Bluesky, the phone's share menu). */
  text: string;
  /** The region's name ("Europe"), shown as text and never as a colour. */
  region: string;
}

/** A player's profile. The history part (`peak`, `bestStreak`, `form`, `points`) can come later. */
export interface PlayerCard extends CardBase {
  kind: "player";
  name: string;
  crown: TitleName | null;
  tier: Tier | null;
  rating: number | null;
  rank: number | null;
  rounds: number | null;
  /** "54%". */
  winRate: string | null;
  peak: number | null;
  bestStreak: number | null;
  /** Places of the last rated rounds, oldest first. */
  form: number[];
  /** Rating after each match, oldest first. */
  points: number[];
}

export interface MatchRow {
  place: number;
  name: string;
  won: number;
  kills: number;
  before: number | null;
  after: number | null;
}

/** A finished match. */
export interface MatchCard extends CardBase {
  kind: "match";
  id: number;
  date: string;
  map: string;
  /** "Tourney name, lobby", for a tourney match. */
  tourney: string | null;
  /** "4 rounds". */
  rounds: string;
  /** "6 players". */
  playerCount: string;
  winners: string[];
  /** "3 rounds won · 12 kills", about the first winner. */
  winnerLine: string;
  rows: MatchRow[];
}

export interface ComparedPlayer {
  name: string;
  tier: Tier | null;
  rating: number | null;
  rank: number | null;
  /** "54%". */
  winRate: string | null;
  /** The same as a fraction, to tell who is ahead. */
  winShare: number | null;
  killsPerRound: number | null;
  peak: number | null;
  /** Rating after each match, with when it was played (ms). */
  points: { rating: number; t: number }[];
}

/** Up to three players side by side, told apart by their line's stroke as on the compare chart. */
export interface CompareCard extends CardBase {
  kind: "compare";
  players: ComparedPlayer[];
}

export type ShareCard = PlayerCard | MatchCard | CompareCard;
