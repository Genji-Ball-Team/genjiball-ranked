// The site's pages (#14). Each page is static HTML that fills itself from the public read API
// (docs/api.md, "Site"). `<body data-page>` says which page this is.
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const dateTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const winRate = (wins, rounds) => (rounds ? `${Math.round((100 * wins) / rounds)}%` : "–");
const idParam = () => new URLSearchParams(location.search).get("id") ?? "";

async function api(path) {
  const res = await fetch(`/api/${path}`);
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function tierBadge(tier) {
  if (!tier) return "";
  const [r, g, b] = tier.color;
  return `<span class="tier" style="color:rgb(${r},${g},${b})">${esc(tier.label)}</span>`;
}

function inactiveFlag(since) {
  return since ? `<span class="flag">Inactive since ${esc(date(since))}</span>` : "";
}

function change(before, after) {
  if (after === null || after === undefined) return '<span class="muted">not rated</span>';
  if (before === null || before === undefined) return `${after} <span class="muted">(first)</span>`;
  const d = after - before;
  const cls = d > 0 ? "up" : d < 0 ? "down" : "muted";
  return `${after} <span class="${cls}">${d > 0 ? "+" : d === 0 ? "±" : ""}${d}</span>`;
}

function matchFlags(m) {
  return (m.void ? '<span class="flag">Void</span>' : "") + (m.legacy ? '<span class="flag plain">Legacy</span>' : "");
}

function showError(box, error, what) {
  box.innerHTML = `<div class="loading">${error.message === "not_found" ? `No such ${what}.` : `Couldn't load the ${what}. Try again later.`}</div>`;
}

async function leaderboardPage() {
  const box = $("list");
  const page = Number(new URLSearchParams(location.search).get("page")) || 1;
  try {
    const d = await api(`leaderboard?page=${page}`);
    box.innerHTML = d.players.length
      ? d.players
          .map(
            (p) => `<a class="row" href="/player?id=${p.id}">
              <div class="rank">#${p.rank}</div>
              <div class="player">${esc(p.name)}${tierBadge(p.tier)}${inactiveFlag(p.inactiveSince)}</div>
              <div class="rating">${p.rating}</div>
              <div class="muted">${p.rounds}</div>
              <div class="muted">${winRate(p.wins, p.rounds)}</div></a>`,
          )
          .join("")
      : '<div class="loading">No ranked players yet.</div>';
    $("prev").hidden = page <= 1;
    $("prev").href = `?page=${page - 1}`;
    $("next").hidden = !d.hasMore;
    $("next").href = `?page=${page + 1}`;
  } catch (error) {
    showError(box, error, "leaderboard");
  }
}

async function playerPage() {
  try {
    const { player: p, matches } = await api(`players/${encodeURIComponent(idParam())}`);
    document.title = `${p.name} – Genji Ball`;
    $("name").textContent = p.name;
    const r = p.rating;
    $("standing").innerHTML = r ? `${tierBadge(r.tier)}${inactiveFlag(r.inactiveSince)}` : "";
    $("aliases").textContent = p.aliases.length > 1 ? `Also seen as ${p.aliases.filter((a) => a !== p.name).join(", ")}` : "";
    $("stats").innerHTML = r
      ? `<div><b>${r.rating}</b><small>Rating</small></div>
         <div><b>${r.rank ? `#${r.rank}` : "–"}</b><small>${r.rank ? "Rank" : "Not ranked yet"}</small></div>
         <div><b>${r.rounds}</b><small>Rated rounds</small></div>
         <div><b>${winRate(r.wins, r.rounds)}</b><small>Rounds won</small></div>`
      : '<div><b>–</b><small>No rated rounds yet</small></div>';
    $("matches").innerHTML = matches.length
      ? matches
          .map(
            (m) => `<a class="row" href="/match?id=${m.id}">
              <div>${esc(dateTime(m.playedAt))}${matchFlags(m)}</div>
              <div class="muted">${esc(m.map ?? "")}</div>
              <div>${change(m.ratingBefore, m.ratingAfter)}</div>
              <div class="muted">#${m.id}</div></a>`,
          )
          .join("")
      : '<div class="loading">No matches yet.</div>';
  } catch (error) {
    $("name").textContent = "Player";
    showError($("matches"), error, "player");
  }
}

async function matchPage() {
  try {
    const { match: m } = await api(`matches/${encodeURIComponent(idParam())}`);
    document.title = `Match #${m.id} – Genji Ball`;
    $("name").textContent = `Match #${m.id}`;
    $("flags").innerHTML = matchFlags(m) + (m.complete ? "" : '<span class="flag plain">Unfinished</span>');
    $("info").textContent = [dateTime(m.playedAt), m.map, m.preset, `v${m.gameVersion}`].filter(Boolean).join(" · ");
    const names = new Map(m.players.map((p) => [p.id, p.name]));
    $("players").innerHTML = m.players
      .map(
        (p) => `<a class="row" href="/player?id=${p.id}">
          <div class="player">${esc(p.name)}</div>
          <div class="muted">${p.wins}</div>
          <div class="muted">${p.rounds}</div>
          <div>${change(p.ratingBefore, p.ratingAfter)}</div></a>`,
      )
      .join("");
    $("rounds").innerHTML = m.rounds.length
      ? m.rounds
          .map((r) => {
            const winner = r.winner === null ? "" : ` · won by <strong>${esc(names.get(r.winner) ?? "?")}</strong>`;
            const note = r.rated ? "" : ` <span class="muted">(not rated${r.broken ? `: ${esc(r.broken)}` : ""})</span>`;
            const list = r.placements
              .map((p) => `<li${p.left ? ' class="left"' : ""}>${esc(p.name ?? "?")}${p.left ? " (left)" : ""}</li>`)
              .join("");
            return `<div class="round"><div>Round ${r.number} · ${esc(r.result)}${winner}${note}</div><ol>${list}</ol></div>`;
          })
          .join("")
      : '<div class="loading">No rounds.</div>';
  } catch (error) {
    $("name").textContent = "Match";
    showError($("rounds"), error, "match");
  }
}

({ leaderboard: leaderboardPage, player: playerPage, match: matchPage })[document.body.dataset.page]?.();
