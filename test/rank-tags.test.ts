import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { rankTags, type RankTags } from "../src/site/rankTags";
import type { RatingRow } from "../src/site/store";

const db = () => env.DB;
const now = new Date("2026-10-03T12:00:00Z");
const recent = "2026-10-02T00:00:00Z";

function player(name: string, display: number, extra: Partial<RatingRow> = {}): RatingRow {
  return { playerId: 1, name, display, rounds: defaults.minRankedRounds, wins: 0, lastPlayedAt: recent, ...extra };
}

describe("rankTags", () => {
  it("lists every tier, lowest first, with its colour, guide line and names", () => {
    const tags = rankTags([player("Zeus", 2700), player("Kenzo", 1650), player("Momo", 1610), player("Low", 900)], defaults, now);
    expect(tags.header).toBe("Ranks updated 2026-10-03");
    expect(tags.updatedAt).toBe("2026-10-03T12:00:00Z");
    expect(tags.tiers.map((t) => [t.label, t.guide, t.names])).toEqual([
      ["Master", "Master - 1300", []],
      ["Grandmaster", "Grandmaster - 1600", ["Kenzo", "Momo"]],
      ["Ascendant", "Ascendant - 1900", []],
      ["Champion", "Champion - 2300", []],
      ["God", "God - 2600", ["Zeus"]],
    ]);
    expect(tags.tiers[0]!.color).toEqual([255, 215, 0, 255]);
  });

  it("leaves out inactive players, players with too few rounds, and names the Workshop can't hold", () => {
    const tags = rankTags(
      [
        player("Gone", 2000, { lastPlayedAt: "2026-08-01T00:00:00Z" }),
        player("New", 2000, { rounds: defaults.minRankedRounds - 1 }),
        player("{0}", 2000),
        player("x".repeat(129), 2000),
        player('Quote"Back\\slash', 2000),
      ],
      defaults,
      now,
    );
    // Quotes and backslashes are the host tool's to escape.
    expect(tags.tiers.flatMap((t) => t.names)).toEqual(['Quote"Back\\slash']);
  });

  it("keeps the best rankTagsMaxNames names", () => {
    const tags = rankTags([player("A", 2000), player("B", 1950), player("C", 1300)], { ...defaults, rankTagsMaxNames: 2 }, now);
    expect(tags.tiers.flatMap((t) => t.names)).toEqual(["A", "B"]);
  });
});

describe("GET /api/rank-tags", () => {
  beforeEach(async () => {
    const tables = ["rating_history", "ratings", "aliases", "players"];
    await db().batch(tables.map((t) => db().prepare(`DELETE FROM ${t}`)));
  });

  it("reads the active players in a tier from the ratings, and can be cached", async () => {
    const day = 24 * 60 * 60 * 1000;
    const active = new Date(Date.now() - day).toISOString();
    const inactive = new Date(Date.now() - (defaults.inactiveAfterDays + 1) * day).toISOString();
    const rows: [string, number, number, string][] = [
      ["Kenzo", 1700, defaults.minRankedRounds, active],
      ["Gone", 2000, defaults.minRankedRounds, inactive],
      ["New", 2000, defaults.minRankedRounds - 1, active],
      ["Low", 1000, defaults.minRankedRounds, active],
    ];
    await db().batch(
      rows.flatMap(([name, display, rounds, last], i) => [
        db().prepare("INSERT INTO players (id, name) VALUES (?, ?)").bind(i + 1, name),
        db()
          .prepare("INSERT INTO ratings (board, player_id, mu, sigma, display, rounds, last_played_at) VALUES ('ranked', ?, 25, 1, ?, ?, ?)")
          .bind(i + 1, display, rounds, last),
      ]),
    );

    const res = await SELF.fetch("https://example.com/api/rank-tags");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${defaults.rankTagsCacheSeconds}`);
    const tags = (await res.json()) as RankTags;
    expect(tags.tiers.map((t) => t.names)).toEqual([[], ["Kenzo"], [], [], []]);
  });
});
