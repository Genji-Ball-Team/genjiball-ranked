import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { parseLegacyLog } from "../src/parser/legacy";
import type { ParsedMatch } from "../src/parser/types";
import { sha256, type UploadResponse } from "../src/upload/handler";

const options = { botNames: ["Genji Bot"], gameVersion: "1.3.2", roundGapSeconds: 7, resurrectSeconds: 2.25 };
const log = (...lines: string[]) => lines.map((line) => `[00:00:01] KILL|${line}`).join("\r\n");
const parse = (text: string) => parseLegacyLog(text, options)!;
const names = (m: ParsedMatch, ids: readonly number[] | null) => ids?.map((id) => m.players.find((p) => p.id === id)!.name) ?? null;

describe("parseLegacyLog", () => {
  it("rebuilds rounds: one player left alive wins, the order is the reverse of who went out", () => {
    const m = parse(
      log(
        "10.00|Alpha|Bravo",
        "12.50|Alpha|Charlie", // 2.5 s later: too soon for a new round, so Charlie was in this one
        "20.00|Bravo|Alpha",
        "21.00|Charlie|Charlie", // the ball got Charlie before anyone deflected: no attacker
      ),
    );
    expect(m.format).toBe(0);
    expect(m.gameVersion).toBe("1.3.2");
    expect(m.matchKey).toBe("");
    expect(m.endResult).not.toBeNull();
    expect(m.players.map((p) => p.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(m.rounds).toHaveLength(2);

    const [r1, r2] = m.rounds;
    expect(r1!.result).toBe("WIN");
    expect(names(m, [r1!.winnerId!])).toEqual(["Alpha"]);
    expect(names(m, r1!.finishingOrder)).toEqual(["Alpha", "Charlie", "Bravo"]);
    expect(r1!.elims.map((e) => [names(m, [e.id])![0], e.killerId === null ? null : names(m, [e.killerId])![0], e.place])).toEqual([
      ["Bravo", "Alpha", 3],
      ["Charlie", "Alpha", 2],
    ]);
    expect(names(m, r2!.finishingOrder)).toEqual(["Bravo", "Charlie", "Alpha"]);
    expect(m.kills.map((k) => k.round)).toEqual([1, 1, 2, 2]);
    expect(m.kills[3]!.attackerId).toBeNull();
  });

  it("leaves a player killed for joining mid-round out of that round; they play the next", () => {
    const m = parse(
      log(
        "10.00|Alpha|Bravo",
        "11.00|Alpha|Charlie", // round 1: Alpha, Bravo, Charlie
        "20.00|Bravo|Alpha", // round 2 starts
        "21.00|Delta|Delta", // Delta spawns mid-round and is killed: not in round 2
        "25.00|Bravo|Charlie",
        "35.00|Delta|Alpha", // round 3: Delta plays
        "36.00|Delta|Bravo",
        "37.00|Delta|Charlie",
      ),
    );
    expect(m.rounds.map((r) => names(m, r.finishingOrder))).toEqual([
      ["Alpha", "Charlie", "Bravo"],
      ["Bravo", "Charlie", "Alpha"],
      ["Delta", "Charlie", "Bravo", "Alpha"],
    ]);
    expect(m.kills[3]!.round).toBeNull();
  });

  it("lets a player killed for joining just after a win play the next round", () => {
    // Delta dies 1 s after round 2 is won, before everyone is resurrected (2.25 s), so is resurrected too.
    const m = parse(log("10.00|Alpha|Bravo", "20.00|Bravo|Alpha", "21.00|Delta|Delta", "30.00|Delta|Alpha", "31.00|Delta|Bravo"));
    expect(names(m, m.rounds[2]!.finishingOrder)).toEqual(["Delta", "Bravo", "Alpha"]);
  });

  it("doesn't rate a round a bot played in", () => {
    const m = parse(log("10.00|Genji Bot|Alpha", "11.00|Bravo|Genji Bot", "20.00|Alpha|Bravo", "21.00|Alpha|Genji Bot"));
    expect(m.rounds).toHaveLength(2);
    for (const round of m.rounds) {
      expect(round.result).toBe("WIN");
      expect(round.finishingOrder).toBeNull();
      expect(round.broken[0]).toContain("Genji Bot");
    }
  });

  it("gives up on a round where a player dies twice before anyone won", () => {
    const m = parse(log("10.00|Alpha|Bravo", "15.00|Alpha|Bravo", "30.00|Charlie|Alpha", "31.00|Charlie|Bravo"));
    expect(m.rounds[0]!.result).toBe("ABORT");
    expect(m.rounds[0]!.finishingOrder).toBeNull();
    expect(m.rounds[0]!.broken[0]).toContain("died twice");
    expect(names(m, m.rounds.at(-1)!.finishingOrder)).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("has no round while one player is alone in the lobby", () => {
    const m = parse(log("5.00|Alpha|Alpha", "12.60|Alpha|Alpha", "20.00|Bravo|Alpha", "30.00|Alpha|Bravo"));
    expect(m.rounds.map((r) => names(m, r.finishingOrder))).toEqual([
      ["Bravo", "Alpha"],
      ["Alpha", "Bravo"],
    ]);
    expect(m.kills.map((k) => k.round)).toEqual([null, null, 1, 2]);
  });

  it("reads names with spaces and trailing blanks, and skips lines that aren't KILL", () => {
    const m = parse(["[00:00:01] something else", "[00:00:02] KILL|10,50|zSh4d0Ws bozo|MrPichulin ", "[00:00:03] KILL|11.00|MrPichulin|zSh4d0Ws bozo"].join("\n"));
    expect(m.lineCount).toBe(2);
    expect(m.players.map((p) => p.name)).toEqual(["zSh4d0Ws bozo", "MrPichulin"]);
    expect(m.kills[0]!.time).toBe(10.5);
  });

  it("returns null for a file without KILL lines", () => {
    expect(parseLegacyLog("[00:00:01] hello\n", options)).toBeNull();
  });
});

const db = () => env.DB;
const adminToken = "admin-token";

/** A legacy match of 4 players and 2 rated rounds (Alpha wins the first, Bravo the second). */
const legacyFile = log(
  "10.00|Alpha|Bravo",
  "11.00|Alpha|Charlie",
  "12.00|Alpha|Delta",
  "20.00|Bravo|Alpha",
  "21.00|Bravo|Charlie",
  "22.00|Bravo|Delta",
);

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = ["admin_actions", "admins", "events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts"];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO admins (id, name, token_hash) VALUES (1, 'Ada', ?)").bind(await sha256(adminToken)),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'Fealthy', ?, 'untrusted', 'eu')").bind(await sha256("host-token")),
  ]);
});

