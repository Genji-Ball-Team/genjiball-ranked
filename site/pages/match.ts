// A match's page (match.html): who won, everyone's place, stats and rating change, then every round.
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/delta.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/icon.js";
import "@genji-ball-team/ui/table.js";
import { api, idParam, matchLink, NotFound, playerLink } from "../lib/api";
import { ago, count, date, dateTime, mapName, matchFlags, rating, title } from "../lib/format";
import { byId, html, raw, render, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import type { Match, MatchPlayer, Placement, Round } from "../lib/types";
import { attach, type MatchCard } from "../share";
import { start } from "../shell";

const siteName = "Genji Ball Ranked";

const list = (rounds: Round[]) => rounds.map((r) => r.number).join(", ");

// Short notes under the grid: replayed and stopped rounds, and why a round isn't rated. Stopped rounds
// have no column, so they're only named here.
function roundNotes(all: Round[]): string[] {
  const replayed = all.filter((r) => r.result === "NONE");
  const stopped = all.filter((r) => r.result === "ABORT");
  const unrated = all.filter((r) => r.result === "WIN" && !r.rated && !r.broken);
  return [
    replayed.length && `Replayed after everyone died: ${list(replayed)}.`,
    stopped.length && `Stopped before anyone won: ${list(stopped)}.`,
    unrated.length && `Not rated: ${list(unrated)}.`,
    ...all.filter((r) => r.result === "WIN" && r.broken).map((r) => `Round ${r.number} isn't rated: ${[r.broken].flat().join(", ")}.`),
  ].filter((n): n is string => Boolean(n));
}

/** The rating after the match, and what it changed by. */
function change(p: MatchPlayer): Html {
  if (p.ratingAfter === null) return html`<span class="muted">Not rated</span>`;
  if (p.ratingBefore === null)
    return html`${rating(p.ratingAfter)} <gb-chip title="Their first rated match">New</gb-chip>`;
  const d = p.ratingAfter - p.ratingBefore;
  return html`${rating(p.ratingAfter)}${d !== 0 && html` <gb-delta value="${d}"></gb-delta>`}`;
}

const winners = (players: MatchPlayer[]) => players.filter((p) => p.place === 1 && p.roundWins > 0);

// The recap: the winner, then everyone's overall place and stats. A legacy log has no deflects, so
// those columns are left out rather than shown as zeros. Players who never played a round are only named.
function summary(m: Match, players: MatchPlayer[], idle: MatchPlayer[]): Html {
  const won = winners(players);
  const first = won[0];
  const podium =
    first &&
    html`<div class="podium"><gb-icon name="tourney"></gb-icon><div>
      <span class="label">${won.length > 1 ? "Shared win" : "Winner"}</span>
      <b>${won.map((p, i) => html`${i ? " & " : ""}<a href="${playerLink(p.id)}">${p.name}</a>`)}</b>
      <small>${count(first.roundWins, "round")} won, ${count(first.kills, "kill")}</small></div></div>`;
  const deflects = !m.legacy;
  const th = (label: string, tip: string, extra = false) =>
    html`<th data-sort data-type="number"${extra && raw(' class="extra"')} title="${tip}">${label}</th>`;
  const rows = players.map(
    (p) => html`<tr${p.place === 1 && first && raw(' class="first"')}>
      <td class="num">${p.place}</td>
      <th scope="row" class="name"><a href="${playerLink(p.id)}">${p.name}</a></th>
      <td class="num">${p.roundWins}</td><td class="num">${p.kills}</td>
      ${deflects && html`<td class="num">${p.deflects}</td><td class="num extra">${p.touches}</td>`}
      <td class="num extra">${p.longestStreak}</td>
      <td class="num change" data-value="${p.ratingAfter ?? -1}">${change(p)}</td></tr>`,
  );
  return html`${podium}<gb-table class="standings"><table>
    <thead><tr><th data-sort data-type="number" aria-sort="ascending" title="Overall place">#</th><th data-sort>Player</th>
      ${th("Won", "Rounds won, rated or not")}${th("Kills", "Players they eliminated, not counting themselves")}
      ${deflects && html`${th("Deflects", "Balls they deflected")}${th("Touches", "Deflects, plus times a ball someone sent eliminated them", true)}`}
      ${th("Streak", "Most rounds won in a row", true)}${th("Rating", "Rating after the match, and the change")}</tr></thead>
    <tbody>${rows}</tbody></table></gb-table>
    ${idle.length > 0 && html`<p class="note">Also in the lobby, no rounds played: ${idle.map((p, i) => html`${i ? ", " : ""}<a href="${playerLink(p.id)}">${p.name}</a>`)}.</p>`}`;
}

// A round's kills and deflects for a cell's tooltip, after a ", ". A legacy log has no deflects.
function roundStats(p: Placement): string {
  const parts = [p.kills && count(p.kills, "kill"), p.deflects && count(p.deflects, "deflect")].filter(Boolean);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

/** One player's cell in one round: their place, L if they left, AFK for a host who was away. */
function cell(r: Round, p: MatchPlayer, place: Placement | undefined): Html {
  const unrated = r.rated ? "" : " unrated";
  if (!place) return html`<td class="r${unrated}"></td>`;
  // A tooltip with the mouse; read out after the place with a screen reader.
  const tip = roundStats(place);
  const sr = tip && html`<span class="sr">${tip}</span>`;
  if (place.left) return html`<td class="r left${unrated}" title="Left${tip}">L${sr}</td>`;
  if (place.afk) return html`<td class="r left${unrated}" title="Host AFK: not rated${tip}">AFK${sr}</td>`;
  if (r.winner === p.id) return html`<td class="r won${unrated}" title="Won${tip}"><span>1</span>${sr}</td>`;
  return html`<td class="r${unrated}"${tip && html` title="${tip.slice(2)}"`}>${place.position ?? "–"}${sr}</td>`;
}

function rounds(shown: Round[], players: MatchPlayer[]): Html {
  const places = shown.map((r) => new Map(r.placements.map((p) => [p.playerId, p])));
  const head = shown.map(
    (r) => html`<th class="r${r.rated ? "" : " unrated"}" scope="col"${!r.rated && raw(' title="Not rated"')}>${r.number}</th>`,
  );
  const rows = players.map(
    (p) =>
      html`<tr><th scope="row" class="name"><a href="${playerLink(p.id)}">${p.name}</a></th>${shown.map((r, i) =>
        cell(r, p, places[i]?.get(p.id)),
      )}</tr>`,
  );
  return html`<gb-table class="rounds"><table><thead><tr><th scope="col">Player</th>${head}</tr></thead>
    <tbody>${rows}</tbody></table></gb-table>`;
}

function shareCard(m: Match, players: MatchPlayer[]): MatchCard {
  const won = winners(players);
  const first = won[0];
  const headline = `Match ${m.id}${won.length ? `: ${won.map((p) => p.name).join(" & ")} ${won.length > 1 ? "share the win" : "wins"}` : ""}`;
  return {
    kind: "match",
    file: `match-${m.id}`,
    url: new URL(matchLink(m.id), location.origin).href,
    title: `${headline} on ${siteName}`,
    text: `${headline} on ${siteName}`,
    id: m.id,
    region: site.label(m.region),
    date: date(m.playedAt),
    map: mapName(m.map),
    tourney: m.tourney ? `${m.tourney.name}, ${m.tourney.lobby}` : null,
    rounds: count(m.rounds.length, "round"),
    playerCount: count(players.length, "player"),
    winners: won.map((p) => p.name),
    winnerLine: first ? `${count(first.roundWins, "round")} won · ${count(first.kills, "kill")}` : "",
    rows: players.map((p) => ({ place: p.place, name: p.name, won: p.roundWins, kills: p.kills, before: p.ratingBefore, after: p.ratingAfter })),
  };
}

async function matchPage(): Promise<void> {
  // A match is in one region: the page takes its region, and the switch leads to the other region's board.
  site.own = true;
  site.link = (id) => `/?region=${encodeURIComponent(id)}`;
  try {
    const { match: m } = await api<{ match: Match }>(`matches/${encodeURIComponent(idParam())}`);
    site.use(m.region);
    title(`Match ${m.id} (${site.short(m.region)})`);
    byId("name").textContent = `Match ${m.id}`;
    render(
      byId("flags"),
      html`${matchFlags(m)}${
        !m.complete && html`<gb-chip title="The log ends before the match did">Unfinished</gb-chip>`
      }`,
    );
    const facts = [
      m.tourney && html`<a href="/tourney?id=${m.tourney.id}">${m.tourney.name}</a>, ${m.tourney.lobby}`,
      html`<span data-region-label="${m.region}">${site.label(m.region)}</span>`,
      html`${dateTime(m.playedAt)} <small>${ago(m.playedAt)}</small>`,
      m.map && html`${mapName(m.map)}`,
      m.preset && html`${m.preset} preset`,
      html`Game version ${m.gameVersion}`,
    ];
    render(byId("facts"), html`${facts.map((f) => f && html`<li>${f}</li>`)}`);

    // Overall place first, as the API ranks them; the same place by rating. Anyone without a place in
    // any round only joined the lobby.
    const sorted = [...m.players].sort((a, b) => a.place - b.place || (b.ratingAfter ?? -1) - (a.ratingAfter ?? -1));
    const inRound = new Set(m.rounds.flatMap((r) => r.placements.map((p) => p.playerId)));
    const players = sorted.filter((p) => inRound.has(p.id));
    const idle = sorted.filter((p) => !inRound.has(p.id));
    loaded(byId("summary"), m.rounds.length ? summary(m, players, idle) : html`<gb-empty>No rounds in this match.</gb-empty>`);
    attach(byId("headline"), shareCard(m, players));
    const shown = m.rounds.filter((r) => r.result !== "ABORT");
    if (!shown.length) {
      byId("rounds-section").hidden = true;
      return;
    }
    loaded(byId("result"), rounds(shown, players));
    render(byId("notes"), html`${roundNotes(m.rounds).map((n, i) => html`${i ? raw("<br>") : ""}${n}`)}`);
  } catch (error) {
    byId("name").textContent = error instanceof NotFound ? "Match not found" : "Match";
    byId("rounds-section").hidden = true;
    showError(byId("summary"), error, "match");
  }
}

start("match", matchPage);
