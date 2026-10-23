import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readRatingsBefore } from "../src/rating/store";
import { listFormRounds, listRatedRegions } from "../src/site/store";

/**
 * The free plan reads 5 million rows a day (docs/database.md), so a query that should seek a few rows
 * must not walk a table. Each test fills a table with filler for other players and checks how many
 * rows the query read (`meta.rows_read`), as the pair totals test does.
 */
const db = () => env.DB;

/** `env.DB` that adds up the rows each `.all()` read. */
function counting() {
  const counter = { rows: 0 };
  const wrapped = {
    prepare: (sql: string) => {
      const statement = db().prepare(sql);
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            all: async () => {
              const result = await bound.all();
              counter.rows += result.meta.rows_read;
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db: wrapped, counter };
}

beforeEach(async () => {
  await db().batch(["rating_history", "ratings", "round_players", "rounds", "match_players", "matches", "uploads", "players"].map((t) => db().prepare(`DELETE FROM ${t}`)));
  await db().batch([
    // Players 1 to 3000, each rated on both boards and with a history row in a match they all share.
    db().prepare(`INSERT INTO players (id, name) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) SELECT i, 'P' || i FROM n`),
    db().prepare(
      `INSERT INTO ratings (board, player_id, mu, sigma, display, rounds, wins)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) SELECT 'eu', i, 25, 8, 1000, 5, 1 FROM n`,
    ),
    db().prepare(
      `INSERT INTO ratings (board, player_id, mu, sigma, display, rounds, wins)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) SELECT 'na', i, 25, 8, 1000, 5, 1 FROM n`,
    ),
  ]);
});

describe("reads stay small", () => {
  it("finds a player's regions by seeks, not by a scan of ratings", async () => {
    await db().prepare("DELETE FROM ratings WHERE board = 'na' AND player_id = 7").run();
    const { db: counted, counter } = counting();
    expect(await listRatedRegions(counted, 7, ["eu", "na"])).toEqual(["eu"]);
    expect(counter.rows).toBeLessThan(50);
  });

  it("reads the rating before a match from the asked players' own history", async () => {
    // 3,000 players with a history row each in 40 matches: a walk of the board's history reads 120,000.
    await db().batch([
      db().prepare("INSERT OR IGNORE INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'host', 'abc', 'trusted', 'eu')"),
      db().prepare("INSERT OR IGNORE INTO uploads (id, host_id, content_hash, raw_log, raw_size, status) VALUES (1, 1, 'h', x'010203', 3, 'parsed')"),
      db().prepare(
        `INSERT INTO matches (id, upload_id, host_id, match_key, line_count, format, game_version, status, region, played_at, complete)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
         SELECT i, 1, 1, 'k' || i, 1, 1, '1.3.3R', 'accepted', 'eu', '2026-01-' || printf('%02d', i) || 'T00:00:00.000Z', 1 FROM n`,
      ),
      db().prepare(
        `INSERT INTO rating_history (board, player_id, match_id, played_at, mu, sigma, display, rounds, wins)
         WITH RECURSIVE p(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM p WHERE i < 3000), m(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM m WHERE j < 40)
         SELECT 'eu', i, j, '2026-01-' || printf('%02d', j) || 'T00:00:00.000Z', 25, 8, 1000 + j, j, 0 FROM p, m`,
      ),
    ]);
    const { db: counted, counter } = counting();
    const before = await readRatingsBefore(counted, "eu", [1, 2, 3], { id: 21, playedAt: "2026-01-21T00:00:00.000Z" });
    expect(before.size).toBe(3);
    expect(before.get(1)?.rounds).toBe(20);
    expect(counter.rows).toBeLessThan(200);
  });

  it("is empty for a player with no history in the region", async () => {
    expect(await listFormRounds(db(), "eu", 1, 20)).toEqual([]);
  });
});
