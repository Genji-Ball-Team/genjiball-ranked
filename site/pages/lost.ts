// The 404 page (404.html, served by the Worker for any page that isn't there): what was asked for, a
// guess at what was meant, where to go instead, and a small Genji Ball to play while here.
import "@genji-ball-team/ui/search.js";
import type { GbSearch } from "@genji-ball-team/ui/search.js";
import { byId, html, render, type Html } from "../lib/html";
import { playLost } from "../lost-game";
import { start } from "../shell";

// The site's pages, with the other names people try for them.
const pages = [
  { href: "/", label: "Leaderboard", names: ["leaderboard", "leaderboards", "ladder", "board", "rankings", "ranking", "ranked", "rank", "home", "index", "players", "top"] },
  { href: "/live", label: "Live", names: ["live", "lobbies", "lobby", "now", "games"] },
  { href: "/records", label: "Records", names: ["records", "record", "stats", "statistics", "bests"] },
  { href: "/tourneys", label: "Tourneys", names: ["tourneys", "tourney", "tournaments", "tournament", "events", "cups"] },
  { href: "/compare", label: "Compare players", names: ["compare", "versus", "vs", "head-to-head", "h2h"] },
];

/** Edits (insert, delete, swap a letter, or swap two neighbours) from a to b. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  const set = (i: number, j: number, value: number): void => {
    (d[i] as number[])[j] = value;
  };
  for (let j = 1; j <= b.length; j++) set(0, j, j);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      set(i, j, Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) set(i, j, Math.min(at(i, j), at(i - 2, j - 2) + 1));
    }
  }
  return at(a.length, b.length);
}

/** What the address may have meant: the page it's a typo of, and a player to look for. */
function guesses(path: string): { page?: (typeof pages)[number]; player?: string } {
  const parts = path
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .map((part) => part.trim())
    .filter(Boolean);
  const head = parts[0] ?? "";
  const first = head.toLowerCase().replace(/\.html?$/, "");
  // /player/Name, /u/Name and the like: someone looking for a player, not a page.
  const forPlayer = /^(player|players|profile|user|u|p)$/i.test(head) && parts.length > 1;

  // The closest page by name, if it's close enough to be a typo rather than a different word.
  let best: { page: (typeof pages)[number]; d: number } | undefined;
  for (const page of forPlayer ? [] : pages) {
    for (const name of page.names) {
      const d = distance(first, name);
      if (d <= Math.max(1, Math.floor(name.length / 3)) && (!best || d < best.d)) best = { page, d };
    }
  }

  // That, /@Name or just /Name: a player, most likely.
  const name = forPlayer ? parts[1] : parts.length === 1 && !best ? head.replace(/^@/, "") : undefined;
  const player = name && name.length <= 32 && !/\.\w{2,4}$/.test(name) ? name : undefined;
  return { page: best?.page, player };
}

function lostPage(): void {
  const path = location.pathname;
  const shown = byId("lost-path");
  shown.textContent = path.length > 60 ? `${path.slice(0, 57)}…` : path;
  shown.title = path;

  const { page, player } = guesses(path);
  const lines: Html[] = [];
  if (page) lines.push(html`Did you mean <a href="${page.href}">${page.label}</a>?`);
  if (player) lines.push(html`<a href="/?find" data-player="${player}">Search for “${player}”</a>`);
  if (lines.length) {
    const list = byId("lost-guess");
    render(list, html`${lines.map((line) => html`<li>${line}</li>`)}`);
    list.hidden = false;
    // The player search is on this page: fill it in rather than leave for the leaderboard.
    list.querySelector<HTMLAnchorElement>("a[data-player]")?.addEventListener("click", (e) => {
      e.preventDefault();
      const search = byId<GbSearch>("lost-search");
      search.value = player ?? "";
      search.input.dispatchEvent(new Event("input", { bubbles: true }));
      search.input.focus();
    });
  }

  playLost();
}

start("not-found", lostPage);
