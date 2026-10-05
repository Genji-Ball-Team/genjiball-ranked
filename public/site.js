// The site's pages (#14, #44). Each page is static HTML that fills itself from the public read API
// (docs/api.md, "Site"). `<body data-page>` says which page this is. Each shows one region's data
// (#48): `site.region`, from region.js.
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const dateTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const winRate = (wins, rounds) => (rounds ? `${Math.round((100 * wins) / rounds)}%` : "–");
const idParam = () => new URLSearchParams(location.search).get("id") ?? "";
const siteName = "Genji Ball Ranked";
const inRegion = (region = site.region) => `region=${encodeURIComponent(region)}`;
// A player page in this page's region: their rating there, also when the link is shared.
const playerLink = (id, region = site.region) => `/player?id=${id}&${inRegion(region)}`;
const title = (what) => (document.title = `${what} – ${siteName}`);
// A region's name, in HTML: region.js fills it in once a first visit has the names.
const regionName = (id) => `<span data-region-label="${esc(id)}">${esc(site.label(id))}</span>`;

// The log's map codes (GenjiBall-CE docs/ranked-log.md, MATCH_START).
const mapNames = { "workshop-island-night": "Workshop Island Night", other: "Another map" };
const mapName = (map) => (map ? (mapNames[map] ?? map) : "");

// The display rating never goes below 0, so 0 means "at the bottom of the scale", not a score.
const rating = (r) => (r > 0 ? String(r) : "–");

