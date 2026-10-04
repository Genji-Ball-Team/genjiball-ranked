/**
 * A tourney lobby's standings (#27), like the old result posts: rounds won, kills, and the rating
 * before and after the match. Pure: `src/tourney/store.ts` reads the rows.
 */

/** A player of the match, once per log id: a player who rejoined has two. */
export interface StandingPlayerRow {
  logId: number;
  playerId: number;
  name: string;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

export interface Standing {
  /** 1 = the lobby's winner. Players with the same wins and kills share a place. */
  place: number;
  id: number;
  name: string;
  wins: number;
  kills: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

/** How many times a log id did something: won a round, or killed someone. */
export interface LogIdCount {
  logId: number;
  n: number;
}

/**
 * Most rounds won first, ties broken by kills. `wins` counts every `WIN` round, rated or not (the
 * in-game standings count them all); `kills` every `KILL` line that isn't a player killing themselves.
 */
export function standings(players: readonly StandingPlayerRow[], wins: readonly LogIdCount[], kills: readonly LogIdCount[]): Standing[] {
  const byLogId = new Map(players.map((p) => [p.logId, p.playerId]));
  const rows = new Map<number, Omit<Standing, "place">>();
  for (const p of players) {
    if (!rows.has(p.playerId)) {
      rows.set(p.playerId, { id: p.playerId, name: p.name, wins: 0, kills: 0, ratingBefore: p.ratingBefore, ratingAfter: p.ratingAfter });
    }
  }
  for (const { logId, n } of wins) {
    const row = rows.get(byLogId.get(logId) ?? -1);
    if (row) row.wins += n;
  }
  for (const { logId, n } of kills) {
    const row = rows.get(byLogId.get(logId) ?? -1);
    if (row) row.kills += n;
  }
  const sorted = [...rows.values()].sort((a, b) => b.wins - a.wins || b.kills - a.kills || a.name.localeCompare(b.name));
  const result: Standing[] = [];
  for (const [i, row] of sorted.entries()) {
    const prev = result[i - 1];
    const tied = prev !== undefined && prev.wins === row.wins && prev.kills === row.kills;
    result.push({ place: tied ? prev.place : i + 1, ...row });
  }
  return result;
}
