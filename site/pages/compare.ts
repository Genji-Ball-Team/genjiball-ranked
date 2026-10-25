// Compare (compare.html): up to three players side by side in this region: rating, round stats, form,
// their head to head when there are two, and their ratings over time on one chart. The players are in
// the link (`?ids=1,2,3`), so a shared link opens the same view.
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/compare-chart.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/search.js";
import "@genji-ball-team/ui/skeleton.js";
import type { GbCompareChart } from "@genji-ball-team/ui/compare-chart.js";
import type { TierLine } from "@genji-ball-team/ui/rating-chart.js";
import type { GbSearch, SearchItem, SearchQuery } from "@genji-ball-team/ui/search.js";
import { api, inRegion, NotFound, playerLink } from "../lib/api";
import { count, killDeath, plural, rating, tierChip, tierName, title, winRate } from "../lib/format";
import { byId, html, Html, render } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import type { FoundPlayers, History, PlayerPage, Tier } from "../lib/types";
import { attach, type CompareCard } from "../share";
import { start } from "../shell";

const siteName = "Genji Ball Ranked";

/** At most this many players: the chart tells three lines apart by stroke, and a fourth would be one too many. */
const compareMax = 3;

/** `GET /api/players/{id}/stats`: a player's rated rounds in the region, totalled. */
interface Stats {
  rounds: number;
  kills: number;
  deflects: number;
  touches: number;
  /** The rounds whose log has deflects: older game versions have none. */
  deflectRounds: number;
  /** 1 is a win; null with no round. */
  averagePosition: number | null;
}

/** `GET /api/head-to-head?a=&b=`: how two players did in the rounds they shared. */
interface HeadToHead {
  rounds: number;
  /** Rounds the two finished 1st and 2nd: the final 1v1. */
  finals: number;
  a: { ahead: number; kills: number; finalWins: number };
  b: { ahead: number; kills: number; finalWins: number };
}

/** Everything compare shows of one player in this region. */
type Compared = PlayerPage["player"] & Pick<PlayerPage, "eliminations"> & { history: History; stats: Stats };

const compared = new Map<number, Promise<Compared>>();

/** One player's rating and rivals, history and round stats. Kept, so adding them back doesn't ask again. */
function comparedPlayer(id: number): Promise<Compared> {
  let loading = compared.get(id);
  if (!loading) {
    const path = `players/${id}`;
    loading = Promise.all([
      api<PlayerPage>(`${path}?${inRegion()}`),
      api<History>(`${path}/history?${inRegion()}`),
      api<{ stats: Stats }>(`${path}/stats?${inRegion()}`),
    ]).then(([player, history, stats]) => ({ ...player.player, eliminations: player.eliminations, history, stats: stats.stats }));
    // A failed fetch isn't kept, so adding the player again tries again.
    loading.catch(() => compared.delete(id));
    compared.set(id, loading);
  }
  return loading;
}

const compareLink = (ids: number[]): string => `/compare?ids=${ids.join(",")}&${inRegion()}`;

const perRound = (n: number, rounds: number): number | null => (rounds ? n / rounds : null);
const fixed2 = (v: number): string => v.toFixed(2);

/** A row of the table: a label, each player's value (null: none), and which way is better, to mark the best. */
interface Row {
  label: string;
  tip?: string;
  value: (p: Compared) => number | null;
  show?: (v: number, p: Compared) => string;
  better?: 1 | -1;
}

