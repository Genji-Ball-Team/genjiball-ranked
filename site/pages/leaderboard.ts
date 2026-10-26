// The leaderboard (index.html): the region's players by rating, in tier bands, a page at a time, and
// the filter that picks which of them show (lib/boardFilter.ts).
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/chip-select.js";
import "@genji-ball-team/ui/delta.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/field.js";
import "@genji-ball-team/ui/pager.js";
import "@genji-ball-team/ui/popover.js";
import "@genji-ball-team/ui/segmented.js";
import type { GbChipSelect } from "@genji-ball-team/ui/chip-select.js";
import { tiers } from "@genji-ball-team/ui/chip.js";
import type { GbPager } from "@genji-ball-team/ui/pager.js";
import type { GbSegmented } from "@genji-ball-team/ui/segmented.js";
import { api, inRegion, playerLink } from "../lib/api";
import { boardParams, boardQuery } from "../lib/boardFilter";
import { ago, date, num, rating, tierChip, tierName, title, winRate } from "../lib/format";
import { byId, html, raw, render, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { me } from "../lib/me";
import { site } from "../lib/site";
import type { BoardFilter, Leaderboard, PlayerPage, TitleName, Titles } from "../lib/types";
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

/** The tier options, best first as on the board, then the players below the first tier. */
const tierOptions = [...tiers].reverse().map((t) => ({ value: t, label: t[0]!.toUpperCase() + t.slice(1) }));
const noTier = { value: "none", label: "No tier" };

/** A set part of the filter, as a removable pill: what it's about, what it's set to, and the parameters it clears. */
interface Part {
  name: string;
  value: string;
  clears: string[];
}

function setParts(filter: BoardFilter): Part[] {
  const { tiers: picked, played, rounds, min, max } = filter;
  const parts: Part[] = [];
  if (picked.length) {
    // Best first, as the board and the chips show them.
    const names = [...tierOptions, noTier].filter((t) => picked.includes(t.value)).map((t) => t.label);
    parts.push({ name: "Tier", value: names.join(", "), clears: ["tier"] });
  }
  if (played !== null) parts.push({ name: "Played", value: `last ${played} days`, clears: ["played", "active"] });
  if (rounds !== null) parts.push({ name: "Rounds", value: `${num(rounds)}+`, clears: ["rounds"] });
  if (min !== null || max !== null) {
    const range = min !== null && max !== null ? `${num(min)}–${num(max)}` : min !== null ? `${num(min)}+` : `up to ${num(max!)}`;
    parts.push({ name: "Rating", value: range, clears: ["min", "max"] });
  }
  return parts;
}

/** The filter's controls, count and pills, as the board's answer says the filter is. */
function showFilter(filter: BoardFilter, matched: number | null): void {
  byId<GbChipSelect>("filter-tier").values = filter.tiers;
  byId<GbSegmented>("filter-played").value = filter.played === null ? "" : String(filter.played);
  for (const name of ["rounds", "min", "max"] as const) {
    const input = byId<HTMLInputElement>(`filter-${name}`);
    // Not while it's being typed in: the answer is to an older value.
    if (document.activeElement !== input) input.value = filter[name] === null ? "" : String(filter[name]);
  }
  const parts = setParts(filter);
  const count = byId("filter-count");
  count.textContent = String(parts.length);
  count.hidden = !parts.length;
  byId("filter-open").setAttribute("aria-label", parts.length ? `Filter, ${parts.length} set` : "Filter");
  render(
    byId("filter-pills"),
    html`${parts.map(
      (p) =>
        html`<button type="button" class="filter-pill" data-clears="${p.clears.join(",")}" aria-label="Remove filter: ${p.name} ${p.value}">${p.name} <b>${p.value}</b><span class="x" aria-hidden="true">✕</span></button>`,
    )}${parts.length > 1 ? html`<button type="button" class="filter-pill-clear" data-clears="${boardParams.join(",")}">Clear all</button>` : ""}`,
  );
  const line = byId("matched");
  line.hidden = matched === null;
  line.textContent = matched === null ? "" : `${num(matched)} ${matched === 1 ? "player" : "players"}`;
}

/** The filter as the controls are set, in the order the API echoes it (`none`, then the tiers lowest first). */
function controlsQuery(): URLSearchParams {
  const query = new URLSearchParams();
  const picked = byId<GbChipSelect>("filter-tier").values;
  const tierParam = [noTier.value, ...tiers].filter((t) => picked.includes(t)).join(",");
  if (tierParam) query.set("tier", tierParam);
  const played = byId<GbSegmented>("filter-played").value;
  if (played) query.set("played", played);
  for (const name of ["rounds", "min", "max"] as const) {
    // What the API wouldn't take (a fraction, rounds below 1) is left out rather than failing the board.
    const typed = byId<HTMLInputElement>(`filter-${name}`).value.trim();
    const value = Math.trunc(Number(typed));
    if (typed !== "" && Number.isFinite(value) && (name !== "rounds" || value >= 1)) query.set(name, String(value));
  }
  return query;
}

async function leaderboardPage(): Promise<void> {
  const box = byId("list");
  title(`${site.short(site.region)} leaderboard`);
  // No titles when the site can't say: the board shows without them.
  const titles = api<Titles>(`titles?${inRegion()}`).then(
    (t) => new Map(t.titles.map((p) => [p.id, p.title])),
    () => new Map<number, TitleName>(),
  );
  render(
    byId("filter-tier"),
    html`${[...tierOptions, noTier].map((t) => html`<button value="${t.value}"${t === noTier ? "" : html` tier="${t.value}"`}>${t.label}</button>`)}`,
  );

  let asked = 0;
  async function show(search: string): Promise<void> {
    const query = new URLSearchParams(search);
    const page = Math.max(1, Number(query.get("page")) || 1);
    const filter = boardQuery(query);
    const mine = ++asked;
    try {
      const board = await api<Leaderboard>(`leaderboard?${inRegion()}&page=${page}${filter}`);
      // A later change asked again: its answer is the one to show.
      if (mine !== asked) return;
      loaded(
        box,
        board.players.length
          ? ladder(board.players, await titles, board.changeDays)
          : html`<li><gb-empty>${
              board.matched === null ? "No one has enough rated rounds for the leaderboard yet." : "No players match this filter."
            }</gb-empty></li>`,
      );
      showFilter(board.filter, board.matched);
      byId("change-days").textContent = `${board.changeDays} days`;
      const pager = byId<GbPager>("pager");
      pager.setAttribute("href", `?${inRegion()}${filter}&page={page}`);
      pager.toggleAttribute("more", board.hasMore);
      pager.page = page;
      pager.hidden = page === 1 && !board.hasMore;
      if (mine === 1) {
        if (location.hash === "#me") document.getElementById("me")?.scrollIntoView({ block: "center" });
        void jumpToMe(board.pageSize);
      }
    } catch (error) {
      if (mine === asked) showError(box, error, "leaderboard");
    }
  }

  /** Shows the board for `query`'s filter from its first page, and puts it in the address. */
  function apply(query: URLSearchParams): void {
    const search = `?${inRegion()}${boardQuery(query)}`;
    history.replaceState(history.state, "", search);
    void show(search);
  }

  const form = byId<HTMLFormElement>("filter");
  form.addEventListener("submit", (event) => event.preventDefault());
  // A chip or a segment is picked at once; a number once it's typed (on Enter or leaving the box).
  form.addEventListener("change", () => apply(controlsQuery()));
  byId("filter-clear").addEventListener("click", () => apply(new URLSearchParams()));
  byId("filter-pills").addEventListener("click", (event) => {
    const pill = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-clears]") : null;
    if (!pill) return;
    const query = new URLSearchParams(location.search);
    for (const name of pill.dataset.clears!.split(",")) query.delete(name);
    apply(query);
    byId("filter-open").focus();
  });

  await show(location.search);
}

start("leaderboard", leaderboardPage);
