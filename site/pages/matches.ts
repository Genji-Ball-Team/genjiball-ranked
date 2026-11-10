// The matches page (matches.html): the region's newest matches by day, each with who won and the rest
// of the top three, and where this browser's player finished when they played. With `?player=<id>`,
// only that player's matches, and where they finished.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/delta.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/search.js";
import type { GbButton } from "@genji-ball-team/ui/button.js";
import type { GbSearch } from "@genji-ball-team/ui/search.js";
import { api, inRegion, matchLink, NotFound, playerLink } from "../lib/api";
import { dayOf, timeOf } from "../lib/day";
import { count, mapName, matchFlags, ordinal, title } from "../lib/format";
import { byId, html, raw, render, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { me } from "../lib/me";
import { site } from "../lib/site";
import type { RecentMatches } from "../lib/types";
import { findPlayers, start } from "../shell";

type Match = RecentMatches["matches"][number];

/** One player's matches, or the region's. */
const matchesLink = (playerId?: number): string => (playerId === undefined ? `/matches?${inRegion()}` : `/matches?player=${playerId}&${inRegion()}`);

/** Whose place the list shows: the player it's filtered to, else this browser's player ("You"). */
interface Focus {
  id: number | null;
  you: boolean;
}

// The winner by name, then second and third; everyone sharing first place is a winner.
function podium(m: Match): Html {
  const winners = m.players.filter((p) => p.place === 1);
  const next = m.players.filter((p) => p.place === 2 || p.place === 3).slice(0, 2);
  const won = winners[0]?.roundWins ?? 0;
  return html`<span class="podium"><b>${winners.map((p) => p.name).join(" & ")}</b><small>${count(won, "round")} won${next.length > 0 && html` · then ${next.map((p) => p.name).join(", ")}`}</small></span>`;
}

// Where the focused player finished, with their rating change; else how many played.
function side(m: Match, focus: Focus): Html {
  const mine = focus.id === null ? undefined : m.players.find((p) => p.id === focus.id);
  if (!mine) return html`<span class="side muted">${count(m.players.length, "player")}</span>`;
  const change = mine.ratingAfter !== null && mine.ratingBefore !== null ? mine.ratingAfter - mine.ratingBefore : 0;
  return html`<span class="side">${focus.you && html`<span class="you">You</span>`}<b${mine.place === 1 && raw(' class="won"')}>${ordinal(mine.place)}</b>${
    change !== 0 && html`<gb-delta value="${change}"></gb-delta>`
  }</span>`;
}

// Legacy is only worth a chip when it sets a match apart from the others in the list.
function row(m: Match, mixed: boolean, focus: Focus): Html {
  return html`<li><a href="${matchLink(m.id)}"><span class="when num">${timeOf(m.playedAt)}</span>
    <span class="map"><span class="map-name">${mapName(m.map)}</span> ${matchFlags({ ...m, legacy: m.legacy && mixed })}</span>
    ${podium(m)}${side(m, focus)}</a></li>`;
}

/** Matches under their day's heading, carrying on from the last one shown (`after`). */
function rows(matches: Match[], all: Match[], focus: Focus, after?: Match): Html {
  let day = after && dayOf(after.playedAt);
  return html`${matches.map((m) => {
    const today = dayOf(m.playedAt);
    const heading = today !== day && html`<li class="day">${today}</li>`;
    day = today;
    return html`${heading}${row(m, all.some((o) => o.legacy !== m.legacy), focus)}`;
  })}`;
}

/** Every match shown on one map: the map column would say the same each time, so it's left out. */
function oneMap(shown: Match[]): void {
  byId("matches").classList.toggle("one-map", new Set(shown.map((m) => m.map)).size === 1);
}

/** "Show more": the next older matches under the list, until there are none. */
function showMore(shown: Match[], query: string, focus: Focus): void {
  const button = byId<GbButton>("more-matches");
  const list = byId("matches");
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.busy = true;
    try {
      const more = await api<RecentMatches>(`recent?${query}&before=${shown.at(-1)!.id}`);
      const last = shown.at(-1);
      shown.push(...more.matches);
      list.insertAdjacentHTML("beforeend", rows(more.matches, shown, focus, last).value);
      oneMap(shown);
      button.hidden = !more.hasMore;
      button.textContent = "Show more";
    } catch {
      button.textContent = "Couldn't load more: try again";
    } finally {
      button.busy = false;
    }
  });
}

async function matchesPage(): Promise<void> {
  const param = new URLSearchParams(location.search).get("player");
  const playerId = param && /^[1-9]\d{0,15}$/.test(param) ? Number(param) : null;
  const where = site.label(site.region);
  title(`${site.short(site.region)} matches`);
  const box = byId("matches");
  findPlayers(byId<GbSearch>("find-matches"), matchesLink);
  const query = playerId === null ? inRegion() : `${inRegion()}&player=${playerId}`;
  try {
    const d = await api<RecentMatches>(`recent?${query}`);
    const player = d.player ?? null;
    const focus: Focus = player ? { id: player.id, you: player.id === me() } : { id: me(), you: true };
    if (player) {
      title(`${player.name}'s matches (${site.short(site.region)})`);
      render(byId("heading"), html`<a href="${playerLink(player.id)}">${player.name}</a><span class="muted">: matches</span>`);
      render(byId("about"), html`<a href="${matchesLink()}">All matches</a>`);
      byId("about").hidden = false;
    }
    const empty = player ? `${player.name} hasn't played a match in ${where} yet.` : `No matches in ${where} yet.`;
    loaded(box, d.matches.length ? rows(d.matches, d.matches, focus) : html`<li><gb-empty>${empty}</gb-empty></li>`);
    oneMap(d.matches);
    if (d.hasMore) showMore(d.matches, query, focus);
  } catch (error) {
    if (error instanceof NotFound) byId("heading").textContent = "Player not found";
    showError(box, error, playerId === null ? "matches" : "player");
  }
}

start("matches", matchesPage);
