import type { Config } from "../config";
import type { ParsedMatch } from "../parser/types";

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
  uploadId: number;
}

/** What happens to one match of the file. */
export type MatchAction =
  /** No stored copy: insert it. */
  | "insert"
  /** The stored copy is shorter: replace its rows with this one. */
  | "replace"
  /** The stored copy is the same: point it at this upload, so the older file can go. */
  | "repoint"
  /** The stored copy is longer, or the match can't be stored: nothing to do. */
  | "skip";

export interface MatchPlan {
  matchKey: string;
  lineCount: number;
  action: MatchAction;
  /** Id of the stored copy, for `replace` and `repoint`. */
  storedId: number | null;
  /** Upload the stored copy is in, so that upload can be deleted once nothing points at it. */
  storedUploadId: number | null;
  /** The match's status after this upload (the stored one for `skip`). */
  status: MatchStatus;
  rejection: { code: string; message: string } | null;
  reviewReasons: string[];
  match: ParsedMatch;
}

export type PlanConfig = Pick<Config, "minMatchPlayers" | "untrustedHostUploads">;

export function planUpload(
  matches: readonly ParsedMatch[],
  stored: readonly StoredCopy[],
  trust: HostTrust,
  config: PlanConfig,
): MatchPlan[] {
  const storedByKey = new Map(stored.map((copy) => [copy.matchKey, copy]));
  return longestCopies(matches).map((match) => {
    const verdict = judge(match, trust, config);
    const copy = storedByKey.get(match.matchKey);
    const plan: MatchPlan = {
      matchKey: match.matchKey,
      lineCount: match.lineCount,
      action: "insert",
      storedId: copy?.id ?? null,
      storedUploadId: copy?.uploadId ?? null,
      ...verdict,
      match,
    };

    if (!match.matchKey) return { ...plan, action: "skip" };
    if (!copy) return plan;
    if (copy.lineCount > match.lineCount) return { ...plan, action: "skip", status: copy.status };
    // An admin's void survives a longer copy of the match.
    const status = copy.status === "void" ? "void" : plan.status;
    return { ...plan, status, action: copy.lineCount === match.lineCount ? "repoint" : "replace" };
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
    return reject("too_few_players", `${players} players in rated rounds, the minimum is ${config.minMatchPlayers}`);
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
  const written = plans.filter((plan) => plan.action === "insert" || plan.action === "replace");
  const names = new Map<string, string>();
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
      status: plan.status,
      rejectionCode: plan.rejection?.code ?? null,
      rejectionMessage: plan.rejection?.message ?? null,
      reviewReasons: plan.reviewReasons.join(",") || null,
      unranked: match.unranked.join(",") || null,
      map: match.settings?.map ?? null,
      preset: match.settings?.preset ?? null,
      playedAt,
      complete: match.endResult !== null ? 1 : 0,
    });

    for (const player of match.players) {
      const key = nameKey(player.name);
      if (!names.has(key)) names.set(key, player.name);
      players.push({
        matchKey,
        logId: player.id,
        key,
        name: player.name,
        joinTime: player.joinTime,
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
          killerId: elim?.killerId ?? null,
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
    names: [...names].map(([key, name]) => ({ key, name })),
    inserted: matches.filter((m) => m.id === null),
    replaced: matches.filter((m) => m.id !== null),
    players,
    rounds,
    roundPlayers,
    events,
  };
}

export type MatchRows = ReturnType<typeof matchRows>;

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
