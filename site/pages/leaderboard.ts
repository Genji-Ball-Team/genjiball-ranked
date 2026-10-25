// The leaderboard (index.html): the region's players by rating, in tier bands, a page at a time. Above
// the first page, a strip: who climbed most this week, the latest match and the lobbies open now.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/delta.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/pager.js";
import "@genji-ball-team/ui/panel.js";
import type { GbPager } from "@genji-ball-team/ui/pager.js";
import { api, inRegion, matchLink, openLobbies, playerLink } from "../lib/api";
import { ago, count, date, mapName, matchFlags, num, rating, tierChip, tierName, title, winRate } from "../lib/format";
import { byId, html, raw, render, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { me } from "../lib/me";
import { site } from "../lib/site";
import type { Climbers, Leaderboard, PlayerPage, RecentMatches, TitleName, Titles } from "../lib/types";
import { start } from "../shell";
import { titleChip, titleFx, titleLooks } from "../titles";

/** The rows, with a band heading wherever the tier changes. */
type Row = Leaderboard["players"][number];

function ladder(players: Row[], titles: Map<number, TitleName>, days: number): Html {
  let band: string | undefined;
  const rows = players.map((p) => {
    let head: Html | "" = "";
    if (p.siteTier?.label !== band) {
      band = p.siteTier?.label;
      head = html`<li class="band">${
        p.siteTier ? html`${tierChip(p.siteTier)}<span class="num">${num(p.siteTier.threshold)}+</span>` : "No tier yet"
      }</li>`;
    }
    return html`${head}${entry(p, titles.get(p.id), days)}`;
  });
  byId("floor-note").hidden = !players.some((p) => p.rating <= 0);
  return html`${rows}`;
}

/** The rating change over the last days: "new" for a player with no rating back then. */
function change(p: Row): Html {
  return p.change === null ? html`<span class="muted">new</span>` : html`<gb-delta value="${p.change}"></gb-delta>`;
}

function entry(p: Row, titled: TitleName | undefined, days: number): Html {
  const inactive = p.inactiveSince && `Inactive since ${date(p.inactiveSince)}`;
  const look = titled && titleLooks[titled];
  const mine = p.id === me();
  const classes = ["entry", inactive && "inactive", mine && "me", look].filter(Boolean).join(" ");
  const pos = ["pos", "num", p.rank <= 3 && "high"].filter(Boolean).join(" ");
  // The effect's layer goes last: the columns are counted from the first child.
  return html`<li${mine && raw(' id="me"')}><a class="${classes}" href="${playerLink(p.id)}"${tierName(p.siteTier) && html` data-tier="${tierName(p.siteTier)}"`}>
    <span class="${pos}">${p.rank}</span>
    <span class="who"><b><span class="name">${p.name}</span>${mine && html`<span class="you">You</span>`}${titled && html` ${titleChip(titled)}`}</b>${
      inactive && html`<small>${inactive}</small>`
    }<small class="stats">${p.change ? html`${change(p)} in ${days} days · ` : ""}${num(p.rounds)} rounds, ${winRate(p.wins, p.rounds)} won</small></span>
    <span class="rating num${p.rating > 0 ? "" : " floor"}">${rating(p.rating)}</span>
    <span class="num">${change(p)}</span>
    <span class="num muted">${num(p.rounds)}</span>
    <span class="num muted">${winRate(p.wins, p.rounds)}</span>
    <span class="muted played">${ago(p.lastPlayedAt)}</span>${titled && html`<span class="fx" aria-hidden="true">${raw(titleFx(titled, "row"))}</span>`}</a></li>`;
}

/** Everyone, or only the active players: a link each, keeping the region. */
function whoFilter(active: boolean): void {
  byId<HTMLAnchorElement>("who-all").href = `?${inRegion()}`;
  byId<HTMLAnchorElement>("who-active").href = `?${inRegion()}&active=1`;
  byId(active ? "who-active" : "who-all").setAttribute("aria-current", "true");
}

const panel = (label: string, body: Html): Html => html`<gb-panel label="${label}" level="2">${body}</gb-panel>`;

function climbers(c: Climbers): Html | "" {
  if (!c.players.length) return "";
  return panel(
    c.days === 7 ? "Climbing this week" : `Climbing, last ${c.days} days`,
    html`<ol class="climbers">${c.players.map(
      (p) => html`<li><a href="${playerLink(p.player.id)}">${p.player.name}</a><gb-delta value="${p.change}"></gb-delta><span class="num muted">${rating(p.rating)}</span></li>`,
    )}</ol>`,
  );
}

function latest(m: RecentMatches["matches"][number] | undefined): Html | "" {
  if (!m) return "";
  const winners = m.players.filter((p) => p.place === 1).map((p) => p.name);
  return panel(
    "Latest match",
    html`<a class="latest" href="${matchLink(m.id)}"><b>${winners.join(" & ")}</b> won <span class="muted">${ago(m.playedAt)}</span>
      <small>${mapName(m.map)} · ${count(m.players.length, "player")} ${matchFlags({ ...m, legacy: false })}</small></a>
      <a class="more" href="/matches?${inRegion()}">All matches</a>`,
  );
}

function live(open: number): Html {
  return panel(
    "Live now",
    open
      ? html`<a class="latest" href="/live?${inRegion()}"><b>${count(open, "lobby", "lobbies")} open</b><span class="live-dot" aria-hidden="true"></span></a>
          <a class="more" href="/live?${inRegion()}">Join one</a>`
      : html`<p class="latest muted">No lobby open</p><a class="more" href="/host">Host one</a>`,
  );
}

/** The strip above the first page. A part that can't load is left out; with none, no strip. */
async function strip(): Promise<void> {
  const box = byId("strip");
  const [c, recent, lobbies] = await Promise.all([
    api<{ climbers: Climbers }>(`records?${inRegion()}`).then((r) => climbers(r.climbers), () => ""),
    api<RecentMatches>(`recent?${inRegion()}&limit=1`).then((r) => latest(r.matches[0]), () => ""),
    openLobbies().then((l) => live(l.lobbies.length), () => ""),
  ]);
  if (!c && !recent) return;
  render(box, html`${c}${recent}${lobbies}`);
  box.hidden = false;
}

/** "Jump to me": the remembered player's row, on the full board's page it's on. */
async function jumpToMe(pageSize: number): Promise<void> {
  const id = me();
  if (id === null) return;
  const button = byId("jump");
  // Their page answers with their rank: the board's page follows from it. Off the board, no button.
  const rank = await api<PlayerPage>(`players/${id}?${inRegion()}`).then(
    (p) => p.player.rating?.rank ?? null,
    () => null,
  );
  if (rank === null) return;
  button.hidden = false;
  button.addEventListener("click", () => {
    const row = document.getElementById("me");
    if (row) return row.scrollIntoView({ block: "center", behavior: "smooth" });
    location.href = `?${inRegion()}&page=${Math.ceil(rank / pageSize)}#me`;
  });
}

async function leaderboardPage(): Promise<void> {
  const box = byId("list");
  const query = new URLSearchParams(location.search);
  const page = Math.max(1, Number(query.get("page")) || 1);
  const active = query.get("active") === "1";
  const filter = active ? "&active=1" : "";
  title(`${site.short(site.region)} leaderboard`);
  whoFilter(active);
  if (page === 1) void strip();
  // No titles when the site can't say: the board shows without them.
  const titles = api<Titles>(`titles?${inRegion()}`).then(
    (t) => new Map(t.titles.map((p) => [p.id, p.title])),
    () => new Map<number, TitleName>(),
  );
  try {
    const board = await api<Leaderboard>(`leaderboard?${inRegion()}&page=${page}${filter}`);
    loaded(
      box,
      board.players.length
        ? ladder(board.players, await titles, board.changeDays)
        : html`<li><gb-empty>${
            active ? "No one active has enough rated rounds yet." : "No one has enough rated rounds for the leaderboard yet."
          }</gb-empty></li>`,
    );
    if (location.hash === "#me") document.getElementById("me")?.scrollIntoView({ block: "center" });
    byId("change-days").textContent = `${board.changeDays} days`;
    void jumpToMe(board.pageSize);
    const pager = byId<GbPager>("pager");
    pager.setAttribute("href", `?${inRegion()}${filter}&page={page}`);
    pager.toggleAttribute("more", board.hasMore);
    pager.page = page;
    pager.hidden = page === 1 && !board.hasMore;
  } catch (error) {
    showError(box, error, "leaderboard");
  }
}

start("leaderboard", leaderboardPage);