async function api(path) {
  const res = await fetch(`/api/${path}`);
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function loaded(box, html) {
  box.innerHTML = html;
  // Fade in over the placeholder rows the first time only, not on every search keystroke.
  if (box.hasAttribute("data-loading")) box.classList.add("appear");
  box.removeAttribute("aria-busy");
  box.removeAttribute("data-loading");
}

function showError(box, error, what) {
  loaded(
    box,
    `<p class="empty">${
      error.message === "not_found"
        ? `There's no ${what} with this link. Find players on the <a href="/">leaderboard</a>.`
        : `The ${what} didn't load. Reload the page to try again.`
    }</p>`,
  );
}

// The tier's colour is the game's tag colour, unchanged. The chip's text is dark or light,
// whichever contrasts more with it, so dark tiers like Champion stay readable.
function tierStyle(tier) {
  const [r, g, b] = tier.color;
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const light = 1.05 / (lum + 0.05) > (lum + 0.05) / 0.0535;
  return `--tier:rgb(${r},${g},${b});--on-tier:${light ? "#fff" : "var(--bg)"}`;
}

const chip = (tier) => (tier ? `<span class="chip" style="${tierStyle(tier)}">${esc(tier.label)}</span>` : "");

function matchFlags(m) {
  return (
    (m.tournament ? '<span class="chip tourney" title="A tourney match: counts more on the leaderboard">Tourney</span> ' : "") +
    (m.void ? '<span class="chip bad" title="Doesn\'t count for ratings">Void</span> ' : "") +
    (m.legacy ? '<span class="chip plain" title="Played on an older game version">Legacy</span> ' : "")
  );
}

// Leaderboard

function ladder(players) {
  let band;
  let floor = false;
  const html = players
    .map((p) => {
      let head = "";
      if (p.tier?.label !== band) {
        band = p.tier?.label;
        head = `<li class="band">${p.tier ? `${chip(p.tier)}<span class="num">${p.tier.threshold}+</span>` : "No tier yet"}</li>`;
      }
      floor ||= p.rating <= 0;
      const inactive = p.inactiveSince ? `Inactive since ${esc(date(p.inactiveSince))}` : "";
      const stats = `${p.rounds} rounds, ${winRate(p.wins, p.rounds)} won`;
      return `${head}<li><a class="entry${inactive ? " inactive" : ""}" href="${playerLink(p.id)}"${p.tier ? ` style="${tierStyle(p.tier)}"` : ""}>
        <span class="pos num">${p.rank}</span>
        <span class="who"><b>${esc(p.name)}</b>${inactive ? `<small>${inactive}</small>` : ""}<small class="stats">${stats}</small></span>
        <span class="rating num${p.rating > 0 ? "" : " floor"}">${rating(p.rating)}</span>
        <span class="num muted">${p.rounds}</span>
        <span class="num muted">${winRate(p.wins, p.rounds)}</span></a></li>`;
    })
    .join("");
  $("floor-note").hidden = !floor;
  return html;
}

// Every leaderboard page, fetched once, for finding a player who isn't on the current page. A
// failed fetch isn't kept, so the next search tries again.
let everyone;
async function allPlayers() {
  everyone ??= (async () => {
    const players = [];
    for (let page = 1; ; page++) {
      const d = await api(`leaderboard?${inRegion()}&page=${page}`);
      players.push(...d.players);
      if (!d.hasMore) return players;
    }
  })().catch((error) => {
    everyone = undefined;
    throw error;
  });
  return everyone;
}

async function leaderboardPage() {
  const box = $("list");
  const page = Number(new URLSearchParams(location.search).get("page")) || 1;
  const short = site.short(site.region);
  title(`${short} leaderboard`);
  $("heading").textContent = `${short} leaderboard`;
  $("region-name").innerHTML = regionName(site.region);
  let shown;
  try {
    const d = await api(`leaderboard?${inRegion()}&page=${page}`);
    shown = () => {
      loaded(box, d.players.length ? ladder(d.players) : '<li class="empty">No one has enough rated rounds for the leaderboard yet.</li>');
      $("prev").hidden = page <= 1;
      $("next").hidden = !d.hasMore;
    };
    $("prev").href = `?${inRegion()}&page=${page - 1}`;
    $("next").href = `?${inRegion()}&page=${page + 1}`;
    shown();
  } catch (error) {
    showError(box, error, "leaderboard");
  }

  $("find").addEventListener("input", async (e) => {
    const query = e.target.value.trim().toLowerCase();
    if (!query) return shown?.();
    try {
      const found = (await allPlayers()).filter((p) => p.name.toLowerCase().includes(query));
      if (e.target.value.trim().toLowerCase() !== query) return; // typed on meanwhile
      $("prev").hidden = $("next").hidden = true;
      loaded(box, found.length ? ladder(found) : `<li class="empty">No one on the ${esc(short)} leaderboard is called “${esc(e.target.value.trim())}”.</li>`);
    } catch (error) {
      showError(box, error, "leaderboard");
    }
  });
}

// Player

function change(before, after) {
  if (after === null || after === undefined) return '<span class="muted">Not rated</span>';
  if (before === null || before === undefined) return `${rating(after)}<span class="muted">first</span>`;
  const d = after - before;
  if (d === 0) return `<span class="${after > 0 ? "" : "muted"}">${rating(after)}</span>`;
  return `${rating(after)}<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "+" : "−"}${Math.abs(d)}</span>`;
}

// How far a ranked player is from the next tier: a bar from their tier's start to the next one's.
function progress(r) {
  const from = r.tier?.threshold ?? 0;
  const to = r.nextTier.threshold;
  const share = Math.min(1, Math.max(0, (r.rating - from) / (to - from)));
  return `<div class="track" style="${r.tier ? tierStyle(r.tier) : ""}"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    <p><span class="num">${to - r.rating}</span> to ${chip(r.nextTier)}</p>`;
}

const ordinal = (n) => {
  const rules = new Intl.PluralRules("en", { type: "ordinal" });
  return `${n}${{ one: "st", two: "nd", few: "rd" }[rules.select(n)] ?? "th"}`;
};

// The rating graph (#17): the display rating after each match, in play order, one point a match.
// The tier lines are the player's own tier and the next one, when the graph reaches them. Hover or
// touch shows a point; a click opens its match. Drawn at the box's width, again when it changes.
function ratingGraph(box, h, r) {
  const points = h.points;
  const tiers = [r?.tier, r?.nextTier].filter(Boolean);
  const draw = () => {
    const width = box.clientWidth;
    const height = width < 480 ? 180 : 240;
    const pad = { top: 18, right: 12, bottom: 26, left: 40 };
    const ratings = points.map((p) => p.rating);
    let lo = Math.min(...ratings);
    let hi = Math.max(...ratings);
    for (const t of tiers) if (t.threshold >= lo - 50 && t.threshold <= hi + 50) [lo, hi] = [Math.min(lo, t.threshold), Math.max(hi, t.threshold)];
    const span = Math.max(hi - lo, 40);
    lo = Math.max(0, lo - span * 0.08);
    hi += span * 0.08;
    const x = (i) => pad.left + (points.length > 1 ? (i / (points.length - 1)) * (width - pad.left - pad.right) : (width - pad.left - pad.right) / 2);
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * (height - pad.top - pad.bottom);
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`).join("");
    const area = `${line}L${x(points.length - 1).toFixed(1)},${height - pad.bottom}L${x(0).toFixed(1)},${height - pad.bottom}Z`;
    // A few round ratings on the left, as faint grid lines.
    const step = [10, 25, 50, 100, 200, 250, 500].find((s) => (hi - lo) / s <= 4) ?? 1000;
    const grid = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      grid.push(`<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.left - 8}" y="${y(v)}" dy=".32em">${v}</text>`);
    }
    const tierLines = tiers
      .filter((t) => t.threshold > lo && t.threshold < hi)
      .map(
        (t) => `<g class="tier-line" style="${tierStyle(t)}"><line x1="${pad.left}" x2="${width - pad.right}" y1="${y(t.threshold)}" y2="${y(t.threshold)}"/>
          <text x="${pad.left + 6}" y="${y(t.threshold)}" dy="-.45em">${esc(t.label)} ${t.threshold}</text></g>`,
      )
      .join("");
    const peak = h.peak && points.findIndex((p) => p.matchId === h.peak.matchId);
    // Both ends on one day: their times say more.
    const sameDay = date(points[0].playedAt) === date(points.at(-1).playedAt);
    const ends = [points[0], points.at(-1)].map((p) => (sameDay ? dateTime : date)(p.playedAt));
    box.innerHTML = `<svg width="${width}" height="${height}" role="img" aria-label="${esc(graphLabel(h))}">
        <defs><linearGradient id="graph-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
        <g class="grid-lines">${grid.join("")}</g>${tierLines}
        <path class="area" d="${area}"/><path class="line" d="${line}"/>
        ${peak >= 0 ? `<circle class="peak" cx="${x(peak)}" cy="${y(h.peak.rating)}" r="4.5"/>` : ""}
        <circle class="last" cx="${x(points.length - 1)}" cy="${y(points.at(-1).rating)}" r="4.5"/>
        <text class="end" x="${pad.left}" y="${height - 6}">${esc(ends[0])}</text>
        <text class="end" x="${width - pad.right}" y="${height - 6}" text-anchor="end">${esc(ends[1])}</text>
        <g class="cursor" hidden><line y1="${pad.top}" y2="${height - pad.bottom}"/><circle r="5"/></g>
      </svg><div class="tip" hidden></div>`;
    const svg = box.querySelector("svg");
    const cursor = svg.querySelector(".cursor");
    const tip = box.querySelector(".tip");
    let at = -1;
    const show = (e) => {
      const px = e.clientX - svg.getBoundingClientRect().left;
      const i = points.length > 1 ? Math.round(((px - pad.left) / (width - pad.left - pad.right)) * (points.length - 1)) : 0;
      at = Math.min(points.length - 1, Math.max(0, i));
      const p = points[at];
      cursor.hidden = tip.hidden = false;
      cursor.querySelector("line").setAttribute("x1", x(at));
      cursor.querySelector("line").setAttribute("x2", x(at));
      cursor.querySelector("circle").setAttribute("cx", x(at));
      cursor.querySelector("circle").setAttribute("cy", y(p.rating));
      const before = at ? points[at - 1].rating : null;
      tip.innerHTML = `<b class="num">${rating(p.rating)}</b>${before === null ? "" : ` <span class="${p.rating >= before ? "up" : "down"}">${p.rating >= before ? "+" : "−"}${Math.abs(p.rating - before)}</span>`}
        <small>${esc(date(p.playedAt))} · Match #${p.matchId}${at === peak ? " · Peak" : ""}</small>`;
      tip.style.left = `${Math.min(Math.max(x(at), 70), width - 70)}px`;
      tip.style.top = `${y(p.rating)}px`;
    };
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", show);
    svg.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") cursor.hidden = tip.hidden = true;
    });
    svg.addEventListener("click", () => {
      if (at >= 0 && matchMedia("(hover: hover)").matches) location.href = `/match?id=${points[at].matchId}`;
    });
  };
  draw();
  let width = box.clientWidth;
  new ResizeObserver(() => {
    if (box.clientWidth !== width) (width = box.clientWidth), draw();
  }).observe(box);
}

