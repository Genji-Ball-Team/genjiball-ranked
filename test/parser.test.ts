import { describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { parseLog } from "../src/parser/parse";
import example from "./fixtures/ranked-log-example.txt?raw";

const options = { acceptedFormats: defaults.acceptedLogFormats };
const parse = (text: string) => parseLog(text, options);

/** Builds a log from lines without the Workshop prefix, adding a prefix to every other one. */
function log(...lines: string[]): string {
  return lines.map((line, i) => (i % 2 ? `[00:00:${String(i).padStart(2, "0")}] ${line}` : line)).join("\n");
}

const header = ["GBR|1.00|1|1.3.3R|000000000001", "MATCH_START|1.00|workshop-island-night|Default|0|"];

describe("parseLog: the spec example", () => {
  const result = parse(example);
  const match = result.matches[0]!;

  it("finds one match and skips the line that isn't ours", () => {
    expect(result.matches).toHaveLength(1);
    expect(result.legacy).toBe(false);
    expect(match.problems).toEqual([]);
  });

  it("reads the header and settings", () => {
    expect(match).toMatchObject({
      format: 1,
      gameVersion: "1.3.3R",
      matchKey: "482913507226",
      startLine: 2,
      lineCount: 56,
      rejection: null,
      unranked: [],
      startTime: 2.38,
      endResult: "TIME",
      endTime: 114,
    });
    expect(match.settings).toEqual({ map: "workshop-island-night", preset: "Default", feel: false, addOns: [] });
  });

  it("reads players, with the leaver and two players named Ghost", () => {
    expect(match.players.map((p) => [p.id, p.name, p.leaveTime])).toEqual([
      [1, "Sparrow", null],
      [2, "Tidal", 36.5],
      [3, "Mochi", null],
      [4, "Ghost", null],
      [5, "Ghost", null],
      [6, "Nova", null],
    ]);
    expect(match.review).toEqual(["duplicate_name"]);
  });

  it("marks Sparrow as the host from JOIN's host field, and no one else", () => {
    expect(match.players.filter((p) => p.host).map((p) => p.id)).toEqual([1]);
    expect(match.rounds.every((r) => r.afkIds.length === 0)).toBe(true);
  });

  it("gives the finishing orders from the spec", () => {
    expect(match.rounds.map((r) => [r.number, r.result, r.playerIds, r.finishingOrder, r.leftIds])).toEqual([
      [1, "WIN", [1, 2, 3, 4, 5], [1, 5, 3, 4], [2]],
      [2, "WIN", [1, 3, 4, 5, 6], [6, 5, 1, 4, 3], []],
      [3, "WIN", [1, 3, 4, 5, 6], [1, 4, 5, 3, 6], []],
    ]);
    expect(match.rounds.flatMap((r) => r.broken)).toEqual([]);
  });

  it("keeps places as logged, with place 3 skipped in round 1", () => {
    expect(match.rounds[0]!.elims.map((e) => e.place)).toEqual([5, 4, 2]);
  });

  it("counts round wins: Sparrow 2, Nova 1", () => {
    const wins = match.rounds.map((r) => r.winnerId);
    expect(wins.filter((id) => id === 1)).toHaveLength(2);
    expect(wins.filter((id) => id === 6)).toHaveLength(1);
  });

  it("reads a fall as a kill and an elim with no killer", () => {
    const fall = match.kills.find((k) => k.time === 58.4)!;
    expect(fall).toMatchObject({ attackerName: null, attackerId: null, victimName: "Ghost", victimId: 4, round: 2 });
    expect(match.rounds[1]!.elims[1]).toMatchObject({ id: 4, killerId: null });
  });

  it("reads every kill and deflect", () => {
    expect(match.kills).toHaveLength(11);
    expect(match.kills.filter((k) => k.attackerId !== null)).toHaveLength(10);
    expect(match.deflects).toHaveLength(18);
    expect(match.deflects[0]).toEqual({ time: 26.1, round: 1, id: 3, speed: 21, targetId: 1 });
  });
});

describe("parseLog: lines and fields", () => {
  it("accepts , as the decimal mark", () => {
    const match = parse(log(...header.map((l) => l.replace("1.00", "1,50")), "MATCH_END|9,25|TIME")).matches[0]!;
    expect(match.startTime).toBe(1.5);
    expect(match.endTime).toBe(9.25);
  });

  it("ignores extra trailing fields and unknown event types", () => {
    const match = parse(
      log(...header, "JOIN|2|1|A|extra", "FUTURE_EVENT|2|x", "JOIN|2|2|B", "MATCH_END|3|TIME|more"),
    ).matches[0]!;
    expect(match.players.map((p) => p.name)).toEqual(["A", "B"]);
    expect(match.endResult).toBe("TIME");
    expect(match.problems).toEqual([]);
    expect(match.lineCount).toBe(5);
  });

  it("handles CRLF line endings and a BOM", () => {
    const match = parse("﻿" + log(...header, "MATCH_END|3|TIME").replace(/\n/g, "\r\n")).matches[0]!;
    expect(match.matchKey).toBe("000000000001");
    expect(match.endResult).toBe("TIME");
  });

  it("keeps the matchKey as text, with leading zeros", () => {
    expect(parse(log(...header)).matches[0]!.matchKey).toBe("000000000001");
  });

  it("reports a broken line and carries on", () => {
    const match = parse(log(...header, "JOIN|abc|1|A", "JOIN|2|x|B", "JOIN|2|2|C")).matches[0]!;
    expect(match.players.map((p) => p.name)).toEqual(["C"]);
    expect(match.problems.map((p) => [p.line, p.message])).toEqual([
      [3, "JOIN has no valid time"],
      [4, "JOIN: bad player id"],
    ]);
  });
});

describe("parseLog: matches", () => {
  it("splits a file with several matches, and time restarts in each", () => {
    const result = parse(
      log(
        ...header,
        "MATCH_END|50|TIME",
        "KILL|51|A|B|1|2",
        "GBR|0.50|1|1.3.3R|000000000002",
        "MATCH_START|0.50|workshop-island-night|Default|0|",
        "MATCH_END|40|TIME",
      ),
    );
    expect(result.matches.map((m) => [m.matchKey, m.startLine, m.startTime, m.lineCount])).toEqual([
      ["000000000001", 1, 1, 3],
      ["000000000002", 5, 0.5, 3],
    ]);
    // The KILL after MATCH_END belongs to no match.
    expect(result.matches[0]!.kills).toEqual([]);
  });

  it("rejects a match with an unknown format version and skips its lines", () => {
    const result = parse(
      log("GBR|1|2|1.4.0R|000000000009", "MATCH_START|1|x|y|0|", "GBR|1|1|1.3.3R|000000000001", "MATCH_END|3|TIME"),
    );
    expect(result.matches[0]).toMatchObject({ format: 2, lineCount: 1, settings: null });
    expect(result.matches[0]!.rejection?.code).toBe("unknown_format");
    expect(result.matches[1]!.rejection).toBeNull();
  });

  it("rejects a match with any UNRANKED line, and lists every reason once", () => {
    const match = parse(log(...header, "UNRANKED|1|MAP", "UNRANKED|1|BOT", "UNRANKED|2|BOT")).matches[0]!;
    expect(match.rejection).toEqual({ code: "unranked", message: "Unranked match: MAP" });
    expect(match.unranked).toEqual(["MAP", "BOT"]);
  });

  it("keeps only finished rounds when the file ends without MATCH_END", () => {
    const match = parse(
      log(
        ...header,
        "JOIN|1|1|A",
        "JOIN|1|2|B",
        "ROUND_START|2|1|1,2",
        "ELIM|3|1|2|1|2",
        "ROUND_END|3|1|1|WIN",
        "ROUND_START|4|2|1,2",
        "ELIM|5|2|1|2|2",
      ),
    ).matches[0]!;
    expect(match.endResult).toBeNull();
    expect(match.rounds.map((r) => r.number)).toEqual([1]);
    expect(match.problems.map((p) => [p.line, p.message])).toEqual([[9, "round 2 has no ROUND_END (file ended)"]]);
  });

  it("flags a log with KILL lines and no GBR as legacy", () => {
    const result = parse("[00:00:05] KILL|5.00|A|B\n[00:00:09] KILL|9.00|B|C");
    expect(result).toEqual({ matches: [], legacy: true });
  });

  it("returns nothing for a file that isn't a ranked log", () => {
    expect(parse("[00:00:01] hello\n\n")).toEqual({ matches: [], legacy: false });
  });

  it("ignores legacy KILL lines before the first GBR", () => {
    const result = parse(log("KILL|1|A|B", ...header, "MATCH_END|3|TIME"));
    expect(result.legacy).toBe(false);
    expect(result.matches[0]!.kills).toEqual([]);
  });
});

describe("parseLog: rounds", () => {
  const players = ["JOIN|1|1|A", "JOIN|1|2|B", "JOIN|1|3|C"];

  it("orders by file position, whichever of ELIM and KILL comes first", () => {
    const match = parse(
      log(
        ...header,
        ...players,
        "ROUND_START|2|1|1,2,3",
        "ELIM|3|1|3|1|3",
        "KILL|3|A|C|1|3",
        "KILL|3|A|B|1|2",
        "ELIM|3|1|2|1|2",
        "ROUND_END|3|1|1|WIN",
      ),
    ).matches[0]!;
    expect(match.rounds[0]!.finishingOrder).toEqual([1, 2, 3]);
    expect(match.kills.map((k) => k.round)).toEqual([1, 1]);
  });

  it("doesn't rate NONE or ABORT rounds", () => {
    const match = parse(
      log(
        ...header,
        ...players,
        "ROUND_START|2|1|1,2",
        "ELIM|3|1|1||2",
        "ELIM|3|1|2||1",
        "ROUND_END|3|1||NONE",
        "ROUND_START|4|2|1,2,3",
        "ROUND_END|5|2||ABORT",
      ),
    ).matches[0]!;
    expect(match.rounds.map((r) => [r.result, r.winnerId, r.finishingOrder])).toEqual([
      ["NONE", null, null],
      ["ABORT", null, null],
    ]);
  });

  it("marks a round broken when a listed player has no ELIM, LEAVE or win", () => {
    const match = parse(
      log(...header, ...players, "ROUND_START|2|1|1,2,3", "ELIM|3|1|3|1|3", "ROUND_END|3|1|1|WIN"),
    ).matches[0]!;
    expect(match.rounds[0]!.broken).toEqual(["player 2 has no ELIM, LEAVE or win"]);
    expect(match.rounds[0]!.finishingOrder).toBeNull();
  });

  it("drops a leaver from the order without counting them as eliminated", () => {
    const match = parse(
      log(...header, ...players, "ROUND_START|2|1|1,2,3", "LEAVE|3|2", "ELIM|4|1|3|1|2", "ROUND_END|4|1|1|WIN"),
    ).matches[0]!;
    expect(match.rounds[0]).toMatchObject({ leftIds: [2], finishingOrder: [1, 3] });
  });

  it("doesn't count a player who leaves after being eliminated as a leaver", () => {
    const match = parse(
      log(
        ...header,
        ...players,
        "ROUND_START|2|1|1,2,3",
        "ELIM|3|1|3|1|3",
        "LEAVE|3|3",
        "ELIM|4|1|2|1|2",
        "ROUND_END|4|1|1|WIN",
      ),
    ).matches[0]!;
    expect(match.rounds[0]).toMatchObject({ leftIds: [], finishingOrder: [1, 2, 3] });
  });

  it("doesn't put a player who joins mid-round in that round", () => {
    const match = parse(
      log(
        ...header,
        "JOIN|1|1|A",
        "JOIN|1|2|B",
        "ROUND_START|2|1|1,2",
        "JOIN|3|3|C",
        "KILL|3||C||3",
        "ELIM|4|1|2|1|2",
        "ROUND_END|4|1|1|WIN",
      ),
    ).matches[0]!;
    expect(match.rounds[0]!.finishingOrder).toEqual([1, 2]);
    expect(match.kills[0]).toMatchObject({ attackerId: null, victimId: 3, round: 1 });
  });

  it("accepts a KILL with no victim id (killed before spawning)", () => {
    const match = parse(log(...header, "KILL|2||D||")).matches[0]!;
    expect(match.kills[0]).toMatchObject({ victimName: "D", victimId: null, round: null });
    expect(match.problems).toEqual([]);
  });

  it("reports an ELIM for a round that isn't in progress", () => {
    const match = parse(log(...header, ...players, "ELIM|3|1|2|1|2")).matches[0]!;
    expect(match.problems.map((p) => p.message)).toEqual(["ELIM: round 1 isn't in progress"]);
  });

  it("drops a round that never ended when the next one starts", () => {
    const match = parse(
      log(
        ...header,
        ...players,
        "ROUND_START|2|1|1,2",
        "ROUND_START|4|2|1,2",
        "ELIM|5|2|2|1|2",
        "ROUND_END|5|2|1|WIN",
      ),
    ).matches[0]!;
    expect(match.rounds.map((r) => r.number)).toEqual([2]);
    expect(match.problems.map((p) => p.message)).toEqual(["round 1 has no ROUND_END before round 2"]);
  });
});

describe("parseLog: players", () => {
  it("doesn't flag a player who leaves and rejoins under a new id as a duplicate name", () => {
    const match = parse(log(...header, "JOIN|1|1|A", "LEAVE|2|1", "JOIN|3|2|A")).matches[0]!;
    expect(match.review).toEqual([]);
    expect(match.players.map((p) => [p.id, p.leaveTime])).toEqual([
      [1, 2],
      [2, null],
    ]);
  });

  it("reports a round that lists a player who never joined", () => {
    const match = parse(log(...header, "JOIN|1|1|A", "ROUND_START|2|1|1,7")).matches[0]!;
    expect(match.problems.map((p) => p.message)).toEqual([
      "ROUND_START: round 1 lists players that never joined: 7",
    ]);
  });
  it("reads the host field: 1 is the host, a host who rejoins is marked again, an older log has no host", () => {
    const match = parse(log(...header, "JOIN|1|1|A|1", "JOIN|1|2|B|", "LEAVE|2|1", "JOIN|3|3|A|1", "JOIN|3|4|C|0")).matches[0]!;
    expect(match.players.map((p) => [p.id, p.host])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, false],
    ]);
    expect(match.problems).toEqual([]);
    const old = parse(log(...header, "JOIN|1|1|A", "JOIN|1|2|B")).matches[0]!;
    expect(old.players.map((p) => p.host)).toEqual([false, false]);
  });
});
