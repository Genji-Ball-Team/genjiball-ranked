// The leaderboard (index.html): the region's players by rating, in tier bands, a page at a time.
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/pager.js";
import type { GbPager } from "@genji-ball-team/ui/pager.js";
import { api, inRegion, playerLink } from "../lib/api";
import { date, num, rating, tierChip, tierName, title, winRate } from "../lib/format";
import { byId, html, raw, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import type { Leaderboard, LeaderboardPlayer, TitleName, Titles } from "../lib/types";
import { start } from "../shell";
import { titleChip, titleFx, titleLooks } from "../titles";

/** The rows, with a band heading wherever the tier changes. */
function ladder(players: LeaderboardPlayer[], titles: Map<number, TitleName>): Html {
  let band: string | undefined;
  const rows = players.map((p) => {
    let head: Html | "" = "";
    if (p.siteTier?.label !== band) {
      band = p.siteTier?.label;
      head = html`<li class="band">${
        p.siteTier ? html`${tierChip(p.siteTier)}<span class="num">${num(p.siteTier.threshold)}+</span>` : "No tier yet"
      }</li>`;
    }
    return html`${head}${entry(p, titles.get(p.id))}`;
  });
  byId("floor-note").hidden = !players.some((p) => p.rating <= 0);
  return html`${rows}`;
}

function entry(p: LeaderboardPlayer, titled: TitleName | undefined): Html {
  const inactive = p.inactiveSince && `Inactive since ${date(p.inactiveSince)}`;
  const look = titled && titleLooks[titled];
  const classes = ["entry", inactive && "inactive", look].filter(Boolean).join(" ");
  const pos = ["pos", "num", p.rank <= 3 && "high"].filter(Boolean).join(" ");
  // The effect's layer goes last: the columns are counted from the first child.
  return html`<li><a class="${classes}" href="${playerLink(p.id)}"${tierName(p.siteTier) && html` data-tier="${tierName(p.siteTier)}"`}>
    <span class="${pos}">${p.rank}</span>
    <span class="who"><b><span class="name">${p.name}</span>${titled && html` ${titleChip(titled)}`}</b>${
      inactive && html`<small>${inactive}</small>`
    }<small class="stats">${num(p.rounds)} rounds, ${winRate(p.wins, p.rounds)} won</small></span>
    <span class="rating num${p.rating > 0 ? "" : " floor"}">${rating(p.rating)}</span>
    <span class="num muted">${num(p.rounds)}</span>
    <span class="num muted">${winRate(p.wins, p.rounds)}</span>${titled && html`<span class="fx" aria-hidden="true">${raw(titleFx(titled, "row"))}</span>`}</a></li>`;
}

async function leaderboardPage(): Promise<void> {
  const box = byId("list");
  const page = Math.max(1, Number(new URLSearchParams(location.search).get("page")) || 1);
  title(`${site.short(site.region)} leaderboard`);
  // No titles when the site can't say: the board shows without them.
  const titles = api<Titles>(`titles?${inRegion()}`).then(
    (t) => new Map(t.titles.map((p) => [p.id, p.title])),
    () => new Map<number, TitleName>(),
  );
  try {
    const board = await api<Leaderboard>(`leaderboard?${inRegion()}&page=${page}`);
    loaded(
      box,
      board.players.length
        ? ladder(board.players, await titles)
        : html`<li><gb-empty>No one has enough rated rounds for the leaderboard yet.</gb-empty></li>`,
    );
    const pager = byId<GbPager>("pager");
    pager.setAttribute("href", `?${inRegion()}&page={page}`);
    pager.toggleAttribute("more", board.hasMore);
    pager.page = page;
    pager.hidden = page === 1 && !board.hasMore;
  } catch (error) {
    showError(box, error, "leaderboard");
  }
}

start("leaderboard", leaderboardPage);
