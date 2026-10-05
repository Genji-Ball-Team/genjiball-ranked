import { num, stripPrefix } from "./parse";
import type { ElimEvent, KillEvent, ParsedMatch, ParsedPlayer, ParsedRound, Problem } from "./types";

/**
 * The legacy parser (#4): a v1.3.2 log, which has one line per death and nothing else,
 * `KILL|time|attacker|victim` with names (GenjiBall-CE `docs/ranked-log.md`, "Legacy v1.3.2 logs").
 * It rebuilds the rounds from how v1.3.2 plays, and gives the same `ParsedMatch` as a new log, so
 * storing and rating don't change. What it can't know and where it guesses: docs/legacy.md.
 *
 * How v1.3.2 plays, from its code (`original/genjiball-v1.3.2-ranked.txt`):
 * - A round ends when one player is left alive. That winner never dies, so has no line.
 * - Every player dies at most once a round, and everyone is resurrected for the next.
 * - The attacker is the victim when there's no attacker: the ball killed its target before anyone
 *   deflected, the player fell, or the game killed them.
 * - A player who spawns while a round is going is killed at once (no attacker), and plays from the
 *   next round.
 * - After a round is won the game waits 2.25 s, resurrects everyone and counts down 5 s before the
 *   ball spawns, so the next death is at least about 7.6 s later (the AFK rhythm in real logs).
 *
 * One file is one match: `time` never goes back within a file.
 */

export interface LegacyOptions {
  /** Names of AI bots. A round a bot played in isn't rated. From config `legacyBotNames`. */
  botNames: readonly string[];
  /** `gameVersion` recorded for legacy matches. From config `legacyGameVersion`. */
  gameVersion: string;
  /**
   * Shortest time from a round's last death to the next round's first, in seconds. A death sooner
   * than this is in the same round. From config `legacyRoundGapSeconds`.
   */
  roundGapSeconds: number;
  /** Time from a round's win to everyone being resurrected, in seconds. From config `legacyResurrectSeconds`. */
  resurrectSeconds: number;
}

interface Kill {
  line: number;
  time: number;
  attacker: string | null;
  victim: string;
}