// What the graph shows, for screen readers.
function graphLabel(h) {
  const first = h.points[0];
  const last = h.points.at(-1);
  return `Rating over ${count(h.matches, "match", "matches")}, from ${rating(first.rating)} on ${date(first.playedAt)} to ${rating(last.rating)} on ${date(last.playedAt)}${h.peak ? `, peak ${rating(h.peak.rating)} on ${date(h.peak.playedAt)}` : ""}.`;
}

// Recent form (#17): the last rated rounds, oldest first so they read like the graph, each its place.
function formList(form) {
  return [...form.results]
    .reverse()
    .map((f) => {
      const won = f.position === 1;
      const what = `${won ? "Won" : `${ordinal(f.position)} of ${f.players}`}, round ${f.round} of match #${f.matchId}`;
      return `<li><a class="${won ? "won" : ""}" href="/match?id=${f.matchId}" title="${what}"><span class="num">${f.position}</span><span class="sr">${what}</span></a></li>`;
    })
    .join("");
}

function historySection(h, r) {
  if (!h.points.length) return;
  $("history").hidden = false;
  const fact = (label, value) => `<span>${label} <b class="num">${value}</b></span>`;
  $("history-facts").innerHTML = [
    h.peak && fact("Peak", `${rating(h.peak.rating)}<small> on ${esc(date(h.peak.playedAt))}</small>`),
    fact("Rated matches", h.matches),
    h.points.length < h.matches && `<span class="muted">${h.points.length} of them shown</span>`,
  ]
    .filter(Boolean)
    .join("");
  ratingGraph($("graph"), h, r);
  const f = h.form;
  $("form-facts").innerHTML = f.rounds
    ? [
        fact(`Last ${f.rounds} rated rounds`, `${f.wins} won`),
        fact("Average place", f.averagePosition.toFixed(1)),
        fact("Win streak", h.streak),
        fact("Best", h.bestStreak),
      ].join("")
    : "";
  $("form").innerHTML = formList(f);
}

