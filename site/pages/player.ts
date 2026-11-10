// A player's page (player.html): their rating, rank and tier in this region, how far the next tier
// is, their rating over time and form, their rivals and their recent matches.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/delta.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/rating-chart.js";
import type { GbButton } from "@genji-ball-team/ui/button.js";
import type { GbRatingChart, TierLine } from "@genji-ball-team/ui/rating-chart.js";
import type { GbSegmented } from "@genji-ball-team/ui/segmented.js";
import { api, idParam, inRegion, matchLink, NotFound, playerLink } from "../lib/api";
import { duelIcon, duelsLink, record } from "../lib/duels";
import { count, date, killDeath, mapName, matchFlags, num, ordinal, rating, tierChip, tierName, title, winRate } from "../lib/format";
import { byId, html, Html, raw, render } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { me, setMe } from "../lib/me";
import { site } from "../lib/site";
import type { History, HistoryPoint, PlayerDuel, PlayerDuels, PlayerMatch, PlayerMatches, PlayerPage, PlayerRating, Rival, Tier, Titles, TitleName } from "../lib/types";
import { attach, type PlayerCard } from "../share";
import { start } from "../shell";
import { titleChip, titleFx, titleLooks, titleSeals } from "../titles";

const siteName = "Genji Ball Ranked";

/** "This is me": remembers this player for the leaderboard, which highlights their row. Pressed again, forgets them. */
function meButton(box: HTMLElement, id: number): void {
  const button = document.createElement("gb-button");
  button.className = "me-button";
  button.setAttribute("variant", "ghost");
  const show = () => {
    const mine = me() === id;
    button.setAttribute("aria-pressed", String(mine));
    button.textContent = mine ? "✓ This is me" : "This is me";
  };
  button.addEventListener("click", () => {
    setMe(me() === id ? null : id);
    show();
  });
  show();
  box.append(button);
}

/** A "Duels stats" button, with their duel record, for a player who has played a duel here. */
async function duelsButton(box: HTMLElement, id: number): Promise<void> {
  const d = await api<PlayerDuels>(`players/${id}/duels?${inRegion()}`).catch(() => null);
  if (!d?.duels) return;
  box.insertAdjacentHTML(
    "beforeend",
    html`<a class="duels-button" href="${duelsLink(id)}">${duelIcon()}Duels stats <small class="num">${record(d.wins, d.losses)}</small></a>`.value,
  );
}

/** The share card: the profile now, with the rating history once it's loaded. */
function shareCard(p: PlayerPage["player"], crown: TitleName | undefined, h: History | null): PlayerCard {
  const r = p.rating;
  const where = site.label(site.region);
  return {
    kind: "player",
    file: `${p.name}-${site.region}`,
    url: new URL(playerLink(p.id), location.origin).href,
    title: `${p.name} on ${siteName}`,
    text: r?.rating
      ? `${p.name}: ${r.siteTier ? `${r.siteTier.label}, ` : ""}${rating(r.rating)}${r.rank ? `, #${r.rank} in ${where}` : ""} on ${siteName}`
      : `${p.name} on ${siteName}`,
    region: where,
    name: p.name,
    crown: crown ?? null,
    tier: r?.siteTier ?? null,
    rating: r && r.rating > 0 ? r.rating : null,
    rank: r?.rank ?? null,
    rounds: r?.rounds ?? null,
    winRate: r?.rounds ? winRate(r.wins, r.rounds) : null,
    peak: h?.peak && h.peak.rating > 0 ? h.peak.rating : null,
    bestStreak: h?.matches ? h.bestStreak : null,
    form: h ? [...h.form.results].reverse().map((f) => f.position) : [],
    points: h ? h.points.map((point) => point.rating) : [],
  };
}

const compareLink = (ids: number[]): string => `/compare?ids=${ids.join(",")}&${inRegion()}`;

/** How far a ranked player is from the next tier: a bar from their tier's start to the next one's. */
function progress(r: PlayerRating, next: Tier): Html {
  const from = r.siteTier?.threshold ?? 0;
  const share = Math.min(1, Math.max(0, (r.rating - from) / (next.threshold - from)));
  return html`<div class="track"${tierName(r.siteTier) && html` data-tier="${tierName(r.siteTier)}"`}><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    <p><span class="num">${num(next.threshold - r.rating)}</span> to ${tierChip(next)}</p>`;
}

const fact = (label: string, value: Html | string | number): Html => html`<span>${label} <b class="num">${value}</b></span>`;

