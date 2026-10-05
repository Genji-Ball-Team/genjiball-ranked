import { describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { parseLog } from "../src/parser/parse";
import { dropsHost, parseHostAfkHeader, unionRounds, withHostAfk } from "../src/upload/hostAfk";
import { planUpload, type StoredCopy } from "../src/upload/plan";
import example from "./fixtures/ranked-log-example.txt?raw";

const parse = (text: string) => parseLog(text, { acceptedFormats: defaults.acceptedLogFormats }).matches[0]!;
const header = (value: string | null) => parseHostAfkHeader(value, defaults);

describe("X-Host-Afk header", () => {
  it("reads rounds per match key, sorted, without repeats", () => {
    expect(header("482913507226:3,4,5")).toEqual(new Map([["482913507226", [3, 4, 5]]]));
    expect(header(" 000000000001 : 5, 3 ,3 ; 000000000002:1;000000000001:2 ; ")).toEqual(
      new Map([
        ["000000000001", [2, 3, 5]],
        ["000000000002", [1]],
      ]),
    );
    expect(header("000000000001:")).toEqual(new Map([["000000000001", []]]));
  });

  it("is no rounds when missing or blank", () => {
    expect(header(null)).toEqual(new Map());
    expect(header("  ")).toEqual(new Map());
  });

  it("refuses a malformed header with a message", () => {
    for (const bad of ["3,4,5", "000000000001:x", "000000000001:0", "000000000001:-1", "000000000001:1.5", ":3", "a b:3", "000000000001:3:4"]) {
      expect(typeof header(bad), bad).toBe("string");
    }
    expect(header("000000000001:x")).toBe('X-Host-Afk: "x" isn\'t a round number (match 000000000001)');
  });

  it("bounds the rounds a match and the matches", () => {
    const rounds = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(",");
    expect(header(`000000000001:${rounds(defaults.hostAfkMaxRounds)}`)).toBeInstanceOf(Map);
    expect(header(`000000000001:${rounds(defaults.hostAfkMaxRounds + 1)}`)).toBe(
      `X-Host-Afk: at most ${defaults.hostAfkMaxRounds} rounds a match (match 000000000001)`,
    );
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `${i}:1`).join(";");
    expect(header(keys(defaults.hostMatchKeysMax))).toBeInstanceOf(Map);
    expect(header(keys(defaults.hostMatchKeysMax + 1))).toBe(`X-Host-Afk: at most ${defaults.hostMatchKeysMax} matches`);
  });

  it("unions rounds, keeping the lowest past the limit", () => {
    expect(unionRounds([1, 4], [4, 2], 10)).toEqual([1, 2, 4]);
    expect(unionRounds([1, 4], [4, 2], 2)).toEqual([1, 2]);
  });
});

