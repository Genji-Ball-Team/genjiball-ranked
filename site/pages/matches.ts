// The matches page (matches.html): the region's newest matches, each with who won and the rest of the
// top three, and where this browser's player finished when they played.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/delta.js";
import "@genji-ball-team/ui/empty.js";
import type { GbButton } from "@genji-ball-team/ui/button.js";
import { api, inRegion, matchLink } from "../lib/api";
import { count, mapName, matchFlags, ordinal, title } from "../lib/format";
import { byId, html, raw, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { me } from "../lib/me";
import { site } from "../lib/site";
import type { RecentMatches } from "../lib/types";
import { start } from "../shell";

type Match = RecentMatches["matches"][number];

function when(iso: string): Html {
  const d = new Date(iso);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: thisYear ? undefined : "numeric" });
  return html`<span class="when">${day}<small>${d.toLocaleTimeString(undefined, { timeStyle: "short" })}</small></span>`;
}

// The winner by name, then second and third; everyone sharing first place is a winner.
function podium(m: Match): Html {
  const winners = m.players.filter((p) => p.place === 1);
  const next = m.players.filter((p) => p.place === 2 || p.place === 3).slice(0, 2);
  const won = winners[0]?.roundWins ?? 0;
  return html`<span class="podium"><b>${winners.map((p) => p.name).join(" & ")}</b><small>${count(won, "round")} won${next.length > 0 && html` · then ${next.map((p) => p.name).join(", ")}`}</small></span>`;
}

// Where this browser's player finished, with their rating change; else how many played.
function side(m: Match): Html {
  const mine = m.players.find((p) => p.id === me());
  if (!mine) return html`<span class="side muted">${count(m.players.length, "player")}</span>`;
  const change = mine.ratingAfter !== null && mine.ratingBefore !== null ? mine.ratingAfter - mine.ratingBefore : 0;
  return html`<span class="side"><span class="you">You</span><b${mine.place === 1 && raw(' class="won"')}>${ordinal(mine.place)}</b>${
    change !== 0 && html`<gb-delta value="${change}"></gb-delta>`
  }</span>`;
}

// Legacy is only worth a chip when it sets a match apart from the others in the list.
function row(m: Match, mixed: boolean): Html {
  return html`<li><a href="${matchLink(m.id)}">${when(m.playedAt)}
    <span class="map">${mapName(m.map)} ${matchFlags({ ...m, legacy: m.legacy && mixed })}</span>
    ${podium(m)}${side(m)}</a></li>`;
}

const rows = (matches: Match[], all: Match[]): Html => html`${matches.map((m) => row(m, all.some((o) => o.legacy !== m.legacy)))}`;

/** "Show more": the next older matches under the list, until there are none. */
function showMore(shown: Match[]): void {
  const button = byId<GbButton>("more-matches");
  const list = byId("matches");
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.busy = true;
    try {
      const more = await api<RecentMatches>(`recent?${inRegion()}&before=${shown.at(-1)!.id}`);
      shown.push(...more.matches);
      list.insertAdjacentHTML("beforeend", rows(more.matches, shown).value);
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
  title(`${site.short(site.region)} matches`);
  const box = byId("matches");
  try {
    const d = await api<RecentMatches>(`recent?${inRegion()}`);
    loaded(box, d.matches.length ? rows(d.matches, d.matches) : html`<li><gb-empty>No matches in ${site.label(site.region)} yet.</gb-empty></li>`);
    if (d.hasMore) showMore(d.matches);
  } catch (error) {
    showError(box, error, "matches");
  }
}

start("matches", matchesPage);
