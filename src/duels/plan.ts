import type { Config } from "../config";
import { displayRating, newRating, rateDuel, type RatingConfig, type Ratings } from "../rating/engine";
import { nameKey } from "../upload/plan";

/**
 * Duels (docs/rating.md, "Duels"): 1v1s an admin enters by hand. Pure: checking an entry, the
 * pair's daily limit, the preview of what it would do to ratings, and a player's duel stats. The
 * D1 queries are in `./store.ts`, the routes in src/admin/duels.ts and src/site/handler.ts.
 */

export type DuelConfig = RatingConfig & Pick<Config, "duelPairDailyRatedLimit" | "duelsPerEntryMax" | "playerNameMaxLength">;

/** One duel of an entry, by name, as the admin typed it. */
export interface DuelInput {
  winner: string;
  loser: string;
  winnerScore: number;
  loserScore: number;
}

/** The entry's duels, or why it can't be one. */
export function checkDuels(value: unknown, config: Pick<DuelConfig, "duelsPerEntryMax" | "playerNameMaxLength">): DuelInput[] | string {
  if (!Array.isArray(value) || value.length === 0) return "duels must be a list of at least one duel";
  if (value.length > config.duelsPerEntryMax) return `At most ${config.duelsPerEntryMax} duels at once`;
  const duels: DuelInput[] = [];
  for (const [i, item] of value.entries()) {
    const line = `Duel ${i + 1}`;
    if (typeof item !== "object" || item === null) return `${line}: not a duel`;
    const d = item as Record<string, unknown>;
    const winner = typeof d.winner === "string" ? d.winner.trim() : "";
    const loser = typeof d.loser === "string" ? d.loser.trim() : "";
    if (!winner || !loser) return `${line}: needs both players' names`;
    if ([...winner].length > config.playerNameMaxLength || [...loser].length > config.playerNameMaxLength) {
      return `${line}: a name is longer than ${config.playerNameMaxLength} characters`;
    }
    if (nameKey(winner) === nameKey(loser)) return `${line}: a player can't duel themselves`;
    const scores = [d.winnerScore, d.loserScore];
    if (!scores.every((s) => Number.isInteger(s) && (s as number) >= 0 && (s as number) <= 1000)) return `${line}: scores must be whole numbers`;
    const [winnerScore, loserScore] = scores as [number, number];
    if (winnerScore <= loserScore) return `${line}: the winner's score must be higher than the loser's`;
    duels.push({ winner, loser, winnerScore, loserScore });
  }
  return duels;
}

/** The two players' ids in a stable order, as a key for their pair. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** A known or new player of an entry. */
export interface DuelPlayer {
  /** Null: a new player, made with this name when the entry is saved. */
  id: number | null;
  name: string;
}

/** A duel of an entry, checked and previewed. */
export interface PlannedDuel {
  winner: DuelPlayer;
  loser: DuelPlayer;
  winnerScore: number;
  loserScore: number;
  /** False: past `duelPairDailyRatedLimit` for the pair today. Listed, but it changes no rating. */
  rated: boolean;
  /** Display ratings before and after, in the entry's order (an earlier duel of the entry counts). */
  winnerBefore: number;
  winnerAfter: number;
  loserBefore: number;
  loserAfter: number;
}

/**
 * What an entry would do, duel by duel, from the region's current ratings: the ratings `rateDuel`
 * gives, in order, and whether each counts toward its pair's daily limit (`ratedToday`: the pair's
 * rated duels today before the entry). A new player gets a stand-in id below 0 for the preview.
 */
