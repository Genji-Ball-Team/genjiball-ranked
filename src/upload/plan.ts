import type { Config } from "../config";
import type { ParsedMatch } from "../parser/types";
import { dropsHost, unionRounds, withHostAfk, type HostAfk } from "./hostAfk";

/**
 * What an upload does to the database, decided before anything is written. Pure: the endpoint
 * reads what's stored, calls `planUpload`, and writes the plan in one batch (`store.ts`).
 */

export type HostTrust = "trusted" | "untrusted" | "revoked";
export type MatchStatus = "accepted" | "review" | "rejected" | "void";

/** The stored copy of a match, for the same host and `matchKey`. */
export interface StoredCopy {
  id: number;
  matchKey: string;
  lineCount: number;
  status: MatchStatus;
  /** Why it's rejected, for a rejected match. */
  rejection: { code: string; message: string } | null;
  uploadId: number;
  /** `content_hash` of that upload, for a `refresh` that leaves the match in it. */
  uploadHash: string;
  region: string;
  /** Host AFK rounds stored for the match (`matches.host_afk`). */
  hostAfk: number[];
}

/** `rejection.code` of a match an admin rejected from the review queue. */
export const adminRejection = "admin";

/** What happens to one match of the file. */
export type MatchAction =
  /** No stored copy: insert it. */
  | "insert"
  /** The stored copy is shorter: replace its rows with this one. */
  | "replace"
  /** The stored copy is the same: point it at this upload, so the older file can go. */
  | "repoint"
  /** The stored copy is longer, or the match can't be stored: nothing to do. */
  | "skip"
  /**
   * The upload brings host AFK rounds the stored match didn't have: its rows are rewritten from the
   * stored copy (this file's when it's as long, else the stored log) with the new rounds. The match
   * stays in its upload; this file isn't stored for it.
   */
  | "refresh";

export interface MatchPlan {
  matchKey: string;
  lineCount: number;
  action: MatchAction;
  /** Id of the stored copy, for `replace` and `repoint`. */
  storedId: number | null;
  /** Upload the stored copy is in, so that upload can be deleted once nothing points at it. */
  storedUploadId: number | null;
  /** For a `refresh`: `content_hash` of the upload the match stays in. `null`: this upload. */
  uploadHash: string | null;
  /** Host AFK rounds of the match after this upload: the stored ones and the header's. */
  hostAfk: number[];
  /**
   * A `skip` that would be a `refresh` with the stored copy's log, which wasn't passed: read it
   * (`storedMatches`) and plan again.
   */
  needsStoredCopy: boolean;
  /** The match's status after this upload (the stored one for `skip`). */
  status: MatchStatus;
  rejection: { code: string; message: string } | null;
  reviewReasons: string[];
  /** The match as written: the host dropped from the `hostAfk` rounds (`withHostAfk`). */
  match: ParsedMatch;
}

export type PlanConfig = Pick<Config, "minMatchPlayers" | "untrustedHostUploads" | "hostAfkMaxRounds">;

export interface PlanOptions {
  /** `X-Host-Afk`: the host's AFK rounds by `matchKey`. */
  hostAfk?: HostAfk;
  /** The longest stored copy of a match, parsed from its stored log, for a `refresh` (`needsStoredCopy`). */
  storedMatches?: ReadonlyMap<string, ParsedMatch>;
  /** This exact file is stored already: nothing is stored again, only a `refresh` can happen. */
  duplicate?: boolean;
}

export function planUpload(
  matches: readonly ParsedMatch[],
  stored: readonly StoredCopy[],
  trust: HostTrust,
  config: PlanConfig,
  options: PlanOptions = {},
): MatchPlan[] {
  const storedByKey = new Map(stored.map((copy) => [copy.matchKey, copy]));
  return longestCopies(matches).map((parsed) => {
    const copy = storedByKey.get(parsed.matchKey);
    const sent = parsed.matchKey ? options.hostAfk?.get(parsed.matchKey) : undefined;
    // The union of every upload's rounds: a later upload never takes rounds away.
    const hostAfk = unionRounds(copy?.hostAfk ?? [], sent ?? [], config.hostAfkMaxRounds);
    const plan = (match: ParsedMatch, action: MatchAction): MatchPlan => {
      const written = withHostAfk(match, hostAfk);
      return {
        matchKey: match.matchKey,
        lineCount: match.lineCount,
        action,
        storedId: copy?.id ?? null,
        storedUploadId: copy?.uploadId ?? null,
        uploadHash: null,
        hostAfk,
        needsStoredCopy: false,
        ...judge(written, trust, config),
        match: written,
      };
    };
    const skip = (needsStoredCopy = false): MatchPlan => ({
      ...plan(parsed, "skip"),
      hostAfk: copy?.hostAfk ?? [],
      needsStoredCopy,
      ...(copy ? { status: copy.status } : {}),
    });

    if (!parsed.matchKey) return skip();
    if (!copy) return options.duplicate ? skip() : plan(parsed, "insert");

    let next: MatchPlan;
    const equal = copy.lineCount === parsed.lineCount;
    if (copy.lineCount > parsed.lineCount || equal) {
      // The stored copy stays. AFK rounds that drop the host from one of its rounds rewrite its rows
      // (`refresh`), from its own log when it's longer than this file. Rounds that change nothing
      // aren't written on their own: the next upload of the match sends them again.
      const storedMatch = equal ? parsed : options.storedMatches?.get(parsed.matchKey);
      const added = hostAfk.filter((round) => !copy.hostAfk.includes(round));
      if (!added.length || (storedMatch && !dropsHost(storedMatch, added))) {
        if (!equal || options.duplicate) return skip();
        next = { ...plan(parsed, "repoint"), hostAfk: copy.hostAfk };
      } else if (storedMatch?.lineCount !== copy.lineCount) {
        return skip(true);
      } else {
        next = { ...plan(storedMatch, "refresh"), uploadHash: copy.uploadHash };
      }
    } else if (options.duplicate) {
      return skip();
    } else {
      next = plan(parsed, "replace");
    }
    const action = next.action;
    // An admin's rejection survives a longer copy of the match.
    if (copy.status === "rejected" && copy.rejection?.code === adminRejection) {
      return { ...next, action, status: "rejected", rejection: copy.rejection, reviewReasons: [] };
    }
    // So does a void. The new copy's own verdict is kept with it, for an un-void (docs/api.md).
    const status = copy.status === "void" ? "void" : next.status;
    return { ...next, status, action };
  });
}