async function playerPage() {
  // The rating history is its own request: the page shows without it if it fails.
  const history = api(`players/${encodeURIComponent(idParam())}/history?${inRegion()}`).catch(() => null);
  try {
    const { player: p, matches } = await api(`players/${encodeURIComponent(idParam())}?${inRegion()}`);
    const r = p.rating;
    const here = regionName(site.region);
    title(`${p.name} (${site.short(site.region)})`);
    $("name").textContent = p.name;
    $("tier").innerHTML = r ? chip(r.tier) : "";
    const others = p.aliases.filter((a) => a !== p.name);
    // A rating in another region is a separate one: a link to it, not a mix on this page.
    const elsewhere = p.regions
      .filter((id) => id !== site.region)
      .map((id) => `<a href="${playerLink(p.id, id)}">${regionName(id)}</a>`)
      .join(" and ");
    $("about").innerHTML = [
      r?.inactiveSince && `Inactive since ${esc(date(r.inactiveSince))}: still on the leaderboard, but no rank tag in game.`,
      r && !r.rank && `Not on the ${here} leaderboard yet: it takes a few more rated rounds.`,
      !r && `No rated rounds in ${here}${elsewhere ? "" : " yet"}.`,
      elsewhere && `${r ? "Also rated" : "Rated"} in ${elsewhere}.`,
      others.length && `Also played as ${others.map(esc).join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" ");
    $("stats").innerHTML = r
      ? `<div><dt>Rating</dt><dd class="num">${rating(r.rating)}</dd></div>
         <div><dt>Rank</dt><dd class="num">${r.rank ?? "–"}</dd></div>
         <div><dt>Rated rounds</dt><dd class="num">${r.rounds}</dd></div>
         <div><dt>Rounds won</dt><dd class="num">${winRate(r.wins, r.rounds)}</dd></div>`
      : "";
    $("next-tier").innerHTML = r?.rank && r.nextTier ? progress(r) : "";
    loaded(
      $("matches"),
      matches.length
        ? matches
            .map((m) => {
              const d = new Date(m.playedAt);
              const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
              const time = d.toLocaleTimeString(undefined, { timeStyle: "short" });
              return `<li><a href="/match?id=${m.id}">
                <span class="when">${esc(day)}<small>${esc(time)}</small></span>
                <span class="map">${esc(mapName(m.map))} ${matchFlags(m)}</span>
                <span class="change num">${change(m.ratingBefore, m.ratingAfter)}</span>
                <span class="id num">#${m.id}</span></a></li>`;
            })
            .join("")
        : `<li class="empty">No matches in ${here} yet.</li>`,
    );
    const h = await history;
    if (h) historySection(h, r);
  } catch (error) {
    $("name").textContent = error.message === "not_found" ? "Player not found" : "Player";
    showError($("matches"), error, "player");
  }
}

// Match

