// The leaderboard (index.html): the region's players by rating, a page at a time.
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/leaderboard.js";
import "@genji-ball-team/ui/pager.js";
import type { GbPager } from "@genji-ball-team/ui/pager.js";
import { api, inRegion, playerLink } from "../lib/api";
import { count, date, rating, tierChip, tierName, title, winRate } from "../lib/format";
import { byId, html, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import type { Leaderboard, LeaderboardPlayer, TitleName, Titles } from "../lib/types";
import { start } from "../shell";
import { titleChip, titleRow } from "../titles";

/** One row of `<gb-leaderboard>`: place, player, tier, rating, and the share of rounds won. */
function row(p: LeaderboardPlayer, titled: TitleName | undefined): Html {
  const tier = tierName(p.siteTier);
  const inactive = p.inactiveSince && `Inactive since ${date(p.inactiveSince)}`;
  return html`<tr${tier && html` data-tier="${tier}"`}${titled && html` data-title="${titleRow[titled]}"`}${inactive && html` data-inactive title="${inactive}"`}>
    <td>${p.rank}</td>
    <td><a href="${playerLink(p.id)}">${p.name}</a>${titled && titleChip(titled)}</td>
    <td>${tierChip(p.siteTier)}</td>
    <td${p.rating > 0 ? "" : html` class="floor"`}>${rating(p.rating)}</td>
    <td title="${count(p.rounds, "round")}">${winRate(p.wins, p.rounds)}</td>
  </tr>`;
}

function board(players: LeaderboardPlayer[], titles: Map<number, TitleName>): Html {
  byId("floor-note").hidden = !players.some((p) => p.rating <= 0);
  return html`<gb-leaderboard>
    <table>
      <thead><tr><th>Place</th><th>Player</th><th>Tier</th><th>Rating</th><th>Rounds won</th></tr></thead>
      <tbody>${players.map((p) => row(p, titles.get(p.id)))}</tbody>
    </table>
  </gb-leaderboard>`;
}

async function leaderboardPage(): Promise<void> {
  const box = byId("board");
  const page = Math.max(1, Number(new URLSearchParams(location.search).get("page")) || 1);
  title(`${site.short(site.region)} leaderboard`);
  // No titles when the site can't say: the board shows without them.
  const titles = api<Titles>(`titles?${inRegion()}`).then(
    (t) => new Map(t.titles.map((p) => [p.id, p.title])),
    () => new Map<number, TitleName>(),
  );
  try {
    const answer = await api<Leaderboard>(`leaderboard?${inRegion()}&page=${page}`);
    loaded(
      box,
      answer.players.length
        ? board(answer.players, await titles)
        : html`<gb-empty>No one has enough rated rounds for the leaderboard yet.</gb-empty>`,
    );
    const pager = byId<GbPager>("pager");
    pager.setAttribute("href", `?${inRegion()}&page={page}`);
    pager.toggleAttribute("more", answer.hasMore);
    pager.page = page;
    pager.hidden = page === 1 && !answer.hasMore;
  } catch (error) {
    showError(box, error, "leaderboard");
  }
}

start("leaderboard", leaderboardPage);