/** One entry per `matchKey`: the longest copy if a file somehow holds several. */
function longestCopies(matches: readonly ParsedMatch[]): ParsedMatch[] {
  const byKey = new Map<string, ParsedMatch>();
  const withoutKey: ParsedMatch[] = [];
  for (const match of matches) {
    if (!match.matchKey) {
      withoutKey.push(match);
      continue;
    }
    const seen = byKey.get(match.matchKey);
    if (!seen || match.lineCount > seen.lineCount) byKey.set(match.matchKey, match);
  }
  return [...byKey.values(), ...withoutKey];
}

/** Whether a match counts, needs an admin, or doesn't count, and why. */
function judge(
  match: ParsedMatch,
  trust: HostTrust,
  config: PlanConfig,
): Pick<MatchPlan, "status" | "rejection" | "reviewReasons"> {
  const reject = (code: string, message: string) => ({
    status: "rejected" as const,
    rejection: { code, message },
    reviewReasons: [],
  });

  if (!match.matchKey) return reject("no_match_key", "GBR has no matchKey, so copies of the match can't be told apart");
  if (match.rejection) return reject(match.rejection.code, match.rejection.message);

  const players = ratedPlayers(match);
  if (players < config.minMatchPlayers) {
    const message = players === 0 ? "No rated rounds" : `${players} players in rated rounds, the minimum is ${config.minMatchPlayers}`;
    return reject("too_few_players", message);
  }

  const reviewReasons: string[] = [...match.review];
  if (trust !== "trusted") {
    if (config.untrustedHostUploads === "reject") return reject("untrusted_host", "Uploads from untrusted hosts are rejected");
    reviewReasons.push("untrusted_host");
  }
  return { status: reviewReasons.length ? "review" : "accepted", rejection: null, reviewReasons };
}

/** A round is rated when it has a finishing order of at least 2 players (docs/ranked-log.md). */
export function isRated(order: readonly number[] | null): order is number[] {
  return order !== null && order.length >= 2;
}

function ratedPlayers(match: ParsedMatch): number {
  const ids = new Set<number>();
  for (const round of match.rounds) {
    if (isRated(round.finishingOrder)) round.finishingOrder.forEach((id) => ids.add(id));
  }
  return ids.size;
}

/** Name lookup key: names map to players ignoring case. */
export function nameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The rows of the matches to insert or replace, as JSON-ready objects for the bulk inserts in
 * `store.ts`. Player fields are log ids, as in the log; names map to players through `aliases`.
 */
