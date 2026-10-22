import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { handleSite } from "../src/site/handler";
import { parseTitles, pickTitles } from "../src/site/titles";

const db = () => env.DB;
const now = new Date();
const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

/** Players 1–6, rated in EU best first (1 at 2900 down to 6 at 1400); player 7 was merged into 2; player 3 also plays NA. */
beforeEach(async () => {
  const tables = ["ratings", "aliases", "players"];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    ...[1, 2, 3, 4, 5, 6].map((id) => db().prepare("INSERT INTO players (id, name) VALUES (?, ?)").bind(id, `P${id}`)),
    db().prepare("INSERT INTO players (id, name, merged_into) VALUES (7, 'Old', 2)"),
    ...[1, 2, 3, 4, 5, 6].map((id) =>
      db()
        .prepare("INSERT INTO ratings (board, player_id, mu, sigma, display, rounds, wins, last_played_at) VALUES ('eu', ?, 25, 1, ?, 50, 10, ?)")
        .bind(id, 3200 - id * 300, recent),
    ),
    db().prepare("INSERT INTO ratings (board, player_id, mu, sigma, display, rounds, wins, last_played_at) VALUES ('na', 3, 25, 1, 1950, 40, 9, ?)").bind(recent),
  ]);
});

/** A stand-in for the bot's Worker answering `GET /titles`. */
const bot = (titles: unknown, status = 200) => ({ fetch: async () => Response.json({ titles }, { status }) }) as unknown as Fetcher;

interface Titled {
  title: string;
  id: number;
  rank: number;
  rating: number;
  tier: { label: string } | null;
}

async function read(path: string, fetcher?: Fetcher) {
  const res = await handleSite(new Request(`https://example.com/api/${path}`), db(), defaults, now, undefined, fetcher);
  expect(res!.status, await res!.clone().text()).toBe(200);
  return res!.json<{ titles: Titled[]; players: unknown[] }>();
}

describe("titles", () => {
  it("lists God then the Demigods with their rating and real place, merged ids as the player they are now", async () => {
    const body = await read(
      "titles?region=eu",
      bot([
        { playerId: 4, region: "eu", title: "Demigod" },
        { playerId: 3, region: "eu", title: "God" },
        { playerId: 7, region: "eu", title: "Demigod" },
        { playerId: 5, region: "na", title: "God" },
      ]),
    );
    expect(body.titles.map((t) => [t.title, t.id, t.rank, t.rating, t.tier?.label])).toEqual([
      ["God", 3, 3, 2300, "Ascendant"],
      ["Demigod", 2, 2, 2600, "Champion"],
      ["Demigod", 4, 4, 2000, "Grandmaster"],
    ]);
  });

  it("shows none without the bot, when it fails, or for a region with none", async () => {
    expect((await read("titles?region=eu")).titles).toEqual([]);
    expect((await read("titles?region=eu", bot([], 500))).titles).toEqual([]);
    expect((await read("titles?region=na", bot([{ playerId: 1, region: "eu", title: "God" }]))).titles).toEqual([]);
  });

  it("is a public route", async () => {
    const res = await SELF.fetch("https://example.com/api/titles?region=eu");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({ region: "eu", titles: [] });
  });

  it("keeps at most one God and three Demigods, best rated first, and a player under one title", () => {
    const rated = new Map([1, 2, 3, 4, 5].map((id) => [id, { playerId: id, display: 3000 - id * 100 }]));
    const entries = [5, 4, 3, 2, 1].map((id) => ({ playerId: id, region: "eu", title: "Demigod" }));
    entries.push({ playerId: 1, region: "eu", title: "God" }, { playerId: 2, region: "eu", title: "God" });
    const picked = pickTitles(entries, "eu", defaults.titles, rated);
    expect(picked.map((p) => [p.title, p.rating.playerId])).toEqual([
      ["God", 1],
      ["Demigod", 2],
      ["Demigod", 3],
      ["Demigod", 4],
    ]);
  });

  it("drops malformed entries from the bot", () => {
    expect(parseTitles({ titles: [{ playerId: 1, region: "eu", title: "God" }, { playerId: "2", region: "eu", title: "God" }, null] })).toEqual([
      { playerId: 1, region: "eu", title: "God" },
    ]);
    expect(parseTitles("nope")).toEqual([]);
  });
});

describe("tiers", () => {
  it("answers each player's tier in every region in one request", async () => {
    const body = await read("tiers?players=3,7,99,1");
    expect(body.players).toEqual([
      expect.objectContaining({ id: 1, playerId: 1, name: "P1", regions: { eu: expect.objectContaining({ rating: 2900, tier: expect.objectContaining({ label: "Sovereign" }) }) } }),
      expect.objectContaining({ id: 3, playerId: 3, regions: { eu: expect.objectContaining({ rating: 2300 }), na: expect.objectContaining({ rating: 1950 }) } }),
      expect.objectContaining({ id: 7, playerId: 2, name: "P2" }),
    ]);
  });

  it("refuses a missing, malformed or too long list", async () => {
    for (const q of ["", "?players=", "?players=1,x", `?players=${Array.from({ length: defaults.tiersMaxPlayers + 1 }, (_, i) => i + 1).join(",")}`]) {
      const res = await handleSite(new Request(`https://example.com/api/tiers${q}`), db(), defaults, now);
      expect(res!.status).toBe(400);
    }
  });
});