const rows: Row[] = [
  { label: "Rating", value: (p) => p.rating?.rating ?? null, show: rating, better: 1 },
  { label: "Rank", value: (p) => p.rating?.rank ?? null, better: -1 },
  { label: "Rated rounds", value: (p) => p.rating?.rounds ?? null },
  {
    label: "Rounds won",
    value: (p) => (p.rating?.rounds ? p.rating.wins / p.rating.rounds : null),
    show: (v) => `${Math.round(v * 100)}%`,
    better: 1,
  },
  {
    label: "Average place",
    tip: "Where they finish a rated round on average: 1 is a win",
    value: (p) => p.stats.averagePosition,
    show: fixed2,
    better: -1,
  },
  {
    label: "Kills a round",
    tip: "Players they eliminate in a rated round",
    value: (p) => perRound(p.stats.kills, p.stats.rounds),
    show: fixed2,
    better: 1,
  },
  {
    label: "K/D",
    tip: "Kills on other players a death by one (falls not counted)",
    value: (p) => (p.eliminations.kills || p.eliminations.deaths ? p.eliminations.kills / Math.max(1, p.eliminations.deaths) : null),
    show: (_, p) => killDeath(p.eliminations.kills, p.eliminations.deaths),
    better: 1,
  },
  {
    label: "Deflects a round",
    tip: "Balls they deflect in a rated round (not counted in older game versions)",
    value: (p) => perRound(p.stats.deflects, p.stats.deflectRounds),
    show: fixed2,
    better: 1,
  },
  {
    label: "Touches a round",
    tip: "Deflects, plus times a ball someone sent eliminated them",
    value: (p) => perRound(p.stats.touches, p.stats.deflectRounds),
    show: fixed2,
    better: 1,
  },
  { label: "Peak rating", value: (p) => p.history.peak?.rating ?? null, show: rating, better: 1 },
  {
    label: "Best win streak",
    tip: "Most rated rounds won in a row",
    value: (p) => (p.history.matches ? p.history.bestStreak : null),
    better: 1,
  },
  {
    label: "Recent form",
    tip: "Rated rounds won of their last ones",
    value: (p) => (p.history.form.rounds ? p.history.form.wins / p.history.form.rounds : null),
    show: (_, p) => `${p.history.form.wins} of ${p.history.form.rounds}`,
    better: 1,
  },
];

function compareTable(players: Compared[]): Html {
  const head = players.map(
    (p) => html`<th scope="col"><span class="who"><a href="${playerLink(p.id)}">${p.name}</a>
      <button type="button" class="remove" data-id="${p.id}" aria-label="Remove ${p.name}">×</button></span>
      ${tierChip(p.rating?.siteTier)}</th>`,
  );
  const body = rows.map((row) => {
    const values = players.map((p) => row.value(p));
    const known = values.filter((v): v is number => v !== null);
    const best = row.better && known.length > 1 ? (row.better > 0 ? Math.max(...known) : Math.min(...known)) : null;
    const cells = values.map(
      (v, i) =>
        html`<td class="num${v !== null && v === best ? " best" : ""}">${
          v === null ? html`<span class="muted">–</span>` : (row.show ?? String)(v, players[i] as Compared)
        }</td>`,
    );
    return html`<tr><th scope="row"${row.tip && html` title="${row.tip}"`}>${row.label}</th>${cells}</tr>`;
  });
  return html`<div class="scroll"><table class="versus"><thead><tr><td></td>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="note">Stats are over rated rounds in ${site.label(site.region)}, void matches left out. The best of each row is bright.</p>`;
}

/** One tug-of-war bar: each side's count, and a bar split by their share. */
function tug(a: Compared, b: Compared, label: string, x: number, y: number, what: string): Html {
  const total = x + y;
  const share = total ? (100 * x) / total : 50;
  return html`<div class="tug"><p><b class="num">${x}</b><span>${label}</span><b class="num">${y}</b></p>
    <div class="split" role="img" aria-label="${`${a.name} ${x}, ${b.name} ${y} ${what}`}"><span style="width:${share.toFixed(1)}%"></span></div></div>`;
}

/**
 * Two players' record against each other: rounds one finished above the other, and kills. `current()`
 * says whether these are still the players shown: a slow answer for an earlier pair is dropped.
 */