/** The legacy match in the file, or `null` when it has no `KILL` line. `matchKey` is left empty for the caller to set. */
export function parseLegacyLog(text: string, options: LegacyOptions): ParsedMatch | null {
  const problems: Problem[] = [];
  const kills: Kill[] = [];
  let lineCount = 0;
  for (const [index, raw] of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).entries()) {
    const fields = stripPrefix(raw).split("|");
    if (fields[0] !== "KILL") continue;
    lineCount++;
    const time = num(fields[1]?.trim());
    const attacker = fields[2]?.trim() ?? "";
    const victim = fields.slice(3).join("|").trim();
    if (time === null || !victim) {
      problems.push({ line: index + 1, message: `Not a KILL|time|attacker|victim line: ${raw.trim()}` });
      continue;
    }
    kills.push({ line: index + 1, time, attacker: attacker && attacker !== victim ? attacker : null, victim });
  }
  if (!lineCount) return null;

  // Players by first appearance. A player is in the lobby from their first line to their last:
  // the log has no joins or leaves, so that's the best guess at who could be alive.
  const ids = new Map<string, number>();
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  kills.forEach((k, i) => {
    for (const name of [k.attacker, k.victim]) {
      if (name === null) continue;
      if (!ids.has(name)) {
        ids.set(name, ids.size + 1);
        first.set(name, i);
      }
      last.set(name, i);
    }
  });
  const id = (name: string) => ids.get(name)!;
  // Possibly killed for joining: their first line, with no attacker.
  const maybeJoin = (k: Kill, i: number) => k.attacker === null && first.get(k.victim) === i;
  /** Time of the next death after kill `i` that may be in a round. */
  const nextDeath = (i: number) => kills.find((k, j) => j > i && !maybeJoin(k, j))?.time ?? null;
  const bots = new Set(options.botNames);

  const rounds: ParsedRound[] = [];
  const killEvents: KillEvent[] = [];
  let open: { number: number; startIndex: number; startTime: number; victims: Kill[]; events: KillEvent[] } | null = null;
  let roundsSeen = 0;
  let lastEnd: number | null = null;
  // Killed on joining: dead until the next round starts, so not in the round they joined during.
  let joined = new Set<string>();

  const close = (lobby: string[], winner: string | null, broken: string | null) => {
    if (!open) return;
    // Everyone who went out, and whoever is still in the lobby (a player's last line may be their
    // death in this round, so the lobby at the end can be smaller than at the start).
    const roster = [...new Set([...open.victims.map((k) => k.victim), ...lobby])];
    const playerIds = roster.map(id).sort((a, b) => a - b);
    const elims: ElimEvent[] = open.victims.map((k, i) => ({
      time: k.time,
      id: id(k.victim),
      killerId: k.attacker === null ? null : id(k.attacker),
      place: roster.length - i,
    }));
    const reasons = broken ? [broken] : [];
    const bot = roster.find((name) => bots.has(name));
    if (!broken && bot) reasons.push(`${bot} (a bot) played: legacy rounds with a bot aren't rated`);
    rounds.push({
      number: open.number,
      startTime: open.startTime,
      endTime: open.victims.at(-1)!.time,
      result: winner === null ? (broken === allDied ? "NONE" : "ABORT") : "WIN",
      playerIds,
      elims,
      leftIds: [],
      afkIds: [],
      winnerId: winner === null ? null : id(winner),
      finishingOrder: winner !== null && !reasons.length ? [id(winner), ...elims.map((e) => e.id).reverse()] : null,
      broken: reasons,
    });
    lastEnd = open.victims.at(-1)!.time;
    open = null;
    joined = new Set();
  };

  kills.forEach((k, i) => {
    const event: KillEvent = {
      time: k.time,
      attackerName: k.attacker,
      victimName: k.victim,
      attackerId: k.attacker === null ? null : id(k.attacker),
      victimId: id(k.victim),
      round: null,
    };
    killEvents.push(event);

    // Killed for spawning while a round is going (the countdown included): their first line, no
    // attacker, once a round has been won. Until then everyone's first death is a real one.
    if (maybeJoin(k, i) && rounds.length > 0) {
      // Killed in the pause after a win, they're resurrected with everyone and play the next round.
      const resurrected = open === null && lastEnd !== null && k.time - lastEnd < options.resurrectSeconds;
      if (!resurrected) joined.add(k.victim);
      return;
    }

    // In the lobby: seen by now, and seen again since the round started (a winner may have no line
    // left after their last kill).
    const since = open?.startIndex ?? i;
    const roster = [...ids.keys()].filter((name) => first.get(name)! <= i && last.get(name)! >= since && !joined.has(name));
    if (roster.length < 2) return; // Alone in the lobby: no round.

    if (open?.victims.some((v) => v.victim === k.victim)) close(roster, null, diedTwice);
    if (!open) {
      roundsSeen++;
      open = { number: roundsSeen, startIndex: i, startTime: k.time, victims: [], events: [] };
    }
    open.victims.push(k);
    open.events.push(event);
    event.round = open.number;

    // One player left wins, unless the next death comes too soon for a new round: then someone we
    // haven't seen yet (no line so far) is still alive in this one.
    const alive = roster.filter((name) => !open!.victims.some((v) => v.victim === name));
    const next = nextDeath(i);
    if (next !== null && next - k.time < options.roundGapSeconds) return;
    if (alive.length === 1) close(roster, alive[0]!, null);
    else if (alive.length === 0) close(roster, null, allDied);
  });
  // A round the file ends in has no winner yet: dropped, like a new log's round without ROUND_END.
  if (open) (open as { events: KillEvent[] }).events.forEach((e) => (e.round = null));

  const players: ParsedPlayer[] = [...ids.keys()].map((name) => ({
    id: id(name),
    name,
    joinTime: kills[first.get(name)!]!.time,
    leaveTime: null,
    // v1.3.2 logs don't say who hosted.
    host: false,
  }));

  return {
    format: 0,
    gameVersion: options.gameVersion,
    matchKey: "",
    startLine: kills[0]?.line ?? 1,
    lineCount,
    rejection: null,
    unranked: [],
    review: [],
    settings: null,
    startTime: kills[0]?.time ?? null,
    // The file is all there is: nothing longer will come, so the match is as complete as it gets.
    endResult: "LEGACY",
    endTime: kills.at(-1)?.time ?? null,
    players,
    rounds,
    kills: killEvents,
    deflects: [],
    problems,
  };
}

const diedTwice = "a player died twice before the round had a winner: someone joined or left unseen";
const allDied = "everyone in the round died";