function figures(r: PlayerRating, e: PlayerPage["eliminations"], tourneyWins: number): Html {
  const figure = (label: string, value: string, tip?: string) =>
    html`<div${tip && html` title="${tip}"`}><dt>${label}</dt><dd class="num">${value}</dd></div>`;
  return html`${figure("Rating", rating(r.rating))}${figure("Rank", r.rank ? num(r.rank) : "–")}${figure(
    "Rated rounds",
    num(r.rounds),
  )}${figure("Rounds won", winRate(r.wins, r.rounds))}${figure(
    "K/D",
    killDeath(e.kills, e.deaths),
    `${count(e.kills, "kill")} on other players, ${count(e.deaths, "death")} by one (falls not counted)`,
  )}${tourneyWins > 0 && figure("Tourney wins", num(tourneyWins))}`;
}

/** One line about the player: inactive, an alt, not on the board yet, rated elsewhere, other names. */
function about(p: PlayerPage["player"]): Html {
  const r = p.rating;
  const here = site.label(site.region);
  const others = p.aliases.filter((a) => a !== p.name);
  // A rating in another region is a separate one: a link to it, not a mix on this page.
  const elsewhere = p.regions
    .filter((id) => id !== site.region)
    .map((id, i) => html`${i ? " and " : ""}<a href="${playerLink(p.id, id)}">${site.label(id)}</a>`);
  const lines = [
    r?.inactiveSince && html`Inactive since ${date(r.inactiveSince)}: still on the leaderboard, but no rank tag in game.`,
    p.alt && html`Alt account: rated as normal, but not on the leaderboard.`,
    r && !r.rank && !p.alt && html`Not on the ${here} leaderboard yet: it takes a few more rated rounds.`,
    !r && html`No rated rounds in ${here}${elsewhere.length ? "" : " yet"}.`,
    elsewhere.length > 0 && html`${r ? "Also rated" : "Rated"} in ${elsewhere}.`,
    others.length > 0 && html`Also played as ${others.join(", ")}.`,
  ].filter((line): line is Html => line instanceof Html);
  return html`${lines.map((line, i) => html`${i ? " " : ""}${line}`)}`;
}

/** A titled player's name, tier and figures in the title's frame, with the title's seal. */
function titleHero(crown: TitleName): void {
  const [name, what] = titleSeals[crown];
  const hero = byId("hero");
  hero.classList.add(titleLooks[crown]);
  hero.insertAdjacentHTML("beforeend", `<span class="fx" aria-hidden="true">${titleFx(crown, "profile")}</span>`);
  byId("tier").insertAdjacentHTML("afterbegin", `${titleChip(crown).value} `);
  const seal = byId("seal");
  render(seal, html`${name}<b>${site.label(site.region)} ${what}</b>`);
  seal.hidden = false;
}

// Head-to-head: who they eliminate most and who eliminates them most, each with a link to compare.
function rivals(p: PlayerPage["player"], eliminated: Rival[], eliminatedBy: Rival[]): void {
  if (!eliminated.length && !eliminatedBy.length) return;
  byId("rivals-section").hidden = false;
  const list = (rivals: Rival[]) =>
    rivals.length
      ? html`${rivals.map(
          (o) => html`<li><a href="${playerLink(o.id)}">${o.name}</a>
            <span class="num">${count(o.kills, "time")}</span>
            <small class="num"${o.rounds > 0 && html` title="Rated rounds they both played"`}>${o.rounds > 0 && html`in ${count(o.rounds, "round")}`}</small>
            <a class="vs" href="${compareLink([p.id, o.id])}" aria-label="Compare ${p.name} and ${o.name}">Compare</a></li>`,
        )}`
      : html`<li class="muted">No one yet.</li>`;
  render(byId("eliminated"), list(eliminated));
  render(byId("eliminated-by"), list(eliminatedBy));
}

/** The rating after a match or duel, and what it changed by. */
function change(m: Pick<PlayerMatch, "ratingAfter" | "ratingBefore">): Html {
  if (m.ratingAfter === null) return html`<span class="muted">Not rated</span>`;
  if (m.ratingBefore === null) return html`${rating(m.ratingAfter)}<gb-chip title="Their first rated match">New</gb-chip>`;
  const d = m.ratingAfter - m.ratingBefore;
  return html`${rating(m.ratingAfter)}${d !== 0 && html`<gb-delta value="${d}"></gb-delta>`}`;
}

/** "Nov 3, 14:05", with the year when it isn't this year's. */
function when(iso: string): string {
  const d = new Date(iso);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: thisYear ? undefined : "numeric", hour: "numeric", minute: "2-digit" });
}

/** A row of the recent list: a match, or a duel among them. */
type Recent = { match: PlayerMatch } | { duel: PlayerDuel };

