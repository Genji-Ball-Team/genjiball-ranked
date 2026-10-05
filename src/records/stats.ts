import type { Config } from "../config";

/**
 * Records and activity (#19). Pure: a match's bests from its counted events and rounds
 * (`matchStats`), and the records page from what the store read (`recordsView`). The D1 side is
 * `store.ts`, the cron `update.ts`.
 */

export type RecordsConfig = Pick<
  Config,
  "recordsMatchesPerRun" | "recordsRefreshMinutes" | "recordsActivityDays" | "recordsTopHosts" | "regions"
>;

/** A match of the feed the cron reads: where it is, and whether it counts. */
export interface FeedMatch {
  id: number;
  seq: number;
  status: string;
  region: string;
  hostId: number;
  playedAt: string;
  /** The copy the counts are of: the stats are only written if it's still the stored one. */
  lineCount: number;
}

/** Counted per match from the events and rounds, by log id. */
export interface MatchCounts {
  /** A player's `DEFLECT`s in one round, and the fastest. */
  deflects: { matchId: number; round: number | null; logId: number; count: number; fastest: number | null }[];
  /** A player's `KILL`s (not of themselves) in the match. */
  kills: { matchId: number; logId: number; count: number }[];
  /** Rated rounds a log id won. */
  wins: { matchId: number; logId: number; count: number }[];
  ratedRounds: { matchId: number; count: number }[];
  /** The match's log ids and whose they are: a player who rejoined has two. */
  players: { matchId: number; logId: number; playerId: number }[];
}

/** A row of `match_stats`. `…By` are log ids of the match: its player's newest one. */
export interface MatchStatsRow {
  matchId: number;
  region: string;
  lineCount: number;
  hostId: number;
  playedAt: string;
  ratedRounds: number;
  roundDeflects: number | null;
  roundDeflectsBy: number | null;
  roundDeflectsRound: number | null;
  fastestDeflect: number | null;
  fastestDeflectBy: number | null;
  fastestDeflectRound: number | null;
  matchKills: number | null;
  matchKillsBy: number | null;
  matchWins: number | null;
  matchWinsBy: number | null;
}

/** A best of the match: the highest value, ties to the earliest round, then the lowest log id. */
interface Best {
  value: number;
  by: number;
  round: number | null;
}

function better(a: Best | null, b: Best): boolean {
  if (!a) return true;
  if (b.value !== a.value) return b.value > a.value;
  if (b.round !== a.round) return (b.round ?? Infinity) < (a.round ?? Infinity);
  return b.by < a.by;
}

/** Each accepted match's `match_stats` row. Counts of a player's two log ids are added up. */
export function matchStats(matches: readonly FeedMatch[], counts: MatchCounts): MatchStatsRow[] {
  const group = <T extends { matchId: number }>(rows: readonly T[]) => {
    const grouped = new Map<number, T[]>();
    for (const row of rows) {
      const id = row.matchId;
      const list = grouped.get(id);
      if (list) list.push(row);
      else grouped.set(id, [row]);
    }
    return grouped;
  };
  const playersByMatch = group(counts.players);
  const deflectsByMatch = group(counts.deflects);
  const killsByMatch = group(counts.kills);
  const winsByMatch = group(counts.wins);
  const ratedByMatch = new Map(counts.ratedRounds.map((r) => [r.matchId, r.count]));
  return matches.map((match) => {
    const players = playersByMatch.get(match.id) ?? [];
    const playerOf = new Map(players.map((p) => [p.logId, p.playerId]));
    // A player is named by their newest log id, the name they last joined as.
    const newest = new Map<number, number>();
    for (const p of players) newest.set(p.playerId, Math.max(newest.get(p.playerId) ?? 0, p.logId));
    const by = (logId: number) => newest.get(playerOf.get(logId) ?? -logId) ?? logId;

    const sum = <R extends { logId: number; count: number }>(rows: readonly R[]) => {
      const totals = new Map<number, number>();
      for (const row of rows) {
        const player = by(row.logId);
        totals.set(player, (totals.get(player) ?? 0) + row.count);
      }
      return totals;
    };
    const top = (totals: Map<number, number>, round: number | null) => {
      let best: Best | null = null;
      for (const [by, value] of totals) {
        const candidate = { value, by, round };
        if (better(best, candidate)) best = candidate;
      }
      return best;
    };

    const deflects = deflectsByMatch.get(match.id) ?? [];
    const rounds = new Map<number | null, Map<number, number>>();
    let fastest: Best | null = null;
    for (const d of deflects) {
      const player = by(d.logId);
      let totals = rounds.get(d.round);
      if (!totals) rounds.set(d.round, (totals = new Map()));
      totals.set(player, (totals.get(player) ?? 0) + d.count);
      if (d.fastest === null) continue;
      const candidate = { value: d.fastest, by: player, round: d.round };
      if (better(fastest, candidate)) fastest = candidate;
    }
    let perRound: Best | null = null;
    for (const [round, totals] of rounds) {
      const candidate = top(totals, round);
      if (candidate && better(perRound, candidate)) perRound = candidate;
    }
    const kills = top(sum(killsByMatch.get(match.id) ?? []), null);
    const wins = top(sum(winsByMatch.get(match.id) ?? []), null);

    return {
      matchId: match.id,
      region: match.region,
      lineCount: match.lineCount,
      hostId: match.hostId,
      playedAt: match.playedAt,
      ratedRounds: ratedByMatch.get(match.id) ?? 0,
      roundDeflects: perRound?.value ?? null,
      roundDeflectsBy: perRound?.by ?? null,
      roundDeflectsRound: perRound?.round ?? null,
      fastestDeflect: fastest?.value ?? null,
      fastestDeflectBy: fastest?.by ?? null,
      fastestDeflectRound: fastest?.round ?? null,
      matchKills: kills?.value ?? null,
      matchKillsBy: kills?.by ?? null,
      matchWins: wins?.value ?? null,
      matchWinsBy: wins?.by ?? null,
    };
  });
}

