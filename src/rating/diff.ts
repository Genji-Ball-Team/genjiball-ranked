import type { StoredRating } from "./plan";

/**
 * What a recompute would change on a leaderboard (#33): the stored ratings against the recomputed
 * ones, per player. Pure, like the engine: the dry-run recompute (`npm run ratings:dry-run`,
 * `./dryRun.ts`) reads both and asks here.
 */

/** A player's place on one side of the diff. */
export interface Standing {
  display: number;
  rounds: number;
  wins: number;
  /** Leaderboard rank: by display rating, among players with `minRounds` rated rounds. `null` below it. */
  rank: number | null;
}

export interface PlayerDiff {
  playerId: number;
  /** `null`: no rating before (the recompute adds one). */
  before: Standing | null;
  /** `null`: no rating after (the recompute removes it). */
  after: Standing | null;
  /** Display points gained (negative: lost). `null` when either side has no rating. */
  change: number | null;
  /** Places moved up the leaderboard (negative: down). `null` when either side has no rank. */
  rankChange: number | null;
}

export interface RatingDiff {
  /** Every player who'd change, the biggest moves first (added and removed players before them). */
  players: PlayerDiff[];
  summary: {
    /** Players with a rating on either side. */
    players: number;
    /** Players whose display, rounds, wins or rank would change, or who'd gain or lose a rating. */
    changed: number;
    added: number;
    removed: number;
    up: number;
    down: number;
    /** The largest gain and loss in display points (0 when nobody moves that way). */
    biggestGain: number;
    biggestLoss: number;
    /** Every rating would come out exactly as stored, mu and sigma included: nothing to recompute. */
    identical: boolean;
  };
}

export function diffRatings(
  before: ReadonlyMap<number, StoredRating>,
  after: ReadonlyMap<number, StoredRating>,
  minRounds: number,
): RatingDiff {
  const rankBefore = ranks(before, minRounds);
  const rankAfter = ranks(after, minRounds);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  const standing = (rating: StoredRating | undefined, rank: Map<number, number>, id: number): Standing | null =>
    rating ? { display: rating.display, rounds: rating.rounds, wins: rating.wins, rank: rank.get(id) ?? null } : null;

  const players: PlayerDiff[] = [];
  let identical = true;
  for (const playerId of ids) {
    const b = before.get(playerId);
    const a = after.get(playerId);
    if (!b || !a || !sameRating(a, b)) identical = false;
    const was = standing(b, rankBefore, playerId);
    const now = standing(a, rankAfter, playerId);
    if (was && now && was.display === now.display && was.rounds === now.rounds && was.wins === now.wins && was.rank === now.rank) continue;
    players.push({
      playerId,
      before: was,
      after: now,
      change: was && now ? now.display - was.display : null,
      rankChange: was?.rank != null && now?.rank != null ? was.rank - now.rank : null,
    });
  }
  // Added and removed first, then the biggest moves; the same move by player id.
  const weight = (p: PlayerDiff) => (p.change === null ? Infinity : Math.abs(p.change));
  players.sort((x, y) => weight(y) - weight(x) || x.playerId - y.playerId);

  const changes = players.map((p) => p.change).filter((c): c is number => c !== null);
  return {
    players,
    summary: {
      players: ids.length,
      changed: players.length,
      added: players.filter((p) => !p.before).length,
      removed: players.filter((p) => !p.after).length,
      up: changes.filter((c) => c > 0).length,
      down: changes.filter((c) => c < 0).length,
      biggestGain: Math.max(0, ...changes),
      biggestLoss: Math.min(0, ...changes),
      identical,
    },
  };
}

/** Leaderboard ranks, as the site gives them: display rating down, then player id. */
function ranks(ratings: ReadonlyMap<number, StoredRating>, minRounds: number): Map<number, number> {
  const ranked = [...ratings]
    .filter(([, r]) => r.rounds >= minRounds)
    .sort(([idA, a], [idB, b]) => b.display - a.display || idA - idB);
  return new Map(ranked.map(([id], i) => [id, i + 1]));
}

function sameRating(a: StoredRating, b: StoredRating): boolean {
  return (
    a.mu === b.mu &&
    a.sigma === b.sigma &&
    a.display === b.display &&
    a.rounds === b.rounds &&
    a.wins === b.wins &&
    a.streak === b.streak &&
    a.bestStreak === b.bestStreak &&
    a.lastPlayedAt === b.lastPlayedAt
  );
}