export function matchRows(plans: readonly MatchPlan[], playedAt: string) {
  const written = plans.filter((plan) => plan.action === "insert" || plan.action === "replace" || plan.action === "refresh");
  // `seen`: the name is in a match this upload brings. A `refresh` rewrites a match already stored,
  // so its names don't count as seen again (`last_seen_at`).
  const names = new Map<string, { name: string; seen: boolean }>();
  const matches = [];
  const players = [];
  const rounds = [];
  const roundPlayers = [];
  const events: EventRow[] = [];

  for (const plan of written) {
    const { match, matchKey } = plan;
    matches.push({
      id: plan.storedId,
      matchKey,
      lineCount: match.lineCount,
      format: match.format,
      gameVersion: match.gameVersion,
      // Format 0 is the legacy v1.3.2 log (#4).
      legacy: match.format === 0 ? 1 : 0,
      status: plan.status,
      rejectionCode: plan.rejection?.code ?? null,
      rejectionMessage: plan.rejection?.message ?? null,
      reviewReasons: plan.reviewReasons.join(",") || null,
      unranked: match.unranked.join(",") || null,
      map: match.settings?.map ?? null,
      preset: match.settings?.preset ?? null,
      playedAt,
      complete: match.endResult !== null ? 1 : 0,
      hostAfk: plan.hostAfk.length ? JSON.stringify(plan.hostAfk) : null,
      uploadHash: plan.uploadHash,
    });

    const stats = matchStats(match);
    for (const player of match.players) {
      const key = nameKey(player.name);
      const seen = plan.action !== "refresh";
      const known = names.get(key);
      if (!known) names.set(key, { name: player.name, seen });
      else known.seen ||= seen;
      players.push({
        matchKey,
        logId: player.id,
        key,
        name: player.name,
        joinTime: player.joinTime,
        kills: stats.kills.get(player.id) ?? 0,
        leaveTime: player.leaveTime,
      });
    }

    const roundNumbers = new Set<number>();
    for (const round of match.rounds) {
      // Round numbers are unique per match in the schema. The game never repeats one; if a log
      // does, the first round with the number is kept.
      if (roundNumbers.has(round.number)) continue;
      roundNumbers.add(round.number);
      const order = isRated(round.finishingOrder) ? round.finishingOrder : null;
      rounds.push({
        matchKey,
        number: round.number,
        result: round.result,
        winnerId: round.winnerId,
        startTime: round.startTime,
        endTime: round.endTime,
        rated: order ? 1 : 0,
        broken: round.broken.join("; ") || null,
      });
      for (const logId of round.playerIds) {
        const elim = round.elims.find((e) => e.id === logId);
        const position = order ? order.indexOf(logId) + 1 : 0;
        roundPlayers.push({
          matchKey,
          round: round.number,
          logId,
          position: position || null,
          place: elim?.place ?? null,
          leftRound: round.leftIds.includes(logId) ? 1 : 0,
          afk: round.afkIds.includes(logId) ? 1 : 0,
          killerId: elim?.killerId ?? null,
          kills: stats.roundKills.get(roundKey(round.number, logId)) ?? 0,
          // Legacy logs have no DEFLECT lines: unknown, not 0.
          deflects: match.format === 0 ? null : (stats.roundDeflects.get(roundKey(round.number, logId)) ?? 0),
        });
      }
    }

    // KILL and DEFLECT lines are kept apart by the parser, each in file order, and `time` only
    // grows through a match, so merging them by time gives the file order back.
    const merged: Omit<EventRow, "matchKey" | "seq">[] = [
      ...match.kills.map((k) => ({ type: "KILL" as const, time: k.time, round: k.round, actor: k.attackerId, target: k.victimId, speed: null })),
      ...match.deflects.map((d) => ({ type: "DEFLECT" as const, time: d.time, round: d.round, actor: d.id, target: d.targetId, speed: d.speed })),
    ].sort((a, b) => a.time - b.time);
    merged.forEach((event, seq) => events.push({ matchKey, seq, ...event }));
  }

  return {
    names: [...names].map(([key, { name, seen }]) => ({ key, name, seen: seen ? 1 : 0 })),
    inserted: matches.filter((m) => m.id === null),
    replaced: matches.filter((m) => m.id !== null),
    players,
    rounds,
    roundPlayers,
    events,
  };
}

export type MatchRows = ReturnType<typeof matchRows>;

/** Key of a player in a round, for `matchStats`. */
const roundKey = (round: number, logId: number) => `${round}:${logId}`;

/**
 * The match page's counts (#15), each line looked at once: `kills` per attacker in the whole match
 * (`KILL` lines with an attacker that aren't a self-kill, as the tourney standings count them), and
 * per attacker in a round, `roundKills` and `roundDeflects`, keyed by `roundKey`. A `KILL` logged
 * after its round's `ROUND_END` in the same tick has no round (the spec doesn't say whether `ELIM`
 * or `KILL` comes first): it counts in the round of the `ELIM` with the same victim and time. Only
 * in new logs: a legacy log's `ELIM`s are rebuilt from its `KILL`s, whose rounds the legacy parser
 * already set (and cleared for a round the file ends in). The rating reads only the `ELIM`s, so
 * nothing else changes.
 */
export function matchStats(match: ParsedMatch) {
  const elimRound = new Map<string, number>();
  if (match.format !== 0) for (const round of match.rounds) for (const e of round.elims) elimRound.set(`${e.id}@${e.time}`, round.number);
  const kills = new Map<number, number>();
  const roundKills = new Map<string, number>();
  const roundDeflects = new Map<string, number>();
  const add = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const k of match.kills) {
    if (k.attackerId === null || k.attackerId === k.victimId) continue;
    add(kills, k.attackerId);
    const round = k.round ?? (k.victimId === null ? undefined : elimRound.get(`${k.victimId}@${k.time}`));
    if (round !== undefined) add(roundKills, roundKey(round, k.attackerId));
  }
  for (const d of match.deflects) add(roundDeflects, roundKey(d.round, d.id));
  return { kills, roundKills, roundDeflects };
}

interface EventRow {
  matchKey: string;
  seq: number;
  type: "KILL" | "DEFLECT";
  time: number;
  round: number | null;
  actor: number | null;
  target: number | null;
  speed: number | null;
}