describe("withHostAfk: the spec example, Sparrow (1) hosting", () => {
  const match = parse(example);

  it("drops the host from the AFK rounds only, the others keeping their order", () => {
    const afk = withHostAfk(match, [1, 2]);
    expect(afk.rounds.map((r) => [r.number, r.finishingOrder, r.afkIds])).toEqual([
      [1, [5, 3, 4], [1]],
      [2, [6, 5, 4, 3], [1]],
      [3, [1, 4, 5, 3, 6], []],
    ]);
    // Stats and the parse itself don't change.
    expect(afk.rounds.map((r) => r.winnerId)).toEqual([1, 6, 1]);
    expect(afk.kills).toBe(match.kills);
    expect(match.rounds[0]!.finishingOrder).toEqual([1, 5, 3, 4]);
  });

  it("changes nothing for rounds the match doesn't have, or a log with no host", () => {
    expect(withHostAfk(match, [9])).toBe(match);
    expect(dropsHost(match, [9])).toBe(false);
    expect(dropsHost(match, [3])).toBe(true);
    const noHost = parse(example.replace("|Sparrow|1", "|Sparrow|"));
    expect(withHostAfk(noHost, [1, 2, 3])).toBe(noHost);
  });

  it("drops every id of a host who rejoined, and not one who left the round", () => {
    const lines = [
      "GBR|1|1|1.3.3R|000000000001",
      "MATCH_START|1|workshop-island-night|Default|0|",
      "JOIN|1|1|Host|1",
      "JOIN|1|2|B|",
      "JOIN|1|3|C|",
      "ROUND_START|2|1|1,2,3",
      "LEAVE|3|1",
      "ELIM|4|1|3|2|2",
      "ROUND_END|4|1|2|WIN",
      "JOIN|5|4|Host|1",
      "ROUND_START|6|2|2,3,4",
      "ELIM|7|2|3|4|3",
      "ELIM|8|2|2|4|2",
      "ROUND_END|8|2|4|WIN",
    ];
    const afk = withHostAfk(parse(lines.join("\n")), [1, 2]);
    expect(afk.rounds.map((r) => [r.finishingOrder, r.leftIds, r.afkIds])).toEqual([
      [[2, 3], [1], []],
      [[2, 3], [], [4]],
    ]);
  });

  it("leaves a round with fewer than 2 players unrated, and the match too few players", () => {
    const lines = [
      "GBR|1|1|1.3.3R|000000000001",
      "MATCH_START|1|workshop-island-night|Default|0|",
      "JOIN|1|1|Host|1",
      "JOIN|1|2|B|",
      "ROUND_START|2|1|1,2",
      "ELIM|3|1|2|1|2",
      "ROUND_END|3|1|1|WIN",
      "MATCH_END|4|TIME",
    ];
    const [plan] = planUpload([parse(lines.join("\n"))], [], "trusted", defaults, { hostAfk: new Map([["000000000001", [1]]]) });
    expect(plan!.match.rounds[0]!.finishingOrder).toEqual([2]);
    expect(plan!.status).toBe("rejected");
    expect(plan!.rejection?.code).toBe("too_few_players");
  });
});

describe("planUpload with host AFK rounds", () => {
  const match = parse(example);
  const copy = (lineCount: number, hostAfk: number[]): StoredCopy => ({
    id: 7,
    matchKey: match.matchKey,
    lineCount,
    status: "review",
    rejection: null,
    uploadId: 3,
    uploadHash: "stored-hash",
    region: "eu",
    hostAfk,
  });
  const afk = (rounds: number[]) => ({ hostAfk: new Map([[match.matchKey, rounds]]) });
  const plan = (stored: StoredCopy[], options = {}) => planUpload([match], stored, "trusted", defaults, options)[0]!;

  it("keeps the union of the stored rounds and the header's", () => {
    expect(plan([], afk([2]))).toMatchObject({ action: "insert", hostAfk: [2] });
    expect(plan([copy(10, [1])], afk([2]))).toMatchObject({ action: "replace", hostAfk: [1, 2] });
    expect(plan([copy(10, [1])])).toMatchObject({ action: "replace", hostAfk: [1] });
  });

  it("refreshes a stored copy as long as this file from this file, when new rounds drop the host", () => {
    expect(plan([copy(match.lineCount, [1])], afk([1, 2]))).toMatchObject({ action: "refresh", uploadHash: "stored-hash", hostAfk: [1, 2] });
    expect(plan([copy(match.lineCount, [1])], afk([1]))).toMatchObject({ action: "repoint", hostAfk: [1] });
    expect(plan([copy(match.lineCount, [1])], afk([9]))).toMatchObject({ action: "repoint", hostAfk: [1] });
    expect(plan([copy(match.lineCount, [1])], { ...afk([1, 2]), duplicate: true })).toMatchObject({ action: "refresh" });
    expect(plan([copy(match.lineCount, [])], { ...afk([]), duplicate: true })).toMatchObject({ action: "skip" });
  });

  it("asks for the stored log of a longer copy, then refreshes from it", () => {
    expect(plan([copy(99, [])], afk([1]))).toMatchObject({ action: "skip", needsStoredCopy: true, hostAfk: [] });
    expect(plan([copy(99, [1])], afk([1]))).toMatchObject({ action: "skip", needsStoredCopy: false });
    const longer = { ...match, lineCount: 99 };
    const storedMatches = new Map([[match.matchKey, longer]]);
    expect(plan([copy(99, [])], { ...afk([1]), storedMatches })).toMatchObject({ action: "refresh", lineCount: 99, hostAfk: [1] });
    expect(plan([copy(99, [])], { ...afk([9]), storedMatches })).toMatchObject({ action: "skip", needsStoredCopy: false });
  });
});