async function headToHead(a: Compared, b: Compared, current: () => boolean): Promise<void> {
  const box = byId("h2h");
  byId("h2h-section").hidden = false;
  box.innerHTML = "";
  try {
    const d = await api<HeadToHead>(`head-to-head?a=${a.id}&b=${b.id}&${inRegion()}`);
    if (!current()) return;
    if (!d.rounds && !d.a.kills && !d.b.kills) {
      render(box, html`<gb-empty>${a.name} and ${b.name} haven't met in a rated round in ${site.label(site.region)} yet.</gb-empty>`);
      return;
    }
    render(
      box,
      html`<p class="facts"><span>${a.name} <span class="muted">vs</span> ${b.name}</span><span>${count(d.rounds, "rated round")} together</span></p>
        ${tug(a, b, "Finished ahead", d.a.ahead, d.b.ahead, "rounds finished ahead of the other")}
        ${d.finals > 0 && tug(a, b, `Final 1v1s (${d.finals})`, d.a.finalWins, d.b.finalWins, "final 1v1s won against the other")}
        ${tug(a, b, "Eliminated the other", d.a.kills, d.b.kills, "times eliminated the other")}`,
    );
  } catch (error) {
    if (current()) showError(box, error, "head-to-head record");
  }
}

/** The share card: the players' figures side by side, with their rating histories. */
function shareCard(players: Compared[]): CompareCard {
  const names = players.map((p) => p.name);
  const where = site.label(site.region);
  return {
    kind: "compare",
    file: names.join("-vs-"),
    url: new URL(compareLink(players.map((p) => p.id)), location.origin).href,
    title: `${names.join(" vs ")} on ${siteName}`,
    text: `${names.join(" vs ")} in ${where} on ${siteName}`,
    region: where,
    players: players.map((p) => ({
      name: p.name,
      tier: p.rating?.siteTier ?? null,
      rating: p.rating && p.rating.rating > 0 ? p.rating.rating : null,
      rank: p.rating?.rank ?? null,
      winRate: p.rating?.rounds ? winRate(p.rating.wins, p.rating.rounds) : null,
      winShare: p.rating?.rounds ? p.rating.wins / p.rating.rounds : null,
      killsPerRound: perRound(p.stats.kills, p.stats.rounds),
      peak: p.history.peak && p.history.peak.rating > 0 ? p.history.peak.rating : null,
      points: p.history.points.map((point) => ({ rating: point.rating, t: Date.parse(point.playedAt) })),
    })),
  };
}

/** The rating chart: every player with a rated match, where they were played. */
function ratingChart(players: Compared[]): void {
  const shown = players.filter((p) => p.history.points.length);
  byId("graph-section").hidden = !shown.length;
  if (!shown.length) return;
  const chart = byId<GbCompareChart>("graph");
  const tiers = new Map<string, TierLine>();
  for (const t of shown.flatMap((p): (Tier | null | undefined)[] => [p.rating?.siteTier, p.rating?.nextTier])) {
    const tier = tierName(t);
    if (t && tier) tiers.set(tier, { tier, label: t.label, threshold: t.threshold });
  }
  chart.tiers = [...tiers.values()];
  chart.series = shown.map((p) => ({
    name: p.name,
    points: p.history.points.map((point) => ({
      rating: point.rating,
      at: point.playedAt,
      label: `Match #${point.matchId}`,
      href: `/match?id=${point.matchId}`,
    })),
  }));
  chart.setAttribute(
    "label",
    `Ratings over time: ${shown.map((p) => `${p.name} from ${rating(p.history.points[0]?.rating)} to ${rating(p.history.points.at(-1)?.rating)}`).join("; ")}.`,
  );
}

