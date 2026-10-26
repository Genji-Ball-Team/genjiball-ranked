// Use the data (data.html): the public API (docs/api.md, "Site") for anyone building their own tools.
// The endpoints link to live answers in this page's region, with ids from the newest match; the
// leaderboard downloads as a CSV, read page by page from the same API the site uses.
import "@genji-ball-team/ui/button.js";
import { api, inRegion } from "../lib/api";
import { byId, html, render, type Html } from "../lib/html";
import { site } from "../lib/site";
import type { Leaderboard } from "../lib/types";
import { start } from "../shell";

interface Endpoint {
  path: (ids: Ids) => string | undefined;
  label: string;
  what: string;
}

interface Ids {
  match?: number;
  player?: number;
  rival?: number;
}

const endpoints: Endpoint[] = [
  {
    label: "leaderboard?page=1",
    path: () => `leaderboard?page=1&${inRegion()}`,
    what: "The board a page at a time, with each player's tier and change this week.",
  },
  {
    label: "players?search=",
    path: () => `players?search=gen&${inRegion()}`,
    what: "Players whose name or an old name contains the text.",
  },
  {
    label: "players/:id",
    path: (ids) =>
      ids.player ? `players/${ids.player}?${inRegion()}` : undefined,
    what: "A player's rating, newest matches and rivals.",
  },
  {
    label: "players/:id/history",
    path: (ids) =>
      ids.player ? `players/${ids.player}/history?${inRegion()}` : undefined,
    what: "Their rating after each match, peak, streaks and form.",
  },
  {
    label: "head-to-head?a=&b=",
    path: (ids) =>
      ids.player && ids.rival
        ? `head-to-head?a=${ids.player}&b=${ids.rival}&${inRegion()}`
        : undefined,
    what: "Two players' rounds and kills against each other.",
  },
  {
    label: "recent",
    path: () => `recent?${inRegion()}`,
    what: "The newest matches with their places.",
  },
  {
    label: "matches/:id",
    path: (ids) => (ids.match ? `matches/${ids.match}` : undefined),
    what: "One match, round by round, with every player's stats.",
  },
  {
    label: "matches?after=",
    path: () => `matches?after=0&${inRegion()}`,
    what: "The match feed: every match that changed after a cursor, oldest first.",
  },
  {
    label: "records",
    path: () => `records?${inRegion()}`,
    what: "The records, recent activity and the top hosts.",
  },
  {
    label: "lobbies",
    path: () => `lobbies?${inRegion()}`,
    what: "The ranked lobbies open now.",
  },
  {
    label: "tourneys",
    path: () => `tourneys?${inRegion()}`,
    what: "Upcoming and past tourneys with their standings.",
  },
  {
    label: "rules",
    path: () => "rules",
    what: "The tiers and how far a match can move a rating.",
  },
];

function drawEndpoints(ids: Ids): void {
  const rows = endpoints.map((e) => {
    const path = e.path(ids);
    const name = html`<code>/api/${e.label}</code>`;
    return html`<dt>
        ${path ? html`<a href="/api/${path}" target="_blank" rel="noopener">${name}</a>` : name}
      </dt>
      <dd>${e.what}</dd>`;
  });
  render(byId("endpoints"), html`${rows}`);
}

function code(title: string, source: string): Html {
  return html`<figure class="example">
    <figcaption>${title}</figcaption>
    <pre><code>${source}</code></pre>
  </figure>`;
}

function drawExamples(): void {
  const base = `${location.origin}/api`;
  const region = site.region;
  render(
    byId("examples"),
    html`${code(
      "The top 10",
      `const res = await fetch("${base}/leaderboard?region=${region}");
const { players } = await res.json();
for (const p of players.slice(0, 10)) console.log(p.rank, p.name, p.rating);`,
    )}${code(
      "Every match, then only the new ones",
      `let cursor = 0; // keep it, and start from it next time
for (;;) {
  const res = await fetch(\`${base}/matches?after=\${cursor}&limit=20&region=${region}\`);
  const feed = await res.json();
  for (const match of feed.matches) save(match); // match.removed: take it down
  cursor = feed.cursor;
  if (!feed.hasMore) break;
}`,
    )}`,
  );
}

/** The newest match's id and its top two players, for the links that need an id. */
async function sampleIds(): Promise<Ids> {
  const res = await fetch(`/api/recent?limit=1&${inRegion()}`);
  showCaching(res.headers.get("Cache-Control"));
  if (!res.ok) return {};
  const { matches } = (await res.json()) as {
    matches: { id: number; players: { id: number }[] }[];
  };
  const match = matches[0];
  return match
    ? {
        match: match.id,
        player: match.players[0]?.id,
        rival: match.players[1]?.id,
      }
    : {};
}

function showCaching(header: string | null): void {
  const seconds = Number(/max-age=(\d+)/.exec(header ?? "")?.[1]);
  if (!seconds) return;
  const time =
    seconds % 60 === 0
      ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}`
      : `${seconds} seconds`;
  byId("caching").textContent =
    `Answers are cached for ${time === "1 minute" ? "a minute" : time}: asking again sooner gets the same answer.`;
}

const csvColumns = [
  "rank",
  "id",
  "name",
  "rating",
  "rounds",
  "wins",
  "tier",
  "lastPlayedAt",
  "inactiveSince",
] as const;

const csvCell = (value: string | number | null): string => {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function downloadCsv(
  button: HTMLElement & { disabled: boolean },
): Promise<void> {
  const state = byId("csv-state");
  button.disabled = true;
  const lines = [csvColumns.join(",")];
  try {
    for (let page = 1; ; page++) {
      state.textContent = `Reading page ${page}…`;
      const board = await api<Leaderboard>(
        `leaderboard?page=${page}&${inRegion()}`,
      );
      for (const p of board.players) {
        const row = {
          ...p,
          rating: Math.round(p.rating),
          tier: p.tier?.label ?? null,
        };
        lines.push(csvColumns.map((c) => csvCell(row[c])).join(","));
      }
      if (!board.hasMore) break;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" }),
    );
    a.download = `genjiball-${site.region}-leaderboard-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    state.textContent = `${lines.length - 1} players, ${site.label(site.region)}.`;
  } catch (error) {
    console.error("leaderboard csv", error);
    state.textContent = "Couldn't read the leaderboard. Try again.";
  } finally {
    button.disabled = false;
  }
}

async function dataPage(): Promise<void> {
  const button = byId<HTMLElement & { disabled: boolean }>("csv");
  button.addEventListener("click", () => void downloadCsv(button));
  drawEndpoints({});
  drawExamples();
  try {
    drawEndpoints(await sampleIds());
  } catch {
    // No sample: the endpoints that need an id stay without a link.
  }
}

start("data", dataPage);