/** Matches and duels together, newest first. */
function recentRows(matches: PlayerMatch[], duels: PlayerDuel[]): Recent[] {
  const rows: Recent[] = [...matches.map((match) => ({ match })), ...duels.map((duel) => ({ duel }))];
  const of = (r: Recent) => ("match" in r ? r.match : r.duel);
  return rows.sort((a, b) => of(b).playedAt.localeCompare(of(a).playedAt) || of(b).id - of(a).id);
}

// The map only when the list has more than one, and Legacy only when it sets a match apart.
function matchRow(m: PlayerMatch, maps: boolean, mixed: boolean): Html {
  const flags = matchFlags({ ...m, legacy: m.legacy && mixed });
  return html`<li><a href="${matchLink(m.id)}">
    <span class="when">${when(m.playedAt)}</span>
    ${maps && html`<span class="map">${mapName(m.map)} ${flags}</span>`}
    <span class="place">${m.place !== null && html`<b${m.place === 1 && raw(' class="won"')}>${ordinal(m.place)}</b>`}<small class="num">${count(m.roundWins, "round")} won</small>${!maps && flags}</span>
    <span class="change num">${change(m)}</span></a></li>`;
}

/** A duel in the list: its result and score against whom, linking to their duels. */
function duelRow(d: PlayerDuel, playerId: number, maps: boolean): Html {
  return html`<li class="duel"><a href="${duelsLink(playerId)}">
    <span class="when">${when(d.playedAt)}</span>
    ${maps && html`<span class="map"></span>`}
    <span class="place">${duelIcon()}<b${d.won && raw(' class="won"')}>${d.won ? "Won" : "Lost"}</b><small>Duel <span class="num">${d.score}–${d.opponentScore}</span> vs ${d.opponent.name}</small></span>
    <span class="change num">${change(d)}</span></a></li>`;
}

/** The recent list, with the map column only when the matches in it weren't all on one map. */
function recentList(matches: PlayerMatch[], duels: PlayerDuel[], playerId: number): Html {
  const maps = new Set(matches.map((m) => m.map)).size > 1;
  const mixed = new Set(matches.map((m) => m.legacy)).size > 1;
  const rows = recentRows(matches, duels).map((r) => ("match" in r ? matchRow(r.match, maps, mixed) : duelRow(r.duel, playerId, maps)));
  return html`${rows}`;
}

/** "Show more": the next older matches and duels under the list, until there are none. */
function showMore(id: number, matches: PlayerMatch[], duels: PlayerDuel[], nextBefore: number): void {
  const button = byId<GbButton>("more-matches");
  const list = byId("matches");
  let before = nextBefore;
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.busy = true;
    try {
      // The server's cursor: a page may hold no matches at all (only duels).
      const more = await api<PlayerMatches>(`players/${id}/matches?${inRegion()}&before=${before}`);
      matches.push(...more.matches);
      duels.push(...(more.duels ?? []));
      list.classList.toggle("no-map", new Set(matches.map((m) => m.map)).size <= 1);
      render(list, recentList(matches, duels, id));
      button.hidden = more.nextBefore === null;
      if (more.nextBefore !== null) before = more.nextBefore;
      button.textContent = "Show more";
    } catch {
      button.textContent = "Couldn't load more: try again";
    } finally {
      button.busy = false;
    }
  });
}