export function planDuels(
  duels: readonly DuelInput[],
  players: ReadonlyMap<string, DuelPlayer>,
  ratings: Ratings,
  ratedToday: ReadonlyMap<string, number>,
  config: DuelConfig,
  playedAt: string,
): PlannedDuel[] {
  const working: Ratings = new Map([...ratings].map(([id, r]) => [id, { ...r }]));
  const standIn = new Map<string, number>();
  const idOf = (name: string): number => {
    const key = nameKey(name);
    const known = players.get(key)?.id;
    if (known !== null && known !== undefined) return known;
    if (!standIn.has(key)) standIn.set(key, -(standIn.size + 1));
    return standIn.get(key)!;
  };
  const today = new Map(ratedToday);
  return duels.map((d, i) => {
    const winner = idOf(d.winner);
    const loser = idOf(d.loser);
    const pair = pairKey(winner, loser);
    const count = today.get(pair) ?? 0;
    const rated = config.duelPairDailyRatedLimit <= 0 || count < config.duelPairDailyRatedLimit;
    if (rated) today.set(pair, count + 1);
    const display = (id: number) => displayRating(working.get(id) ?? newRating(config, playedAt), config);
    const [winnerBefore, loserBefore] = [display(winner), display(loser)];
    rateDuel(working, { id: i, playedAt, rounds: [] }, { winner, loser, winnerScore: d.winnerScore, loserScore: d.loserScore, rated }, config);
    return {
      winner: players.get(nameKey(d.winner)) ?? { id: null, name: d.winner },
      loser: players.get(nameKey(d.loser)) ?? { id: null, name: d.loser },
      winnerScore: d.winnerScore,
      loserScore: d.loserScore,
      rated,
      winnerBefore,
      winnerAfter: display(winner),
      loserBefore,
      loserAfter: display(loser),
    };
  });
}

/** A stored duel, from one player's side. */
export interface PlayerDuelRow {
  id: number;
  playedAt: string;
  won: boolean;
  score: number;
  opponentScore: number;
  opponent: { id: number; name: string };
  /** Null when it changed no rating (past the pair's daily limit). */
  ratingBefore: number | null;
  ratingAfter: number | null;
}

/** A player's duel stats from their duels, newest first (docs/api.md, `/api/players/:id/duels`). */
export function duelStats(duels: readonly PlayerDuelRow[], recent: number) {
  const change = (d: PlayerDuelRow) => (d.ratingAfter === null || d.ratingBefore === null ? 0 : d.ratingAfter - d.ratingBefore);
  const wins = duels.filter((d) => d.won).length;
  // Newest first: the streak is the run of the same result from the newest one.
  let streak = 0;
  for (const d of duels) {
    if (d.won !== duels[0]!.won) break;
    streak++;
  }
  const best = duels.filter((d) => d.won).sort((a, b) => b.score - b.opponentScore - (a.score - a.opponentScore) || b.playedAt.localeCompare(a.playedAt))[0];

  const byOpponent = new Map<number, { id: number; name: string; wins: number; losses: number; score: number; opponentScore: number; change: number; lastPlayedAt: string }>();
  for (const d of duels) {
    const o = byOpponent.get(d.opponent.id) ?? { ...d.opponent, wins: 0, losses: 0, score: 0, opponentScore: 0, change: 0, lastPlayedAt: d.playedAt };
    if (d.won) o.wins++;
    else o.losses++;
    o.score += d.score;
    o.opponentScore += d.opponentScore;
    o.change += change(d);
    byOpponent.set(d.opponent.id, o);
  }
  const opponents = [...byOpponent.values()].sort((a, b) => b.wins + b.losses - (a.wins + a.losses) || b.lastPlayedAt.localeCompare(a.lastPlayedAt));
  const most = (key: "wins" | "losses") =>
    [...opponents].filter((o) => o[key] > 0).sort((a, b) => b[key] - a[key] || b.lastPlayedAt.localeCompare(a.lastPlayedAt))[0] ?? null;
  const side = (o: (typeof opponents)[number] | null) =>
    o && { id: o.id, name: o.name, wins: o.wins, losses: o.losses, change: o.change };

  return {
    wins,
    losses: duels.length - wins,
    score: duels.reduce((sum, d) => sum + d.score, 0),
    opponentScore: duels.reduce((sum, d) => sum + d.opponentScore, 0),
    ratingChange: duels.reduce((sum, d) => sum + change(d), 0),
    streak: duels.length ? { won: duels[0]!.won, length: streak } : null,
    bestWin: best ? { id: best.id, score: best.score, opponentScore: best.opponentScore, opponent: best.opponent } : null,
    beatMost: side(most("wins")),
    beatenByMost: side(most("losses")),
    opponents,
    recent: duels.slice(0, recent),
  };
}
