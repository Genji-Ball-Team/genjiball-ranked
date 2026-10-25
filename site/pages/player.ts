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
import { count, date, killDeath, mapName, matchFlags, num, ordinal, rating, tierChip, tierName, title, winRate } from "../lib/format";
import { byId, html, Html, raw, render } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { me, setMe } from "../lib/me";
import { site } from "../lib/site";
import type { History, HistoryPoint, PlayerMatch, PlayerMatches, PlayerPage, PlayerRating, Rival, Tier, Titles, TitleName } from "../lib/types";
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

function figures(r: PlayerRating, e: PlayerPage["eliminations"]): Html {
  const figure = (label: string, value: string, tip?: string) =>
    html`<div${tip && html` title="${tip}"`}><dt>${label}</dt><dd class="num">${value}</dd></div>`;
  return html`${figure("Rating", rating(r.rating))}${figure("Rank", r.rank ? num(r.rank) : "–")}${figure(
    "Rated rounds",
    num(r.rounds),
  )}${figure("Rounds won", winRate(r.wins, r.rounds))}${figure(
    "K/D",
    killDeath(e.kills, e.deaths),
    `${count(e.kills, "kill")} on other players, ${count(e.deaths, "death")} by one (falls not counted)`,
  )}`;
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

/** The rating after a match, and what it changed by. */
function change(m: PlayerMatch): Html {
  if (m.ratingAfter === null) return html`<span class="muted">Not rated</span>`;
  if (m.ratingBefore === null) return html`${rating(m.ratingAfter)}<gb-chip title="Their first rated match">New</gb-chip>`;
  const d = m.ratingAfter - m.ratingBefore;
  return html`${rating(m.ratingAfter)}${d !== 0 && html`<gb-delta value="${d}"></gb-delta>`}`;
}

// Legacy is only worth a chip when it sets a match apart from the others in the list.
function matchRow(m: PlayerMatch, mixed: boolean): Html {
  const d = new Date(m.playedAt);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: thisYear ? undefined : "numeric" });
  const time = d.toLocaleTimeString(undefined, { timeStyle: "short" });
  return html`<li><a href="${matchLink(m.id)}">
    <span class="when">${day}<small>${time}</small></span>
    <span class="map">${mapName(m.map)} ${matchFlags({ ...m, legacy: m.legacy && mixed })}</span>
    <span class="place">${m.place !== null && html`<b${m.place === 1 && raw(' class="won"')}>${ordinal(m.place)}</b>`}<small class="num">${count(m.roundWins, "round")} won</small></span>
    <span class="change num">${change(m)}</span></a></li>`;
}

/** "Show more": the next older matches under the list, until there are none. */
function showMore(id: number, shown: PlayerMatch[]): void {
  const button = byId<GbButton>("more-matches");
  const list = byId("matches");
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.busy = true;
    try {
      const more = await api<PlayerMatches>(`players/${id}/matches?${inRegion()}&before=${shown.at(-1)!.id}`);
      shown.push(...more.matches);
      list.insertAdjacentHTML("beforeend", html`${more.matches.map((m) => matchRow(m, shown.some((o) => o.legacy !== m.legacy)))}`.value);
      button.hidden = !more.hasMore;
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
function chartRange(chart: GbRatingChart, h: History): void {
  const range = byId<GbSegmented>("range");
  const days = (value: string) => (value === "all" ? null : Number(value));
  const draw = () => {
    const points = since(h.points, days(range.value));
    chart.points = points.map((p) => ({
      rating: p.rating,
      label: `Match #${p.matchId} · ${date(p.playedAt)}${p.matchId === h.peak?.matchId ? " · Peak" : ""}`,
      href: matchLink(p.matchId),
    }));
    const [first, last] = [points[0], points.at(-1)];
    render(byId("graph-dates"), html`${first && html`<span>${date(first.playedAt)}</span>`}${last && last !== first && html`<span>${date(last.playedAt)}</span>`}`);
  };
  for (const option of range.options) if (option instanceof HTMLButtonElement) option.disabled = since(h.points, days(option.value)).length < 2;
  range.value = "all";
  range.addEventListener("change", draw);
  draw();
}

function history(h: History, r: PlayerRating | null): void {
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
  chartRange(chart, h);
  const f = h.form;
  render(
    byId("form-facts"),
    f.rounds
      ? html`${fact(`Last ${f.rounds} rated rounds`, `${f.wins} won`)}${fact("Average place", f.averagePosition.toFixed(1))}${fact(
          "Win streak",
          num(h.streak),
        )}${fact("Best streak", num(h.bestStreak))}`
      : html``,
  );
  render(byId("form"), formList(f));
}

async function playerPage(): Promise<void> {
  const id = encodeURIComponent(idParam());
  // The rating history and the titles are their own requests: the page shows without them if they fail.
  const historyAnswer = api<History>(`players/${id}/history?${inRegion()}`).catch(() => null);
  const titles = api<Titles>(`titles?${inRegion()}`).then(
    (t) => t.titles,
    () => [],
  );
  try {
    const { player: p, matches, moreMatches, mostEliminated, mostEliminatedBy, eliminations } = await api<PlayerPage>(`players/${id}?${inRegion()}`);
    const r = p.rating;
    title(`${p.name} (${site.short(site.region)})`);
    byId("name").textContent = p.name;
    // An alt account: rated, but not on the leaderboard.
    byId("alt").hidden = !p.alt;
    render(byId("tier"), html`${r && tierChip(r.siteTier)}`);
    render(byId("about"), about(p));
    render(byId("stats"), r ? figures(r, eliminations) : html``);
    const next = byId("next-tier");
    if (r?.rank && r.nextTier) render(next, progress(r, r.nextTier));
    else next.hidden = true;
    rivals(p, mostEliminated, mostEliminatedBy);
    const compare = byId<HTMLAnchorElement>("compare-link");
    compare.href = compareLink([p.id]);
    compare.hidden = false;
    loaded(
      byId("matches"),
      matches.length
        ? html`${matches.map((m) => matchRow(m, matches.some((o) => o.legacy !== m.legacy)))}`
        : html`<li><gb-empty>No matches in ${site.label(site.region)} yet.</gb-empty></li>`,
    );
    if (moreMatches) showMore(p.id, matches);
    const crown = (await titles).find((t) => t.id === p.id)?.title;
    if (crown) titleHero(crown);
    const headline = byId("headline");
    if (!p.alt) meButton(headline, p.id);
    attach(headline, shareCard(p, crown, null));
    const h = await historyAnswer;
    if (h) {
      history(h, r);
      attach(headline, shareCard(p, crown, h));
    }
  } catch (error) {
    byId("name").textContent = error instanceof NotFound ? "Player not found" : "Player";
    render(byId("stats"), html``);
    showError(byId("matches"), error, "player");
  }
}

start("player", playerPage);