// Recent form: the last rated rounds, oldest first so they read like the chart, each its place.
function formList(form: History["form"]): Html {
  return html`${[...form.results].reverse().map((f, i) => {
    const won = f.position === 1;
    const what = `${won ? "Won" : `${ordinal(f.position)} of ${f.players}`}, round ${f.round} of match #${f.matchId}`;
    return html`<li style="--i:${i}"><a${won && raw(' class="won"')} href="${matchLink(f.matchId)}" title="${what}"><span class="num" aria-hidden="true">${f.position}</span><span class="sr">${what}</span></a></li>`;
  })}`;
}

/** The points of the last `days` days, or all of them. */
const since = (points: HistoryPoint[], days: number | null): HistoryPoint[] =>
  days === null ? points : points.filter((p) => Date.parse(p.playedAt) >= Date.now() - days * 86_400_000);

/**
 * The chart over 7 days, 30 days or everything, with the first and last match's dates under it. A
 * range with fewer than two matches can't draw a line: its button is off.
 */
function chartRange(chart: GbRatingChart, h: History, playerId: number): void {
  const range = byId<GbSegmented>("range");
  const days = (value: string) => (value === "all" ? null : Number(value));
  const draw = () => {
    const points = since(h.points, days(range.value));
    chart.points = points.map((p) => ({
      rating: p.rating,
      label: `${p.duel ? "Duel" : `Match #${p.matchId}`} · ${date(p.playedAt)}${p.matchId === h.peak?.matchId ? " · Peak" : ""}`,
      href: p.duel ? duelsLink(playerId) : matchLink(p.matchId),
    }));
    const [first, last] = [points[0], points.at(-1)];
    render(byId("graph-dates"), html`${first && html`<span>${date(first.playedAt)}</span>`}${last && last !== first && html`<span>${date(last.playedAt)}</span>`}`);
  };
  for (const option of range.options) if (option instanceof HTMLButtonElement) option.disabled = since(h.points, days(option.value)).length < 2;
  range.value = "all";
  range.addEventListener("change", draw);
  draw();
}

function history(h: History, r: PlayerRating | null, playerId: number): void {
  if (!h.points.length) return;
  byId("history").hidden = false;
  render(
    byId("history-facts"),
    html`${h.peak && fact("Peak", html`${rating(h.peak.rating)}${
      h.peak.siteTier && h.peak.siteTier.label !== r?.siteTier?.label && html` ${tierChip(h.peak.siteTier)}`
    }<small> on ${date(h.peak.playedAt)}</small>`)}${fact(
      "Rated matches",
      num(h.matches),
    )}${h.points.length < h.matches && html`<span class="muted">${num(h.points.length)} of them shown</span>`}`,
  );
  const chart = byId<GbRatingChart>("graph");
  chart.tiers = [r?.siteTier, r?.nextTier].flatMap((t): TierLine[] => {
    const tier = tierName(t);
    return t && tier ? [{ tier, label: t.label, threshold: t.threshold }] : [];
  });
  chartRange(chart, h, playerId);
  const f = h.form;
  render(
    byId("form-facts"),
    f.rounds
      ? html`${fact(`Last ${f.rounds} rated rounds`, `${f.wins} won`)}${fact("Average place", f.averagePosition.toFixed(1))}${
          h.streak > 0 && fact("Win streak", num(h.streak))
        }${fact("Best streak", num(h.bestStreak))}`
      : html``,
  );
  render(byId("form"), formList(f));
}

/** A rating history that didn't load: a button that asks again, until it does. */
function retryHistory(ask: () => Promise<History | null>, show: (h: History) => void): void {
  const button = byId<GbButton>("history-retry");
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.busy = true;
    const h = await ask();
    button.busy = false;
    if (!h) return;
    button.hidden = true;
    show(h);
  });
}

async function playerPage(): Promise<void> {
  const id = encodeURIComponent(idParam());
  // The rating history and the titles are their own requests: the page shows without them if they fail.
  const askHistory = () => api<History>(`players/${id}/history?${inRegion()}`).catch(() => null);
  const historyAnswer = askHistory();
  const titles = api<Titles>(`titles?${inRegion()}`).then(
    (t) => t.titles,
    () => [],
  );
  try {
    const { player: p, matches, duels = [], nextBefore, mostEliminated, mostEliminatedBy, eliminations, tourneyWins } = await api<PlayerPage>(`players/${id}?${inRegion()}`);
    const r = p.rating;
    title(`${p.name} (${site.short(site.region)})`);
    byId("name").textContent = p.name;
    // An alt account: rated, but not on the leaderboard.
    byId("alt").hidden = !p.alt;
    render(byId("tier"), html`${r && tierChip(r.siteTier)}`);
    render(byId("about"), about(p));
    loaded(byId("stats"), r ? figures(r, eliminations, tourneyWins) : html``);
    const next = byId("next-tier");
    if (r?.rank && r.nextTier) render(next, progress(r, r.nextTier));
    else next.hidden = true;
    rivals(p, mostEliminated, mostEliminatedBy);
    const compare = byId<HTMLAnchorElement>("compare-link");
    compare.href = compareLink([p.id]);
    compare.hidden = false;
    const list = byId("matches");
    list.classList.toggle("no-map", new Set(matches.map((m) => m.map)).size <= 1);
    loaded(
      list,
      matches.length || duels.length
        ? recentList(matches, duels, p.id)
        : html`<li><gb-empty>No matches in ${site.label(site.region)} yet.</gb-empty></li>`,
    );
    if (nextBefore != null) showMore(p.id, matches, duels, nextBefore);
    const crown = (await titles).find((t) => t.id === p.id)?.title;
    if (crown) titleHero(crown);
    const headline = byId("headline");
    if (!p.alt) meButton(headline, p.id);
    void duelsButton(headline, p.id);
    attach(headline, shareCard(p, crown, null));
    const showHistory = (h: History) => {
      history(h, r, p.id);
      attach(headline, shareCard(p, crown, h));
    };
    const h = await historyAnswer;
    if (h) showHistory(h);
    else retryHistory(askHistory, showHistory);
  } catch (error) {
    byId("name").textContent = error instanceof NotFound ? "Player not found" : "Player";
    loaded(byId("stats"), html``);
    showError(byId("matches"), error, "player");
  }
}

start("player", playerPage);