function importLegacy(body: string, query = "?host=1", token = adminToken) {
  return SELF.fetch(`https://example.com/api/admin/legacy-import${query}`, {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}`, "X-Log-File": "Log-2026-09-22-21-27-16.txt", "X-Log-Started-At": "2026-09-22T21:27:16+02:00" },
  });
}

describe("POST /api/admin/legacy-import", () => {
  it("stores the file as the host's legacy match and rates it", async () => {
    const res = await importLegacy(legacyFile);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResponse;
    expect(body.result).toBe("stored");
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]!.matchKey).toMatch(/^legacy-[0-9a-f]{16}$/);
    // The admin vouches for the file: accepted even though the host is untrusted.
    expect(body.matches[0]!.status).toBe("accepted");

    const match = await db()
      .prepare("SELECT host_id AS hostId, legacy, format, game_version AS gameVersion, played_at AS playedAt, complete, rated_at AS ratedAt FROM matches")
      .first();
    expect(match).toMatchObject({ hostId: 1, legacy: 1, format: 0, gameVersion: defaults.legacyGameVersion, playedAt: "2026-09-22T19:27:16Z", complete: 1 });
    expect(match!.ratedAt).not.toBeNull();
    const rounds = await db().prepare("SELECT number, rated FROM rounds ORDER BY number").all();
    expect(rounds.results).toEqual([
      { number: 1, rated: 1 },
      { number: 2, rated: 1 },
    ]);
    const action = await db().prepare("SELECT admin_id AS adminId, action, host_id AS hostId, detail FROM admin_actions").first();
    expect(action).toEqual({ adminId: 1, action: "legacy_import", hostId: 1, detail: JSON.stringify({ file: "Log-2026-09-22-21-27-16.txt" }) });
  });

  it("says duplicate for the same file again", async () => {
    await importLegacy(legacyFile);
    expect(((await (await importLegacy(legacyFile)).json()) as UploadResponse).result).toBe("duplicate");
    expect((await db().prepare("SELECT count(*) AS n FROM matches").first())!.n).toBe(1);
  });

  it("refuses a new log, a file without KILL lines, a missing host and a non-admin", async () => {
    const ranked = "[00:00:01] GBR|1.00|1|1.3.3R|000000000001\n[00:00:01] KILL|3.00|Alpha|Bravo|1|2";
    expect((await importLegacy(ranked)).status).toBe(422);
    expect((await importLegacy("[00:00:01] hello")).status).toBe(422);
    expect((await importLegacy(legacyFile, "")).status).toBe(400);
    expect((await importLegacy(legacyFile, "?host=9")).status).toBe(404);
    expect((await importLegacy(legacyFile, "?host=1", "host-token")).status).toBe(401);
  });

  it("is still refused by the upload endpoint", async () => {
    const res = await SELF.fetch("https://example.com/api/upload", { method: "POST", body: legacyFile, headers: { Authorization: "Bearer host-token" } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("legacy_log");
  });
});
