// The tourneys list (tourneys.html): the ones coming up, then the results of the past ones, a page at
// a time. Each opens its own page (tourney.ts).
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/icon.js";
import "@genji-ball-team/ui/pager.js";
import type { GbPager } from "@genji-ball-team/ui/pager.js";
import { api, inRegion } from "../lib/api";
import { count, title } from "../lib/format";
import { byId, html, render, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import {
  cup,
  fullChip,
  played,
  signedUp,
  statusChip,
  tourneyLink,
  until,
  verifiedChip,
  winners,
  type Tourney,
  type TourneyList,
} from "../lib/tourney";
import { start } from "../shell";

/** The date as a block: weekday and day big, month and time small, in the viewer's time zone. */
function dateBlock(iso: string): Html {
  const d = new Date(iso);
  const part = (options: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, options);
  const year = d.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return html`<time class="day" datetime="${iso}"><small>${part({ weekday: "short" })}</small><b class="num">${part({ day: "numeric" })}</b>
    <small>${part({ month: "short", year })} · ${d.toLocaleTimeString(undefined, { timeStyle: "short" })}</small></time>`;
}

function upcomingItem(t: Tourney): Html {
  const lobbies = t.lobbies.length > 0 && `${count(t.lobbies.length, "lobby", "lobbies")}: ${t.lobbies.map((l) => l.label).join(", ")}`;
  const signups = (t.signups.open || t.signups.count > 0) && signedUp(t);
  return html`<li><a href="${tourneyLink(t.id)}">
    ${dateBlock(t.startsAt)}
    <span class="what"><b>${t.name}</b>${t.notes && html`<small>${t.notes}</small>`}${lobbies && html`<small class="muted">${lobbies}</small>`}${
      signups && html`<small class="muted">${signups}</small>`
    }</span>
    <span class="side">${t.signups.full && fullChip}${t.status === "live" ? statusChip("live") : html`<span class="soon">${until(t.startsAt)}</span>`}</span></a></li>`;
}

function pastItem(t: Tourney): Html {
  // The tourney's winner when an admin set one, else each lobby's.
  const results = t.winner
    ? [html`<span class="winner">${cup}<b>${t.winner.name}</b><small>Tourney winner</small></span>`]
    : t.lobbies
    .filter((l) => l.standings.length)
    .map((l) => {
      const won = winners(l);
      return html`<span class="winner">${cup}<b>${won.map((s) => s.name).join(" & ")}</b>
        <small>${t.lobbies.length > 1 && `${l.label} · `}${won[0]?.wins} won</small></span>`;
    });
  const thumbs = t.lobbies
    .filter((l) => l.screenshot)
    .slice(0, 2)
    .map((l) => html`<img src="${l.screenshot}" alt="" loading="lazy" decoding="async">`);
  const flag = t.status === "cancelled" ? statusChip("cancelled") : played(t) && verifiedChip(t.lobbies.every((l) => l.verified));
  const none = t.status === "cancelled" ? "Didn't take place." : "No results yet.";
  return html`<li><a href="${tourneyLink(t.id)}">
    ${dateBlock(t.startsAt)}
    <span class="what"><b>${t.name}</b>${results.length ? results : html`<small class="muted">${none}</small>`}</span>
    <span class="side">${flag}${thumbs.length > 0 && html`<span class="thumbs">${thumbs}</span>`}</span></a></li>`;
}

async function tourneysPage(): Promise<void> {
  const page = Math.max(1, Number(new URLSearchParams(location.search).get("page")) || 1);
  const short = site.short(site.region);
  title(`${short} tourneys`);
  const past = byId("past");
  try {
    const list = await api<TourneyList>(`tourneys?${inRegion()}&page=${page}`);
    if (list.upcoming.length) {
      byId("upcoming-section").hidden = false;
      render(byId("upcoming"), html`${list.upcoming.map(upcomingItem)}`);
    }
    loaded(
      past,
      list.past.length
        ? html`${list.past.map(pastItem)}`
        : html`<li><gb-empty>No ${short} tourney has been played yet.</gb-empty></li>`,
    );
    const pager = byId<GbPager>("pager");
    pager.setAttribute("href", `?${inRegion()}&page={page}`);
    pager.toggleAttribute("more", list.hasMore);
    pager.page = page;
    pager.hidden = page === 1 && !list.hasMore;
  } catch (error) {
    showError(past, error, "tourney list");
  }
}

start("tourneys", tourneysPage);
