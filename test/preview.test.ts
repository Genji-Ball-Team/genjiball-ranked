import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/bytes";
import { hoursAgo, matchId, matchLog, playerId, uploadLog } from "./helpers";

const db = () => env.DB;
const token = "trusted-token";
const discord = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const browser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** Two EU matches of Alpha, Bravo, Charlie and Delta: Alpha wins round 1 of each, Bravo round 2. */
beforeEach(async () => {
  const tables = ["events", "round_players", "rounds", "match_players", "rating_history", "ratings", "matches", "uploads", "aliases", "players", "hosts"];
  await db().batch([
    ...tables.map((t) => db().prepare(`DELETE FROM ${t}`)),
    db().prepare("UPDATE rating_state SET version = 0, stale_played_at = NULL, stale_match_id = NULL, stale_since = NULL, recomputed_at = NULL"),
    db().prepare("INSERT INTO hosts (id, name, token_hash, trust, region) VALUES (1, 'trusted', ?, 'trusted', 'eu')").bind(await sha256(token)),
  ]);
  await uploadLog(matchLog({ key: "000000000001" }), token, hoursAgo(3));
  await uploadLog(matchLog({ key: "000000000002" }), token, hoursAgo(2));
});

async function page(path: string, agent = discord) {
  const res = await SELF.fetch(`https://example.com${path}`, { headers: { "User-Agent": agent } });
  expect(res.status).toBe(200);
  const html = await res.text();
  const meta = (attr: string, name: string) => new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`).exec(html)?.[1];
  return {
    res,
    html,
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
    ogTitle: meta("property", "og:title"),
    description: meta("name", "description"),
    ogDescription: meta("property", "og:description"),
    image: meta("property", "og:image"),
    url: meta("property", "og:url"),
  };
}

describe("link previews", () => {
  it("gives a crawler a player's tier, rating and rank", async () => {
    const id = await playerId("Alpha");
    const p = await page(`/player?id=${id}&region=eu`);
    // New players are below the first tier: just the rating.
    expect(p.ogTitle).toMatch(/^Alpha · \d+$/);
    expect(p.title).toBe(`${p.ogTitle} – Genji Ball Ranked`);
    expect(p.ogDescription).toMatch(/^#\d on the Europe leaderboard\. 4 rated rounds, \d+% won\.$/);
    expect(p.description).toBe(p.ogDescription);
    expect(p.image).toBe("https://example.com/og.png");
    expect(p.url).toBe(`https://example.com/player?id=${id}&region=eu`);
    expect(p.res.headers.get("Cache-Control")).toBe("no-store");
    expect(p.res.headers.get("Vary")).toBe("User-Agent");
  });

  it("says a player has no rating in a region they haven't played", async () => {
    const p = await page(`/player?id=${await playerId("Alpha")}&region=na`);
    expect(p.ogTitle).toBe("Alpha (North America)");
    expect(p.ogDescription).toContain("No rated rounds in North America yet");
  });

  it("gives a match's winner and podium", async () => {
    const id = await matchId("000000000002");
    const p = await page(`/match?id=${id}`, "TelegramBot (like TwitterBot)");
    // Alpha and Bravo each won a round, with as many kills.
    expect(p.ogTitle).toBe(`Match ${id} · Alpha & Bravo share the win`);
    expect(p.ogDescription).toMatch(/^4 players, 2 rounds in Europe, \d{4}-\d\d-\d\d\. 1\. /);
  });

  it("names the players of a compare link", async () => {
    const [a, b] = [await playerId("Alpha"), await playerId("Bravo")];
    const p = await page(`/compare?ids=${a},${b},999&region=eu`, "facebookexternalhit/1.1");
    expect(p.ogTitle).toBe("Alpha vs Bravo");
    expect(p.ogDescription).toMatch(/^Alpha: .+ · Bravo: .+\. Side by side in Europe\.$/);
  });

  it("keeps the site's own title for a player or match that isn't there", async () => {
    for (const path of ["/player?id=999", "/match?id=999", "/player?id=abc", "/compare"]) {
      const p = await page(path);
      expect(p.title, path).toMatch(/^\w+ – Genji Ball Ranked$/);
      expect(p.image, path).toBe("https://example.com/og.png");
    }
  });

  it("hands a visitor the page as it is", async () => {
    const p = await page(`/player?id=${await playerId("Alpha")}&region=eu`, browser);
    expect(p.title).toBe("Player – Genji Ball Ranked");
    expect(p.url).toBe("https://genjiball.us/player");
    expect(p.html).toContain('<script src="/share.js"></script>');
  });
});
