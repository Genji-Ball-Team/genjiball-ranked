import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = () => env.DB;

async function seedMatch(matchKey = "000000000001", lineCount = 10): Promise<number> {
  await db().batch([
    db().prepare("INSERT OR IGNORE INTO hosts (id, name, token_hash, trust) VALUES (1, 'host', 'abc', 'trusted')"),
    db().prepare("INSERT OR IGNORE INTO players (id, name) VALUES (1, 'Sparrow'), (2, 'Tidal')"),
  ]);
  const upload = await db()
    .prepare("INSERT INTO uploads (host_id, content_hash, raw_log, raw_size, status) VALUES (1, ?, ?, 3, 'parsed') RETURNING id")
    .bind(`hash-${matchKey}-${lineCount}`, new Uint8Array([1, 2, 3]))
    .first<{ id: number }>();
  const match = await db()
    .prepare(
      `INSERT INTO matches (upload_id, host_id, match_key, line_count, format, game_version, status, played_at, complete)
       VALUES (?, 1, ?, ?, 1, '1.3.3R', 'accepted', '2026-10-02T20:00:00Z', 1) RETURNING id`,
    )
    .bind(upload!.id, matchKey, lineCount)
    .first<{ id: number }>();
  return match!.id;
}

describe("schema", () => {
  beforeEach(async () => {
    // Storage is isolated per test file, not per test.
    await db().batch(
      ["events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads"].map((t) =>
        db().prepare(`DELETE FROM ${t}`),
      ),
    );
  });

  it("bulk-inserts a match's events from one JSON parameter", async () => {
    const matchId = await seedMatch();
    const events = Array.from({ length: 500 }, (_, seq) => ({
      seq,
      type: seq % 2 ? "KILL" : "DEFLECT",
      round: 1,
      time: seq / 10,
      actor: 1,
      target: 2,
      speed: seq % 2 ? null : 21,
    }));
    await db()
      .prepare(
        `INSERT INTO events (match_id, seq, type, round, time, actor_id, target_id, speed)
         SELECT ?1, e.value ->> 'seq', e.value ->> 'type', e.value ->> 'round', e.value ->> 'time',
                e.value ->> 'actor', e.value ->> 'target', e.value ->> 'speed'
         FROM json_each(?2) AS e`,
      )
      .bind(matchId, JSON.stringify(events))
      .run();
    const counts = await db()
      .prepare("SELECT type, count(*) AS n FROM events WHERE match_id = ? GROUP BY type ORDER BY type")
      .bind(matchId)
      .all();
    expect(counts.results).toEqual([
      { type: "DEFLECT", n: 250 },
      { type: "KILL", n: 250 },
    ]);
  });

  it("keeps one match per host and matchKey", async () => {
    await seedMatch("000000000001", 10);
    await expect(seedMatch("000000000001", 20)).rejects.toThrow(/UNIQUE/);
  });

  it("allows many legacy matches without a matchKey", async () => {
    const insertLegacy = (n: number) =>
      db()
        .prepare(
          `INSERT INTO matches (upload_id, host_id, match_key, line_count, format, game_version, legacy, status, played_at, complete)
           VALUES ((SELECT min(id) FROM uploads), 1, NULL, ?, 0, '1.3.2', 1, 'accepted', '2025-01-01T00:00:00Z', 1)`,
        )
        .bind(n)
        .run();
    await seedMatch();
    await insertLegacy(1);
    await insertLegacy(2);
    const row = await db().prepare("SELECT count(*) AS n FROM matches WHERE legacy = 1").first<{ n: number }>();
    expect(row!.n).toBe(2);
  });

  it("deletes a match's rounds, players and events with it, to replace it by a longer copy", async () => {
    const matchId = await seedMatch();
    const round = await db()
      .prepare(
        "INSERT INTO rounds (match_id, number, result, winner_id, start_time, end_time, rated) VALUES (?, 1, 'WIN', 1, 1, 2, 1) RETURNING id",
      )
      .bind(matchId)
      .first<{ id: number }>();
    await db().batch([
      db().prepare("INSERT INTO match_players (match_id, log_id, player_id, name, join_time) VALUES (?, 1, 1, 'Sparrow', 1)").bind(matchId),
      db().prepare("INSERT INTO round_players (round_id, log_id, player_id, position) VALUES (?, 1, 1, 1)").bind(round!.id),
      db().prepare("INSERT INTO events (match_id, seq, type, time) VALUES (?, 0, 'KILL', 1)").bind(matchId),
    ]);

    await db().batch([
      db().prepare("DELETE FROM rounds WHERE match_id = ?").bind(matchId),
      db().prepare("DELETE FROM match_players WHERE match_id = ?").bind(matchId),
      db().prepare("DELETE FROM events WHERE match_id = ?").bind(matchId),
    ]);
    const left = await db()
      .prepare("SELECT (SELECT count(*) FROM round_players) AS rp, (SELECT count(*) FROM rounds) AS r")
      .first();
    expect(left).toEqual({ rp: 0, r: 0 });
  });

  it("rejects an unknown host trust state or round result", async () => {
    await expect(
      db().prepare("INSERT INTO hosts (name, token_hash, trust) VALUES ('x', 'y', 'maybe')").run(),
    ).rejects.toThrow(/CHECK/);
    const matchId = await seedMatch();
    await expect(
      db()
        .prepare("INSERT INTO rounds (match_id, number, result, start_time, end_time, rated) VALUES (?, 1, 'DRAW', 1, 2, 0)")
        .bind(matchId)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("serves the leaderboard, player and head-to-head queries from indexes", async () => {
    const plan = async (sql: string) =>
      (await db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");

    expect(await plan("SELECT * FROM ratings WHERE board = 'ranked' ORDER BY display DESC LIMIT 50")).toMatch(
      /ratings_board_display/,
    );
    expect(await plan("SELECT match_id FROM match_players WHERE player_id = 1 ORDER BY match_id DESC")).toMatch(
      /match_players_player/,
    );
    expect(
      await plan(
        `SELECT a.round_id, a.position, b.position FROM round_players a
         JOIN round_players b ON b.round_id = a.round_id AND b.player_id = 2
         WHERE a.player_id = 1`,
      ),
    ).toMatch(/round_players_player/);
    expect(await plan("SELECT id FROM matches WHERE status = 'accepted' ORDER BY played_at")).toMatch(
      /matches_status_played/,
    );
    expect(await plan("SELECT id FROM aliases WHERE name_key = 'ghost'")).toMatch(/sqlite_autoindex_aliases/);
  });
});