/** A player named in a record. */
export interface RecordPlayer {
  id: number;
  name: string;
}

/** A record set in a match: `round` for the per-round ones. */
export interface MatchRecord {
  value: number;
  player: RecordPlayer;
  matchId: number;
  playedAt: string;
  round?: number | null;
}

/** A record held over the player's whole time in the region. */
export interface CareerRecord {
  value: number;
  player: RecordPlayer;
}

export interface Records {
  roundDeflects: MatchRecord | null;
  fastestDeflect: MatchRecord | null;
  matchKills: MatchRecord | null;
  matchWins: MatchRecord | null;
  highestRating: MatchRecord | null;
  winStreak: CareerRecord | null;
  mostRounds: CareerRecord | null;
  mostWins: CareerRecord | null;
}

export const noRecords: Records = {
  roundDeflects: null,
  fastestDeflect: null,
  matchKills: null,
  matchWins: null,
  highestRating: null,
  winStreak: null,
  mostRounds: null,
  mostWins: null,
};

export interface ActivityDay {
  /** UTC, `2026-10-05`. */
  date: string;
  matches: number;
  rounds: number;
  players: number;
}

export interface RecordsInput {
  records: Records;
  /** Days with a match, in any order. */
  days: readonly ActivityDay[];
  /** Different players over the whole window. */
  players: number;
  topHosts: readonly { name: string; matches: number }[];
}

const dayMs = 24 * 60 * 60 * 1000;

/** The first day of the activity window: `recordsActivityDays` days, today (UTC) included. */
export function activityStart(now: Date, days: number): string {
  return new Date(now.getTime() - (Math.max(1, days) - 1) * dayMs).toISOString().slice(0, 10);
}

/** The records page as stored and served, the activity a row for every day of the window. */
export function recordsView(input: RecordsInput, config: Pick<RecordsConfig, "recordsActivityDays">, now: Date) {
  const start = activityStart(now, config.recordsActivityDays);
  const byDate = new Map(input.days.map((d) => [d.date, d]));
  const perDay: ActivityDay[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= now.getTime(); t += dayMs) {
    const date = new Date(t).toISOString().slice(0, 10);
    perDay.push(byDate.get(date) ?? { date, matches: 0, rounds: 0, players: 0 });
  }
  return {
    records: input.records,
    activity: {
      days: perDay.length,
      matches: perDay.reduce((n, d) => n + d.matches, 0),
      rounds: perDay.reduce((n, d) => n + d.rounds, 0),
      players: input.players,
      perDay,
    },
    topHosts: [...input.topHosts],
  };
}

export type RecordsBody = ReturnType<typeof recordsView>;

/** The records set in a match, by name: the ones a match leaving the region's records can take away. */
export const matchRecordNames = ["roundDeflects", "fastestDeflect", "matchKills", "matchWins", "highestRating"] as const;

/** The stored page with each record's holder as they are now (`current` by stored id): merged players by who they were merged into. */
export function withPlayers(body: RecordsBody, current: ReadonlyMap<number, RecordPlayer>): RecordsBody {
  const records = { ...body.records } as Record<keyof Records, MatchRecord | CareerRecord | null>;
  for (const name of Object.keys(records) as (keyof Records)[]) {
    const record = records[name];
    if (record) records[name] = { ...record, player: current.get(record.player.id) ?? record.player };
  }
  return { ...body, records: records as unknown as Records };
}

/** The stored page without the match records whose match isn't in `publicIds` any more. */
export function withoutMatches(body: RecordsBody, publicIds: ReadonlySet<number>): RecordsBody {
  const records = { ...body.records };
  for (const name of matchRecordNames) {
    const record = records[name];
    if (record && !publicIds.has(record.matchId)) records[name] = null;
  }
  return { ...body, records };
}
