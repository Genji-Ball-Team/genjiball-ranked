// Duels (duels.html): the region's 1v1s, newest first, grouped by day: both players, the score and
// what it did to their ratings. With `?player=<id>`, that player's duel stats: their record, score,
// rating from duels, who they beat most and who beat them most, every opponent, and their duels.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/delta.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/search.js";
import "@genji-ball-team/ui/skeleton.js";
import type { GbButton } from "@genji-ball-team/ui/button.js";
import type { GbSearch } from "@genji-ball-team/ui/search.js";
import { api, inRegion, NotFound, playerLink } from "../lib/api";
import { dayOf, timeOf } from "../lib/day";
import { duelsLink, record, signed } from "../lib/duels";
import { count, num, title } from "../lib/format";
import { byId, html, raw, render, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import type { DuelSide, Duels, PlayerDuel, PlayerDuels } from "../lib/types";
import { findPlayers, start } from "../shell";

type Duel = Duels["duels"][number];

/** A rating change, or "not rated" for a duel past the pair's daily limit. */
function delta(s: { ratingBefore: number | null; ratingAfter: number | null }): Html {
  if (s.ratingAfter === null || s.ratingBefore === null) return html`<span class="muted">not rated</span>`;
  return html`${num(s.ratingAfter)} <gb-delta value="${s.ratingAfter - s.ratingBefore}"></gb-delta>`;
}

/** One side of a duel card: the player's name (to their profile) and their new rating. */
function side(s: DuelSide, won: boolean, end: boolean): Html {
  return html`<div class="side${end ? " end" : ""}"><a class="name${won ? " won" : ""}" href="${playerLink(s.id)}">${s.name}</a><span class="change num">${delta(s)}</span></div>`;
}

/** A duel's card: the winner on the left, the score between them. */
function card(d: Duel): Html {
  return html`<li class="duel"><div class="duel-card">${side(d.winner, true, false)}
    <div class="score"><b class="num"><span class="won">${d.winnerScore}</span>–${d.loserScore}</b><small>${timeOf(d.playedAt)}</small></div>
    ${side(d.loser, false, true)}</div></li>`;
}

/** Duels grouped under their day's heading, carrying on from `lastDay` (the day shown last). */
function days(duels: readonly Duel[], lastDay: string | null): Html {
  let day = lastDay;
  return html`${duels.map((d) => {
    const today = dayOf(d.playedAt);
    const headingRow = today !== day && html`<li class="day">${today}</li>`;
    day = today;
    return html`${headingRow}${card(d)}`;
  })}`;
}

async function duelsList(): Promise<void> {
  title(`${site.short(site.region)} duels`);
  const box = byId("duels");
  // A player's duel stats: the search's results lead there.
  const search = byId<GbSearch>("find-duels");
  search.hidden = false;
  findPlayers(search, (id) => duelsLink(id));
  try {
    const d = await api<Duels>(`duels?${inRegion()}`);
    loaded(box, d.duels.length ? days(d.duels, null) : html`<li><gb-empty>No duels in ${site.label(site.region)} yet.</gb-empty></li>`);
    if (!d.hasMore) return;
    const shown = [...d.duels];
    const button = byId<GbButton>("more-duels");
    button.hidden = false;
    button.addEventListener("click", async () => {
      button.busy = true;
      try {
        const more = await api<Duels>(`duels?${inRegion()}&before=${shown.at(-1)!.id}`);
        box.insertAdjacentHTML("beforeend", days(more.duels, dayOf(shown.at(-1)!.playedAt)).value);
        shown.push(...more.duels);
        button.hidden = !more.hasMore;
        button.textContent = "Show more";
      } catch {
        button.textContent = "Couldn't load more: try again";
      } finally {
        button.busy = false;
      }
    });
  } catch (error) {
    showError(box, error, "duels");
  }
}

const fact = (label: string, value: Html | string, className = ""): Html =>
  html`<div><dt>${label}</dt><dd${className && raw(` class="${className}"`)}>${value}</dd></div>`;

/** A player's duel against one opponent, from their side. */
function playerRow(d: PlayerDuel): Html {
  const change = d.ratingAfter === null || d.ratingBefore === null ? html`<span class="muted">not rated</span>` : html`<gb-delta value="${d.ratingAfter - d.ratingBefore}"></gb-delta>`;
  return html`<li class="duel mine"><div class="duel-card">
    <span class="result ${d.won ? "won" : "lost"}">${d.won ? "W" : "L"}</span>
    <span class="vs">vs <a class="name" href="${playerLink(d.opponent.id)}">${d.opponent.name}</a></span>
    <b class="num">${d.score}–${d.opponentScore}</b>
    <span class="when"><small>${dayOf(d.playedAt)}</small></span>
    <span class="change num">${change}</span></div></li>`;
}

/** Who they beat most, or who beat them most. */
function rival(label: string, o: PlayerDuels["beatMost"]): Html {
  if (!o) return html`<div class="rival"><span class="label">${label}</span><b class="muted">–</b></div>`;
  return html`<div class="rival"><span class="label">${label}</span><a class="name" href="${playerLink(o.id)}">${o.name}</a>
    <small>${record(o.wins, o.losses)} · <gb-delta value="${o.change}"></gb-delta></small></div>`;
}

async function playerStats(id: string): Promise<void> {
  const box = byId("duels");
  byId("stats-view").hidden = false;
  byId("about").hidden = false;
  try {
    const s = await api<PlayerDuels>(`players/${encodeURIComponent(id)}/duels?${inRegion()}`);
    title(`${s.player.name}'s duels (${site.short(site.region)})`);
    render(byId("heading"), html`<a href="${playerLink(s.player.id)}">${s.player.name}</a><span class="muted">: duels</span>`);
    render(
      byId("about"),
      html`Their 1v1s in ${site.label(site.region)}. Duels count toward the same rating as lobbies. <a href="${duelsLink()}">All duels</a>`,
    );
    if (!s.duels) {
      byId("stats-view").hidden = true;
      return loaded(box, html`<li><gb-empty>${s.player.name} hasn't played a duel in ${site.label(site.region)} yet.</gb-empty></li>`);
    }
    const played = s.wins + s.losses;
    render(
      byId("duel-figures"),
      html`${fact("Record", record(s.wins, s.losses))}${fact("Win rate", `${Math.round((100 * s.wins) / played)}%`)}${fact(
        "From duels",
        signed(s.ratingChange),
        s.ratingChange > 0 ? "up" : s.ratingChange < 0 ? "down" : "",
      )}${fact("Score", record(s.score, s.opponentScore))}${fact("Best win", s.bestWin ? record(s.bestWin.score, s.bestWin.opponentScore) : "–")}${fact(
        "Streak",
        s.streak ? `${s.streak.won ? "W" : "L"}${s.streak.length}` : "–",
        s.streak?.won ? "up" : s.streak ? "down" : "",
      )}`,
    );
    render(byId("duel-rivals"), html`${rival("Beat most", s.beatMost)}${rival("Beaten by most", s.beatenByMost)}`);
    byId("opponents-section").hidden = !s.opponents.length;
    render(
      byId("opponents"),
      html`<li class="head"><span>Player</span><span>W–L</span><span>Score</span><span>Rating</span></li>${s.opponents.map(
        (o) => html`<li><a class="name" href="${playerLink(o.id)}">${o.name}</a><span class="num">${record(o.wins, o.losses)}</span>
          <span class="num">${record(o.score, o.opponentScore)}</span><span class="num"><gb-delta value="${o.change}"></gb-delta></span></li>`,
      )}`,
    );
    loaded(box, html`${s.recent.map(playerRow)}`);
    if (s.duels > s.recent.length) box.insertAdjacentHTML("afterend", html`<p class="note">${count(s.recent.length, "duel")} of ${num(s.duels)} shown.</p>`.value);
  } catch (error) {
    byId("stats-view").hidden = true;
    if (error instanceof NotFound) byId("heading").textContent = "Player not found";
    showError(box, error, "player");
  }
}

start("duels", () => {
  const player = new URLSearchParams(location.search).get("player");
  return player ? playerStats(player) : duelsList();
});