async function comparePage(): Promise<void> {
  const params = new URLSearchParams(location.search);
  let ids = [...new Set((params.get("ids") ?? "").split(",").filter((s) => /^[1-9]\d{0,15}$/.test(s)))]
    .slice(0, compareMax)
    .map(Number);
  const table = byId("table");
  const search = byId<GbSearch>("add");
  const headline = byId("headline");

  /** Puts the players in the address, so the link keeps them. */
  const keep = (): void => {
    const url = new URL(location.href);
    if (ids.length) url.searchParams.set("ids", ids.join(","));
    else url.searchParams.delete("ids");
    history.replaceState(history.state, "", url);
  };

  let shown = 0;
  async function draw(): Promise<void> {
    const run = ++shown;
    keep();
    search.toggleAttribute("disabled", ids.length >= compareMax);
    search.setAttribute(
      "placeholder",
      ids.length >= compareMax ? `${compareMax} players at most` : ids.length ? "Add another player" : "Add a player",
    );
    byId("h2h-section").hidden = true;
    byId("graph-section").hidden = true;
    if (!ids.length) {
      title("Compare");
      byId("heading").textContent = "Compare";
      attach(headline, null);
      loaded(table, html`<gb-empty>Add a player to start, then one or two more to compare them with.</gb-empty>`);
      return;
    }
    table.setAttribute("aria-busy", "true");
    const results = await Promise.allSettled(ids.map(comparedPlayer));
    if (run !== shown) return; // changed meanwhile
    const failed = results.find((r) => r.status === "rejected" && !(r.reason instanceof NotFound));
    if (failed) return showError(table, new Error("failed"), "comparison");
    const missing = ids.filter((_, i) => results[i]?.status === "rejected");
    ids = ids.filter((id) => !missing.includes(id));
    keep();
    const players = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const names = players.map((p) => p.name);
    title(`${names.join(" vs ")} (${site.short(site.region)})`);
    byId("heading").textContent = players.length > 1 ? names.join(" vs ") : "Compare";
    loaded(
      table,
      players.length
        ? html`${missing.length > 0 && html`<p class="note">${count(missing.length, "player")} in the link no longer ${plural(missing.length, "exists", "exist")}.</p>`}${compareTable(players)}${
            players.length === 1 && html`<p class="note">Add another player to compare them with.</p>`
          }`
        : html`<gb-empty>${count(missing.length, "player")} in the link no longer ${plural(missing.length, "exists", "exist")}. Add another.</gb-empty>`,
    );
    const [first, second] = players;
    if (first && second && players.length === 2) void headToHead(first, second, () => run === shown);
    if (players.length) {
      attach(headline, shareCard(players));
      ratingChart(players);
    } else attach(headline, null);
  }

  table.addEventListener("click", (e) => {
    const remove = (e.target as Element).closest<HTMLElement>(".remove");
    if (!remove) return;
    ids = ids.filter((id) => id !== Number(remove.dataset["id"]));
    void draw();
    search.focus();
  });

  // The name search, leaving out the players already shown. The ids of the last answer's rows, by name.
  let found = new Map<string, number>();
  search.addEventListener("query", (event) => {
    const { query, signal, answer, fail } = (event as CustomEvent<SearchQuery>).detail;
    api<FoundPlayers>(`players?search=${encodeURIComponent(query)}&${inRegion()}`, { signal })
      .then((result) => {
        const rest = result.players.filter((p) => !ids.includes(p.id));
        found = new Map(rest.map((p) => [p.name, p.id]));
        answer(
          rest.map(
            (p): SearchItem => ({
              name: p.name,
              tier: tierName(p.tier),
              note: p.matchedAlias ? `was ${p.matchedAlias}` : undefined,
              detail: rating(p.rating),
            }),
          ),
        );
      })
      .catch(() => {
        if (!signal.aborted) fail();
      });
  });
  search.addEventListener("pick", (event) => {
    const id = found.get((event as CustomEvent<SearchItem>).detail.name);
    if (id === undefined || ids.length >= compareMax) return;
    ids = [...ids, id];
    search.value = "";
    void draw();
  });

  await draw();
}

start("compare", comparePage);
