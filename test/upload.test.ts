import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { createLogger } from "../src/log";
import { handleUpload, sha256, type UploadResponse } from "../src/upload/handler";
import example from "./fixtures/ranked-log-example.txt?raw";

const db = () => env.DB;
const tokens = { trusted: "trusted-token", untrusted: "untrusted-token", revoked: "revoked-token" };

beforeEach(async () => {
  // Storage is isolated per test file, not per test.
  const tables = ["events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts"];
  await db().batch(tables.map((t) => db().prepare(`DELETE FROM ${t}`)));
  const hosts = await Promise.all(Object.entries(tokens).map(async ([trust, token]) => ({ trust, hash: await sha256(token) })));
  await db().batch(
    hosts.map(({ trust, hash }, i) =>
      db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (?, ?, ?, ?, 'eu')").bind(i + 1, trust, hash, trust),
    ),
  );
});

function upload(body: string, token: string | null = tokens.trusted, headers: Record<string, string> = {}) {
  return SELF.fetch("https://example.com/api/upload", {
    method: "POST",
    body,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

async function uploadOk(body: string, token = tokens.trusted, headers: Record<string, string> = {}): Promise<UploadResponse> {
  const res = await upload(body, token, headers);
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * A 4-player match: Alpha wins round 1, Bravo round 2. `rounds` cuts it short, like an early copy.
 * With `host`, Alpha's `JOIN` marks them as the lobby host.
 */
function matchLog({ key = "000000000001", rounds = 2, end = true, extra = [] as string[], host = false } = {}): string {
  const lines = [
    `GBR|1.00|1|1.3.3R|${key}`,
    "MATCH_START|1.00|workshop-island-night|Default|0|",
    host ? "JOIN|1.00|1|Alpha|1" : "JOIN|1.00|1|Alpha",
    "JOIN|1.00|2|Bravo",
    "JOIN|1.00|3|Charlie",
    "JOIN|1.00|4|Delta",
    ...extra,
    "ROUND_START|2.00|1|1,2,3,4",
    "DEFLECT|2.50|1|1|21|2",
    "KILL|3.00|Alpha|Bravo|1|2",
    "ELIM|3.00|1|2|1|4",
    "ELIM|4.00|1|3|1|3",
    "ELIM|5.00|1|4|1|2",
    "ROUND_END|5.00|1|1|WIN",
  ];
  if (rounds >= 2) {
    lines.push(
      "ROUND_START|6.00|2|1,2,3,4",
      "ELIM|7.00|2|1|2|4",
      "ELIM|8.00|2|3|2|3",
      "ELIM|9.00|2|4|2|2",
      "ROUND_END|9.00|2|2|WIN",
    );
  }
  if (end) lines.push("MATCH_END|10.00|TIME");
  return lines.map((line) => `[00:00:01] ${line}`).join("\r\n");
}

async function count(table: string): Promise<number> {
  return (await db().prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

async function storedMatch(key = "000000000001") {
  return db().prepare("SELECT * FROM matches WHERE match_key = ?").bind(key).first<Record<string, unknown>>();
}

/** D1 returns a BLOB as an array of bytes. */
async function gunzip(data: number[]): Promise<string> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

describe("upload: auth", () => {
  it("needs a known host token", async () => {
    expect((await upload(matchLog(), null)).status).toBe(401);
    expect((await upload(matchLog(), "nope")).status).toBe(401);
    expect(await (await upload(matchLog(), "nope")).json()).toMatchObject({ error: "unauthorized" });
  });

  it("rejects a revoked token without storing anything", async () => {
    const res = await upload(matchLog(), tokens.revoked);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "revoked" });
    expect(await count("uploads")).toBe(0);
  });

  it("only takes POST", async () => {
    const res = await SELF.fetch("https://example.com/api/upload");
    expect(res.status).toBe(405);
  });
});

describe("host: check a token", () => {
  function me(token: string | null, method = "GET") {
    return SELF.fetch("https://example.com/api/host/me", { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  }

  it("answers the token's host", async () => {
    const res = await me(tokens.untrusted);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: { id: 2, name: "untrusted", trust: "untrusted", region: "eu" } });
  });

  it("answers like an upload for a missing, unknown or revoked token", async () => {
    expect((await me(null)).status).toBe(401);
    const unknown = await me("nope");
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: "unauthorized" });
    const revoked = await me(tokens.revoked);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ error: "revoked" });
  });

  it("only takes GET", async () => {
    const res = await me(tokens.trusted, "POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});

describe("host: match status", () => {
  function matches(token: string | null, keys: string, method = "GET") {
    return SELF.fetch(`https://example.com/api/host/matches?keys=${keys}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  it("answers the status now of the host's own matches", async () => {
    await uploadOk(matchLog(), tokens.untrusted);
    await uploadOk(matchLog({ key: "000000000002" }), tokens.trusted);
    const before = await matches(tokens.untrusted, "000000000001,000000000002,999");
    expect(before.status).toBe(200);
    const stored = await db().prepare("SELECT id FROM matches WHERE match_key = '000000000001'").first<{ id: number }>();
    expect(await before.json()).toEqual({
      matches: [{ matchKey: "000000000001", matchId: stored?.id, status: "review", rejection: null, reviewReasons: ["untrusted_host"] }],
    });

    // An admin accepts it on the site.
    await db().prepare("UPDATE matches SET status = 'accepted' WHERE match_key = '000000000001'").run();
    expect(await (await matches(tokens.untrusted, "000000000001")).json()).toMatchObject({
      matches: [{ matchKey: "000000000001", status: "accepted" }],
    });
  });

  it("answers no matches for no keys", async () => {
    expect(await (await matches(tokens.trusted, "")).json()).toEqual({ matches: [] });
  });

  it("takes at most hostMatchKeysMax keys", async () => {
    const keys = Array.from({ length: defaults.hostMatchKeysMax + 1 }, (_, i) => String(i)).join(",");
    const res = await matches(tokens.trusted, keys);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
  });

  it("answers like an upload for a bad token, and only takes GET", async () => {
    expect((await matches(null, "1")).status).toBe(401);
    expect((await matches(tokens.revoked, "1")).status).toBe(403);
    expect((await matches(tokens.trusted, "1", "POST")).status).toBe(405);
  });
});

describe("upload: a new match", () => {
  it("stores the file, the match, its players, rounds and events", async () => {
    const body = await uploadOk(matchLog(), tokens.trusted, { "X-Log-File": "Log-26-10-03-20-00-00.txt" });
    expect(body).toMatchObject({ result: "stored", matches: [{ matchKey: "000000000001", action: "insert", status: "accepted", rejection: null }] });

    const upload = await db().prepare("SELECT * FROM uploads").first<{ id: number; raw_log: number[]; raw_size: number; file_name: string }>();
    expect(upload!.id).toBe(body.uploadId);
    expect(upload!.file_name).toBe("Log-26-10-03-20-00-00.txt");
    expect(await gunzip(upload!.raw_log)).toBe(matchLog());
    expect(upload!.raw_size).toBe(new TextEncoder().encode(matchLog()).length);

    expect(await storedMatch()).toMatchObject({ host_id: 1, upload_id: upload!.id, status: "accepted", complete: 1, format: 1, map: "workshop-island-night", preset: "Default" });
    expect(await count("players")).toBe(4);
    expect(await count("aliases")).toBe(4);
    expect(await count("match_players")).toBe(4);
    expect(await count("events")).toBe(2);

    const rounds = await db().prepare("SELECT number, result, winner_id, rated FROM rounds ORDER BY number").all();
    expect(rounds.results).toEqual([
      { number: 1, result: "WIN", winner_id: 1, rated: 1 },
      { number: 2, result: "WIN", winner_id: 2, rated: 1 },
    ]);
    const round1 = await db()
      .prepare(
        `SELECT p.name, rp.position, rp.place FROM round_players rp JOIN rounds r ON r.id = rp.round_id
         JOIN players p ON p.id = rp.player_id WHERE r.number = 1 ORDER BY rp.position`,
      )
      .all();
    expect(round1.results).toEqual([
      { name: "Alpha", position: 1, place: null },
      { name: "Delta", position: 2, place: 2 },
      { name: "Charlie", position: 3, place: 3 },
      { name: "Bravo", position: 4, place: 4 },
    ]);
    const host = await db().prepare("SELECT last_upload_at FROM hosts WHERE id = 1").first<{ last_upload_at: string }>();
    expect(host!.last_upload_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("stores the spec example: leavers out of the order, a duplicate name sent to review", async () => {
    const body = await uploadOk(example);
    expect(body.matches).toMatchObject([{ matchKey: "482913507226", status: "review", reviewReasons: ["duplicate_name"] }]);
    const orders = await db()
      .prepare(
        `SELECT r.number, group_concat(rp.log_id) AS ids FROM (SELECT * FROM round_players ORDER BY position) rp
         JOIN rounds r ON r.id = rp.round_id WHERE rp.position IS NOT NULL GROUP BY r.number ORDER BY r.number`,
      )
      .all();
    expect(orders.results).toEqual([
      { number: 1, ids: "1,5,3,4" },
      { number: 2, ids: "6,5,1,4,3" },
      { number: 3, ids: "1,4,5,3,6" },
    ]);
    const tidal = await db().prepare("SELECT position, left_round FROM round_players WHERE log_id = 2").first();
    expect(tidal).toEqual({ position: null, left_round: 1 });
    // Both Ghosts are one name, so one player: the review is for an admin to sort out.
    expect(await count("players")).toBe(5);
  });

  it("sends an untrusted host's match to review", async () => {
    const body = await uploadOk(matchLog(), tokens.untrusted);
    expect(body.matches[0]).toMatchObject({ status: "review", reviewReasons: ["untrusted_host"] });
  });

  it("stores an unranked match as rejected, with the reasons", async () => {
    const body = await uploadOk(matchLog({ extra: ["UNRANKED|1.50|BOT", "UNRANKED|1.60|MAP"] }));
    expect(body.matches[0]).toMatchObject({ status: "rejected", rejection: { code: "unranked" } });
    expect(await storedMatch()).toMatchObject({ status: "rejected", rejection_code: "unranked", unranked: "BOT,MAP" });
  });

  it("accepts a 1v1", async () => {
    const oneVsOne = [
      "GBR|1.00|1|1.3.3R|000000000001",
      "MATCH_START|1.00|workshop-island-night|Default|0|",
      "JOIN|1.00|1|Alpha",
      "JOIN|1.00|2|Bravo",
      "ROUND_START|2.00|1|1,2",
      "ELIM|3.00|1|2|1|2",
      "ROUND_END|3.00|1|1|WIN",
      "MATCH_END|10.00|TIME",
    ].join("\n");
    const body = await uploadOk(oneVsOne);
    expect(body.matches[0]).toMatchObject({ status: "accepted", rejection: null });
  });

  it("rejects a match with no rated round", async () => {
    // Restarted straight away: the next match is in a new file.
    const restarted = ["GBR|1.00|1|1.3.3R|000000000001", "MATCH_START|1.00|workshop-island-night|Default|0|", "JOIN|1.00|1|Alpha"].join("\n");
    const body = await uploadOk(restarted);
    expect(body.matches[0]).toMatchObject({
      status: "rejected",
      rejection: { code: "too_few_players", message: "No rated rounds" },
    });
  });

  it("stores a match in an unknown format as rejected, to re-parse later", async () => {
    const body = await uploadOk(matchLog().replace("GBR|1.00|1|", "GBR|1.00|99|"));
    expect(body.matches[0]).toMatchObject({ action: "insert", status: "rejected", rejection: { code: "unknown_format" } });
    expect(await storedMatch()).toMatchObject({ format: 99, status: "rejected" });
    expect(await count("uploads")).toBe(1);
  });

  it("maps a known name to the same player, ignoring case, and shows the newest spelling", async () => {
    await uploadOk(matchLog());
    await uploadOk(matchLog({ key: "000000000002" }).replaceAll("Alpha", "ALPHA"), tokens.trusted, {
      "X-Log-Started-At": "2099-01-01T00:00:00Z",
    });
    expect(await count("players")).toBe(4);
    expect(await count("aliases")).toBe(4);
    const player = await db().prepare("SELECT p.name FROM players p JOIN aliases a ON a.player_id = p.id WHERE a.name_key = 'alpha'").first();
    expect(player).toEqual({ name: "ALPHA" });
  });

  it("uses X-Log-Started-At as the play time, unless it's in the future", async () => {
    await uploadOk(matchLog(), tokens.trusted, { "X-Log-Started-At": "2026-10-02T20:15:33+02:00" });
    expect(await storedMatch()).toMatchObject({ played_at: "2026-10-02T18:15:33Z" });
    await uploadOk(matchLog({ key: "000000000002" }), tokens.trusted, { "X-Log-Started-At": "2999-01-01T00:00:00Z" });
    const future = await storedMatch("000000000002");
    expect(String(future!.played_at) < "2999").toBe(true);
  });
});

describe("upload: copies of a match", () => {
  it("stores the same file once", async () => {
    const first = await uploadOk(matchLog());
    const again = await uploadOk(matchLog());
    expect(again).toEqual({ result: "duplicate", uploadId: first.uploadId, region: "eu", matches: [] });
    expect(await count("uploads")).toBe(1);
  });

  it("replaces a shorter copy with a longer one, under the same match id, and drops the shorter file", async () => {
    const short = await uploadOk(matchLog({ rounds: 1, end: false }));
    expect(short.matches[0]).toMatchObject({ action: "insert" });
    const before = await storedMatch();
    expect(before).toMatchObject({ complete: 0 });

    const long = await uploadOk(matchLog());
    expect(long.matches[0]).toMatchObject({ action: "replace", status: "accepted" });
    const after = await storedMatch();
    expect(after).toMatchObject({ id: before!.id, upload_id: long.uploadId, complete: 1 });
    expect(Number(after!.line_count)).toBeGreaterThan(Number(before!.line_count));
    expect(await count("rounds")).toBe(2);
    expect(await count("match_players")).toBe(4);
    expect(await count("round_players")).toBe(8);
    expect(await count("uploads")).toBe(1);
  });

  it("writes nothing for a copy that isn't longer", async () => {
    await uploadOk(matchLog());
    const short = await uploadOk(matchLog({ rounds: 1, end: false }));
    expect(short).toMatchObject({ result: "unchanged", uploadId: null, matches: [{ action: "skip", status: "accepted" }] });
    expect(await count("uploads")).toBe(1);
  });

  it("moves an unchanged match to a newer file that has it too, so the old file can go", async () => {
    await uploadOk(matchLog());
    const both = await uploadOk(`${matchLog()}\r\n${matchLog({ key: "000000000002" })}`);
    expect(both.matches.map((m) => m.action)).toEqual(["repoint", "insert"]);
    expect(await storedMatch()).toMatchObject({ upload_id: both.uploadId });
    expect(await count("uploads")).toBe(1);
  });

  it("keeps an older file that still holds another match", async () => {
    await uploadOk(`${matchLog({ rounds: 1, end: false })}\r\n${matchLog({ key: "000000000002" })}`);
    await uploadOk(matchLog());
    expect(await count("uploads")).toBe(2);
  });

  it("keeps a voided match voided when a longer copy arrives", async () => {
    await uploadOk(matchLog({ rounds: 1, end: false }));
    await db().prepare("UPDATE matches SET status = 'void'").run();
    const long = await uploadOk(matchLog());
    expect(long.matches[0]).toMatchObject({ action: "replace", status: "void" });
    expect(await storedMatch()).toMatchObject({ status: "void" });
  });
});

describe("upload: host AFK (X-Host-Afk)", () => {
  const key = "000000000001";
  const afk = (rounds: string) => ({ "X-Host-Afk": `${key}:${rounds}` });
  /** Each round's rated order by name, the AFK host (`afk`) and the stored AFK rounds. */
  async function stored() {
    const { results } = await db()
      .prepare(
        `SELECT r.number, r.rated, mp.name, rp.position, rp.afk FROM rounds r
         JOIN round_players rp ON rp.round_id = r.id JOIN match_players mp ON mp.match_id = r.match_id AND mp.log_id = rp.log_id
         ORDER BY r.number, rp.position IS NULL, rp.position, mp.log_id`,
      )
      .all<{ number: number; rated: number; name: string; position: number | null; afk: number }>();
    const rounds = new Map<number, { order: string[]; afk: string[] }>();
    for (const row of results) {
      const round = rounds.get(row.number) ?? { order: [], afk: [] };
      rounds.set(row.number, round);
      if (row.position !== null) round.order.push(row.name);
      if (row.afk) round.afk.push(row.name);
    }
    const match = await storedMatch(key);
    return { rounds: [...rounds.values()], hostAfk: match?.host_afk ?? null };
  }
  const full = { order: ["Alpha", "Delta", "Charlie", "Bravo"], afk: [] };
  const round2 = { order: ["Bravo", "Delta", "Charlie", "Alpha"], afk: [] };

  it("drops the host from the AFK rounds only, and stores the rounds", async () => {
    const body = await uploadOk(matchLog({ host: true }), tokens.trusted, afk("1"));
    expect(body.matches[0]).toMatchObject({ action: "insert", status: "accepted", hostAfk: [1] });
    expect(await stored()).toEqual({ rounds: [{ order: ["Delta", "Charlie", "Bravo"], afk: ["Alpha"] }, round2], hostAfk: "[1]" });
    // Stats don't change: Alpha still won round 1.
    const winner = await db().prepare("SELECT winner_id FROM rounds WHERE number = 1").first("winner_id");
    expect(winner).toBe(1);
    // The match page marks the host AFK in that round.
    const id = (await storedMatch(key))!.id;
    const page = await (await SELF.fetch(`https://example.com/api/matches/${id}`)).json<{
      match: { rounds: { placements: { name: string; position: number | null; afk: boolean }[] }[] };
    }>();
    expect(page.match.rounds.map((r) => r.placements.filter((p) => p.afk).map((p) => p.name))).toEqual([["Alpha"], []]);
  });

  it("ignores a log without the host field, and a header without the match", async () => {
    await uploadOk(matchLog(), tokens.trusted, afk("1,2"));
    expect(await stored()).toEqual({ rounds: [full, round2], hostAfk: "[1,2]" });
    await uploadOk(matchLog({ key: "000000000002", host: true }), tokens.trusted, afk("1"));
    const other = await storedMatch("000000000002");
    expect(other!.host_afk).toBeNull();
  });

  it("refuses a malformed header with 400, storing nothing", async () => {
    const tooMany = Array.from({ length: defaults.hostAfkMaxRounds + 1 }, (_, i) => i + 1).join(",");
    for (const header of ["1,2", `${key}:x`, `${key}:0`, `${key}:${tooMany}`]) {
      const res = await upload(matchLog({ host: true }), tokens.trusted, { "X-Host-Afk": header });
      expect(res.status, header).toBe(400);
      const body = await res.json<{ error: string; message: string }>();
      expect(body.error).toBe("bad_request");
      expect(body.message).toMatch(/^X-Host-Afk: /);
    }
    expect(await count("uploads")).toBe(0);
  });

  it("keeps the union of the rounds across copies of the match", async () => {
    await uploadOk(matchLog({ host: true, rounds: 1, end: false }), tokens.trusted, afk("1"));
    const long = await uploadOk(matchLog({ host: true }), tokens.trusted, afk("2"));
    expect(long.matches[0]).toMatchObject({ action: "replace", hostAfk: [1, 2] });
    expect(await stored()).toEqual({
      rounds: [
        { order: ["Delta", "Charlie", "Bravo"], afk: ["Alpha"] },
        { order: ["Bravo", "Delta", "Charlie"], afk: ["Alpha"] },
      ],
      hostAfk: "[1,2]",
    });
    // A longer copy without the header keeps them too.
    await uploadOk(matchLog({ host: true, extra: ["DEFLECT|1.50|0|1|21|2"] }));
    expect((await stored()).hostAfk).toBe("[1,2]");
  });

  it("re-rates the stored match when the same file comes again with new rounds", async () => {
    const first = await uploadOk(matchLog({ host: true }), tokens.trusted, afk("1"));
    const again = await uploadOk(matchLog({ host: true }), tokens.trusted, afk("1,2"));
    expect(again).toMatchObject({ result: "duplicate", uploadId: first.uploadId, matches: [{ action: "refresh", hostAfk: [1, 2] }] });
    expect((await stored()).rounds[1]).toEqual({ order: ["Bravo", "Delta", "Charlie"], afk: ["Alpha"] });
    expect(await storedMatch(key)).toMatchObject({ upload_id: first.uploadId, host_afk: "[1,2]" });
    expect(await count("uploads")).toBe(1);
    // Nothing new: a plain duplicate.
    const same = await uploadOk(matchLog({ host: true }), tokens.trusted, afk("2"));
    expect(same).toEqual({ result: "duplicate", uploadId: first.uploadId, region: "eu", matches: [] });
  });

  it("re-rates a longer stored copy from its own log when a shorter one brings new rounds", async () => {
    const long = await uploadOk(matchLog({ host: true }));
    const short = await uploadOk(matchLog({ host: true, rounds: 1, end: false }), tokens.trusted, afk("1"));
    expect(short).toMatchObject({ result: "unchanged", uploadId: null, matches: [{ action: "refresh", hostAfk: [1] }] });
    expect(await stored()).toEqual({ rounds: [{ order: ["Delta", "Charlie", "Bravo"], afk: ["Alpha"] }, round2], hostAfk: "[1]" });
    expect(await storedMatch(key)).toMatchObject({ upload_id: long.uploadId, complete: 1 });
    expect(await count("uploads")).toBe(1);
  });

  it("writes nothing for rounds that don't drop the host from the stored copy", async () => {
    await uploadOk(matchLog({ host: true }), tokens.trusted, afk("1"));
    const short = await uploadOk(matchLog({ host: true, rounds: 1, end: false }), tokens.trusted, afk("1,7"));
    expect(short).toMatchObject({ result: "unchanged", matches: [{ action: "skip", hostAfk: [1] }] });
    expect((await stored()).hostAfk).toBe("[1]");
  });
});

describe("upload: bad files and limits", () => {
  it("refuses an empty body, a file with no ranked match and a legacy log", async () => {
    expect((await upload("")).status).toBe(400);
    const notRanked = await upload("[00:00:01] something else\n");
    expect(notRanked.status).toBe(422);
    expect(await notRanked.json()).toMatchObject({ error: "not_ranked" });
    const legacy = await upload("[00:00:05] KILL|5.00|Alpha|Bravo\n");
    expect(await legacy.json()).toMatchObject({ error: "legacy_log" });
    expect(await count("uploads")).toBe(0);
  });

  it("refuses a file over maxUploadBytes", async () => {
    const res = await upload(matchLog() + "\n".repeat(defaults.maxUploadBytes));
    expect(res.status).toBe(413);
  });

  it("stops reading a chunked body without Content-Length once it passes maxUploadBytes", async () => {
    const chunk = new TextEncoder().encode(matchLog());
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        controller.enqueue(chunk);
        if (sent === 100) controller.close();
      },
    });
    const request = new Request("https://example.com/api/upload", {
      method: "POST",
      body,
      headers: { Authorization: `Bearer ${tokens.trusted}` },
    });
    expect(request.headers.get("Content-Length")).toBeNull();
    const res = await handleUpload(request, db(), { ...defaults, maxUploadBytes: chunk.length * 2 }, createLogger("error"));
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(100);
  });

  it("rate-limits a host past maxUploadsPerHour", async () => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await db()
      .prepare(
        `INSERT INTO uploads (host_id, content_hash, raw_log, raw_size, received_at, status)
         SELECT 1, 'hash-' || value, x'00', 1, ?, 'parsed' FROM json_each(?)`,
      )
      .bind(now, JSON.stringify(Array.from({ length: defaults.maxUploadsPerHour }, (_, i) => i)))
      .run();
    const res = await upload(matchLog());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect((await upload(matchLog(), tokens.untrusted)).status).toBe(200);
  });

  it("rejects an untrusted host's match when untrustedHostUploads is reject", async () => {
    const request = new Request("https://example.com/api/upload", {
      method: "POST",
      body: matchLog(),
      headers: { Authorization: `Bearer ${tokens.untrusted}` },
    });
    const res = await handleUpload(request, db(), { ...defaults, untrustedHostUploads: "reject" }, createLogger("error"));
    const body: UploadResponse = await res.json();
    expect(body.matches[0]).toMatchObject({ status: "rejected", rejection: { code: "untrusted_host" } });
  });

  it("answers 409 when another upload of the match was stored at the same time", async () => {
    // A database where someone else's identical write lands just before ours.
    const racing = new Proxy(db(), {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const request = new Request("https://example.com/api/upload", {
      method: "POST",
      body: matchLog(),
      headers: { Authorization: `Bearer ${tokens.trusted}` },
    });
    const res = await handleUpload(request, racing, defaults, createLogger("error"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict" });
  });

  it("splits big inserts into chunks", async () => {
    const extra = Array.from({ length: 30 }, (_, i) => `DEFLECT|1.${String(i).padStart(2, "0")}|0|1|21|2`);
    const request = new Request("https://example.com/api/upload", {
      method: "POST",
      body: matchLog({ extra }),
      headers: { Authorization: `Bearer ${tokens.trusted}` },
    });
    const res = await handleUpload(request, db(), { ...defaults, insertChunkBytes: 300 }, createLogger("error"));
    expect(res.status).toBe(200);
    expect(await count("events")).toBe(32);
    expect(await count("round_players")).toBe(8);
  });
});