function roundNote(r) {
  if (r.result === "NONE") return `Round ${r.number}: everyone died, so it was replayed.`;
  if (r.result === "ABORT") return `Round ${r.number}: stopped before anyone won.`;
  if (r.broken) return `Round ${r.number} isn't rated: ${esc([].concat(r.broken).join(", "))}.`;
  if (!r.rated) return `Round ${r.number} isn't rated.`;
  return "";
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A round's kills and deflects for a cell's tooltip, after a ", ". A legacy log has no deflects.
function roundStats(p) {
  const parts = [p.kills && count(p.kills, "kill"), p.deflects && count(p.deflects, "deflect")].filter(Boolean);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

// The match's recap (#15): the winner, then everyone's overall place and stats. A legacy log has no
// deflects, so those columns are left out rather than shown as zeros.
function summary(m, players) {
  const won = players.filter((p) => p.place === 1 && p.roundWins > 0);
  const podium = won.length
    ? `<p class="podium">${trophy()}<span><small>${won.length > 1 ? "Shared win" : "Winner"}</small>
        <b>${won.map((p) => `<a href="${playerLink(p.id)}">${esc(p.name)}</a>`).join(" & ")}</b>
        <small>${count(won[0].roundWins, "round")} won, ${count(won[0].kills, "kill")}</small></span></p>`
    : "";
  const deflects = !m.legacy;
  const rows = players
    .map(
      (p) => `<tr${p.place === 1 && won.length ? ' class="first"' : ""}>
        <td class="place num">${p.place}</td>
        <td class="name"><a href="${playerLink(p.id)}">${esc(p.name)}</a></td>
        <td class="num">${p.roundWins}</td><td class="num">${p.kills}</td>
        ${deflects ? `<td class="num">${p.deflects}</td><td class="num extra">${p.touches}</td>` : ""}
        <td class="num extra">${p.longestStreak}</td>
        <td class="delta">${change(p.ratingBefore, p.ratingAfter)}</td></tr>`,
    )
    .join("");
  const th = (label, tip, cls = "") => `<th scope="col"${cls ? ` class="${cls}"` : ""} title="${tip}">${label}</th>`;
  return `${podium}<div class="scroll"><table class="standings">
    <thead><tr><th class="place" scope="col">#</th><th class="name" scope="col">Player</th>
      ${th("Won", "Rounds won, rated or not")}${th("Kills", "Players they eliminated, not counting themselves")}
      ${deflects ? th("Deflects", "Balls they deflected") + th("Touches", "Deflects, plus times a ball someone sent eliminated them", "extra") : ""}
      ${th("Streak", "Most rounds won in a row", "extra")}<th class="delta" scope="col">Rating</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${m.legacy ? '<p class="note">An older game version: its log has no deflects.</p>' : ""}`;
}

// A match or tourney is in one region: the page takes its region, and the switch leads to the other
// region's list.
function ownRegion(list) {
  site.own = true;
  site.link = (id) => `${list}?region=${encodeURIComponent(id)}`;
}

async function matchPage() {
  ownRegion("/");
  try {
    const { match: m } = await api(`matches/${encodeURIComponent(idParam())}`);
    site.use(m.region);
    title(`Match ${m.id} (${site.short(m.region)})`);
    $("name").textContent = `Match ${m.id}`;
    $("flags").innerHTML = matchFlags(m) + (m.complete ? "" : '<span class="chip plain" title="The log ends before the match did">Unfinished</span>');
    $("facts").innerHTML = [
      m.tourney && `<a href="/tourney?id=${m.tourney.id}">${esc(m.tourney.name)}</a>, ${esc(m.tourney.lobby)}`,
      regionName(m.region),
      ...[dateTime(m.playedAt), mapName(m.map), m.preset && `${m.preset} preset`, `Game version ${m.gameVersion}`].filter(Boolean).map(esc),
    ]
      .filter(Boolean)
      .map((f) => `<li>${f}</li>`)
      .join("");

    // Overall place first (#15), as the API ranks them; the same place by rating.
    const players = [...m.players].sort((a, b) => a.place - b.place || (b.ratingAfter ?? -1) - (a.ratingAfter ?? -1));
    loaded($("summary"), m.rounds.length ? summary(m, players) : "");
    const places = m.rounds.map((r) => new Map(r.placements.map((p) => [p.playerId, p])));
    const head = m.rounds
      .map((r) => `<th class="r${r.rated ? "" : " unrated"}" scope="col"${r.rated ? "" : ` title="Not rated"`}>${r.number}</th>`)
      .join("");
    const rows = players
      .map((p) => {
        const cells = m.rounds
          .map((r, i) => {
            const place = places[i].get(p.id);
            const cls = `r${r.rated ? "" : " unrated"}`;
            if (!place) return `<td class="${cls}"></td>`;
            // A tooltip with the mouse; read out after the place with a screen reader.
            const tip = roundStats(place);
            const sr = tip ? `<span class="sr">${tip}</span>` : "";
            if (place.left) return `<td class="${cls} left" title="Left${tip}">L${sr}</td>`;
            if (r.winner === p.id) return `<td class="${cls} first" title="Won${tip}"><span>1</span>${sr}</td>`;
            return `<td class="${cls}"${tip ? ` title="${tip.slice(2)}"` : ""}>${place.position ?? "–"}${sr}</td>`;
          })
          .join("");
        return `<tr><td class="name"><a href="${playerLink(p.id)}">${esc(p.name)}</a></td>${cells}</tr>`;
      })
      .join("");
    loaded(
      $("result"),
      `<div class="scroll"><table class="grid">
        <thead><tr><th class="name" scope="col">Player</th>${head}</tr></thead>
        <tbody>${rows}</tbody></table></div>`,
    );
    $("notes").innerHTML = [
      m.rounds.length ? "Each numbered column is a round: where the player finished, or L if they left. On a computer, hover a place for that round's kills and deflects." : "No rounds.",
      ...m.rounds.map(roundNote),
    ]
      .filter(Boolean)
      .join("<br>");
  } catch (error) {
    $("name").textContent = error.message === "not_found" ? "Match not found" : "Match";
    $("rounds-heading").hidden = $("result").hidden = true;
    showError($("summary"), error, "match");
  }
}

// Tourneys

const statusChip = {
  live: '<span class="chip live">Live</span>',
  cancelled: '<span class="chip bad">Cancelled</span>',
};
const verifiedChip = (verified) =>
  verified
    ? '<span class="chip good" title="An admin checked the screenshot against the standings">Verified</span>'
    : '<span class="chip plain" title="No admin has checked the screenshot against the standings yet">Unverified</span>';
const lobbyCount = (n) => `${n} ${n === 1 ? "lobby" : "lobbies"}`;
const played = (t) => t.lobbies.some((l) => l.standings.length);
const winners = (lobby) => lobby.standings.filter((s) => s.place === 1);

// "in 3 days", "in 5 hours": how far off an upcoming tourney is.
function until(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return "starting now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const hours = ms / 3600000;
  if (hours < 1) return rtf.format(Math.ceil(ms / 60000), "minute");
  if (hours < 36) return rtf.format(Math.round(hours), "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

// The date as a block: weekday and day big, month and time small, in the viewer's time zone.
function dateBlock(iso) {
  const d = new Date(iso);
  const part = (options) => esc(d.toLocaleDateString(undefined, options));
  const year = d.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return `<time class="day" datetime="${esc(iso)}"><small>${part({ weekday: "short" })}</small><b class="num">${part({ day: "numeric" })}</b>
    <small>${part({ month: "short", year })} · ${esc(d.toLocaleTimeString(undefined, { timeStyle: "short" }))}</small></time>`;
}

// A function: `icons` is defined further down.
const trophy = () => `<svg class="cup" viewBox="0 0 24 24" aria-hidden="true">${icons.trophy}</svg>`;

function upcomingItem(t) {
  const lobbies = t.lobbies.length ? `${lobbyCount(t.lobbies.length)}: ${t.lobbies.map((l) => esc(l.label)).join(", ")}` : "";
  return `<li><a href="/tourney?id=${t.id}">
    ${dateBlock(t.startsAt)}
    <span class="what"><b>${esc(t.name)}</b>${t.notes ? `<small>${esc(t.notes)}</small>` : ""}${lobbies ? `<small class="muted">${lobbies}</small>` : ""}</span>
    <span class="side">${t.status === "live" ? statusChip.live : `<span class="soon">${esc(until(t.startsAt))}</span>`}</span></a></li>`;
}

function pastItem(t) {
  const results = t.lobbies
    .filter((l) => l.standings.length)
    .map((l) => {
      const won = winners(l);
      return `<span class="winner">${trophy()}<b>${won.map((s) => esc(s.name)).join(" & ")}</b>
        <small>${t.lobbies.length > 1 ? `${esc(l.label)} · ` : ""}${won[0].wins} won</small></span>`;
    })
    .join("");
  const thumbs = t.lobbies
    .filter((l) => l.screenshot)
    .slice(0, 2)
    .map((l) => `<img src="${esc(l.screenshot)}" alt="" loading="lazy" decoding="async">`)
    .join("");
  const flag = t.status === "cancelled" ? statusChip.cancelled : played(t) ? verifiedChip(t.lobbies.every((l) => l.verified)) : "";
  const none = t.status === "cancelled" ? "Didn't take place." : "No results yet.";
  return `<li><a href="/tourney?id=${t.id}">
    ${dateBlock(t.startsAt)}
    <span class="what"><b>${esc(t.name)}</b>${results || `<small class="muted">${none}</small>`}</span>
    <span class="side">${flag}${thumbs ? `<span class="thumbs">${thumbs}</span>` : ""}</span></a></li>`;
}

async function tourneysPage() {
  const page = Number(new URLSearchParams(location.search).get("page")) || 1;
  const short = site.short(site.region);
  title(`${short} tourneys`);
  $("heading").textContent = `${short} tourneys`;
  try {
    const d = await api(`tourneys?${inRegion()}&page=${page}`);
    if (d.upcoming.length) {
      $("upcoming-section").hidden = false;
      $("upcoming").innerHTML = d.upcoming.map(upcomingItem).join("");
    }
    loaded($("past"), d.past.length ? d.past.map(pastItem).join("") : `<li class="empty">No ${esc(short)} tourney has been played yet.</li>`);
    $("prev").hidden = page <= 1;
    $("next").hidden = !d.hasMore;
    $("prev").href = `?${inRegion()}&page=${page - 1}`;
    $("next").href = `?${inRegion()}&page=${page + 1}`;
  } catch (error) {
    showError($("past"), error, "tourney list");
  }
}

function standingsTable(l) {
  const rows = l.standings
    .map(
      (s) => `<tr${s.place === 1 ? ' class="first"' : ""}>
        <td class="place num">${s.place}</td>
        <td class="name"><a href="${playerLink(s.id)}">${esc(s.name)}</a></td>
        <td class="num">${s.wins}</td><td class="num">${s.kills}</td>
        <td class="num muted">${s.ratingBefore === null ? "–" : rating(s.ratingBefore)}</td>
        <td class="delta">${change(s.ratingBefore, s.ratingAfter)}</td></tr>`,
    )
    .join("");
  return `<div class="scroll"><table class="standings">
    <thead><tr><th class="place" scope="col">#</th><th class="name" scope="col">Player</th><th scope="col">Won</th><th scope="col">Kills</th>
      <th scope="col">Rating in</th><th class="delta" scope="col">Out</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function lobbySection(t, l) {
  const won = winners(l);
  const title = t.lobbies.length > 1 || !l.standings.length ? `<h2>${esc(l.label)}</h2>` : "";
  const flags = l.standings.length ? verifiedChip(l.verified) + (l.void ? ' <span class="chip bad" title="Doesn\'t count for ratings">Void</span>' : "") : "";
  const podium = won.length
    ? `<p class="podium">${trophy()}<span><small>Winner</small><b>${won.map((s) => `<a href="${playerLink(s.id)}">${esc(s.name)}</a>`).join(" & ")}</b>
        <small>${won[0].wins} rounds won, ${won[0].kills} kills</small></span></p>`
    : "";
  const proof = l.screenshot
    ? `<figure class="proof"><button type="button" class="zoom" data-src="${esc(l.screenshot)}" aria-label="Enlarge the screenshot of ${esc(l.label)}">
        <img src="${esc(l.screenshot)}" alt="Final standings of ${esc(l.label)}, as the host saw them" loading="lazy" decoding="async"></button>
        <figcaption>The host's screenshot of the final standings${l.verified ? ", checked by an admin" : ""}. Click to enlarge.</figcaption></figure>`
    : l.screenshotExpired
      ? `<p class="note proof">The screenshot is no longer kept: only the newest ones are.${l.verified ? " An admin checked it against these standings." : ""}</p>`
      : "";
  const missing = t.status === "cancelled" ? "Didn't take place." : t.status === "done" ? "The result isn't in yet." : "Not played yet.";
  const body = l.standings.length
    ? standingsTable(l) + (l.matchId ? `<p class="note"><a href="/match?id=${l.matchId}">Every round of this lobby</a></p>` : "")
    : `<p class="empty">${missing}</p>`;
  const head = title || flags ? `<div class="lobby-head">${title}${flags}</div>` : "";
  return `<section class="lobby">${head}${podium}<div class="lobby-body"><div>${body}</div>${proof}</div></section>`;
}

// A screenshot at full size over the page. A click anywhere or Escape closes it.
let lightbox;
function enlarge(src, alt) {
  if (!lightbox) {
    lightbox = document.createElement("dialog");
    lightbox.className = "lightbox";
    lightbox.innerHTML = '<img alt=""><button type="button" aria-label="Close">×</button>';
    lightbox.addEventListener("click", () => lightbox.close());
    document.body.append(lightbox);
  }
  const img = lightbox.querySelector("img");
  img.src = src;
  img.alt = alt;
  lightbox.showModal();
}

async function tourneyPage() {
  ownRegion("/tourneys");
  try {
    const { tourney: t } = await api(`tourneys/${encodeURIComponent(idParam())}`);
    site.use(t.region);
    title(`${t.name} (${site.short(t.region)})`);
    $("name").textContent = t.name;
    $("flags").innerHTML = statusChip[t.status] ?? "";
    $("facts").innerHTML = [
      esc(dateTime(t.startsAt) + (t.status === "scheduled" ? `, ${until(t.startsAt)}` : "")),
      regionName(t.region),
      t.lobbies.length && esc(lobbyCount(t.lobbies.length)),
    ]
      .filter(Boolean)
      .map((f) => `<li>${f}</li>`)
      .join("");
    $("notes").textContent = t.notes ?? "";
    const upcoming = t.status === "scheduled" || t.status === "live";
    loaded(
      $("lobbies"),
      t.lobbies.length ? t.lobbies.map((l) => lobbySection(t, l)).join("") : `<p class="empty">${upcoming ? "Lobbies are set up closer to the start." : "No lobbies."}</p>`,
    );
    $("lobbies").addEventListener("click", (e) => {
      const zoom = e.target.closest(".zoom");
      if (zoom) enlarge(zoom.dataset.src, zoom.querySelector("img").alt);
    });
  } catch (error) {
    $("name").textContent = error.message === "not_found" ? "Tourney not found" : "Tourney";
    showError($("lobbies"), error, "tourney");
  }
}

// Phone chrome: a tab bar at the bottom, in thumb reach, a full-screen search and a back button on
// the inner pages. Hidden by the stylesheet above phone widths, where the header does the same job.
const icons = {
  board: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  find: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M9.5 17h5v3h-5z"/>',
  // Discord's logo (simpleicons.org).
  discord:
    '<path class="fill" d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.011c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>',
};

function tabBar(page) {
  const tab = (href, icon, label, current) =>
    `<a href="${href}"${current ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg>${label}</a>`;
  const bar = document.createElement("nav");
  bar.className = "tabbar";
  bar.setAttribute("aria-label", "Sections");
  bar.innerHTML =
    tab("/", "board", "Leaderboard", page === "leaderboard") +
    tab("/tourneys", "trophy", "Tourneys", page === "tourneys" || page === "tourney") +
    tab("/?find", "find", "Find a player", false) +
    tab("https://discord.gg/sv9VVjh5pT", "discord", "Discord", false);
  document.body.append(bar);
  bar.children[2].addEventListener("click", (e) => {
    e.preventDefault();
    searchSheet().showModal();
  });
  if (new URLSearchParams(location.search).has("find") && matchMedia("(max-width: 640px)").matches) searchSheet().showModal();
}

// The phone's search: a full-screen sheet over the page, the keyboard up, results as you type.
let sheet;
function searchSheet() {
  if (sheet) return sheet;
  sheet = document.createElement("dialog");
  sheet.className = "sheet";
  sheet.setAttribute("aria-label", "Find a player");
  sheet.innerHTML = `<div class="sheet-bar">
      <input type="search" placeholder="Find a player" aria-label="Player name" autocomplete="off" enterkeyhint="search" autofocus>
      <button type="button">Cancel</button>
    </div>
    <ol class="results"><li class="hint">Type a name to search everyone on the leaderboard.</li></ol>`;
  document.body.append(sheet);
  const [input, cancel] = sheet.querySelectorAll("input, button");
  const results = sheet.querySelector(".results");
  // Slide back down before closing (the stylesheet's `closing` animation), unless motion is reduced.
  const close = () => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return sheet.close();
    sheet.classList.add("closing");
    sheet.addEventListener("animationend", () => (sheet.classList.remove("closing"), sheet.close()), { once: true });
  };
  cancel.addEventListener("click", close);
  sheet.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  sheet.addEventListener("close", () => {
    input.value = "";
    results.innerHTML = '<li class="hint">Type a name to search everyone on the leaderboard.</li>';
  });
  input.addEventListener("input", async () => {
    const query = input.value.trim().toLowerCase();
    if (!query) return void (results.innerHTML = '<li class="hint">Type a name to search everyone on the leaderboard.</li>');
    try {
      const found = (await allPlayers()).filter((p) => p.name.toLowerCase().includes(query));
      if (input.value.trim().toLowerCase() !== query) return; // typed on meanwhile
      results.innerHTML = found.length
        ? found
            .map(
              (p) => `<li><a href="${playerLink(p.id)}"${p.tier ? ` style="${tierStyle(p.tier)}"` : ""}>
                <span class="pos num">${p.rank}</span><b>${esc(p.name)}</b>${chip(p.tier)}<span class="rating num">${rating(p.rating)}</span></a></li>`,
            )
            .join("")
        : `<li class="hint">No one on the leaderboard is called “${esc(input.value.trim())}”.</li>`;
    } catch {
      results.innerHTML = `<li class="hint">The leaderboard didn't load. Try again.</li>`;
    }
  });
  return sheet;
}

function backButton() {
  const head = document.querySelector(".headline");
  if (!head || !document.referrer.startsWith(location.origin) || history.length < 2) return;
  const back = document.createElement("button");
  back.className = "back";
  back.type = "button";
  back.setAttribute("aria-label", "Back");
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/></svg>';
  back.addEventListener("click", () => history.back());
  head.prepend(back);
}

const page = document.body.dataset.page;
if (["leaderboard", "player", "tourneys"].includes(page)) site.pin();
tabBar(page);
backButton();
({ leaderboard: leaderboardPage, player: playerPage, match: matchPage, tourneys: tourneysPage, tourney: tourneyPage })[page]?.();
