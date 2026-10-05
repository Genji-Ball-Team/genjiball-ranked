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

// Motion is skipped for whoever asks for less (the stylesheet does the same).
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function loaded(box, html) {
  box.innerHTML = html;
  // Rise in over the placeholder rows the first time only, not on every search keystroke: the first
  // rows one after another (`--i`, style.css), then the class goes so the next answer just shows.
  if (box.hasAttribute("data-loading")) {
    [...box.children].slice(0, 12).forEach((row, i) => row.style.setProperty("--i", i));
    box.classList.add("appear");
    setTimeout(() => box.classList.remove("appear"), 800);
  }
  box.removeAttribute("aria-busy");
  box.removeAttribute("data-loading");
}

// Numbers that count up to their value when they first show: "1234", "56%", "12 days". Text that
// doesn't start with a number ("–") is left as it is.
function countUp(els) {
  if (calm()) return;
  for (const el of els) {
    const [, digits, rest] = /^(\d+)(.*)$/s.exec(el.textContent) ?? [];
    const to = Number(digits);
    if (!to) continue;
    // Held at its final width while it counts, so what's beside it doesn't move.
    el.style.minWidth = `${el.getBoundingClientRect().width}px`;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 700);
      el.textContent = `${Math.round(to * (1 - (1 - t) ** 3))}${rest}`;
      if (t < 1) requestAnimationFrame(tick);
      else el.style.minWidth = "";
    };
    tick(start);
  }
}

// A name with the part that matches the search marked, as HTML. `query` is lower case.
function highlight(name, query) {
  const lower = name.toLowerCase();
  const at = query ? lower.indexOf(query) : -1;
  // Lower case can change a name's length (rare letters): then nothing is marked.
  if (at < 0 || lower.length !== name.length) return esc(name);
  const end = at + query.length;
  return `${esc(name.slice(0, at))}<mark>${esc(name.slice(at, end))}</mark>${esc(name.slice(end))}`;
}

// "3 days ago": how long ago something was, for beside a date.
function ago(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  }
  return "just now";
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

function ladder(players, query = "") {
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
        <span class="pos num${p.rank <= 3 ? ` high${p.rank === 1 ? " first" : ""}` : ""}">${p.rank}</span>
        <span class="who"><b>${highlight(p.name, query)}</b>${inactive ? `<small>${inactive}</small>` : ""}<small class="stats">${stats}</small></span>
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

  // The search is kept in the URL (`?q=`), so coming back from a player finds the same list.
  const find = $("find");
  const search = async () => {
    const query = find.value.trim().toLowerCase();
    const url = new URL(location.href);
    if (query) url.searchParams.set("q", find.value.trim());
    else url.searchParams.delete("q");
    history.replaceState(history.state, "", url);
    if (!query) return shown?.();
    try {
      const found = (await allPlayers()).filter((p) => p.name.toLowerCase().includes(query));
      if (find.value.trim().toLowerCase() !== query) return; // typed on meanwhile
      $("prev").hidden = $("next").hidden = true;
      loaded(box, found.length ? ladder(found, query) : `<li class="empty">No one on the ${esc(short)} leaderboard is called “${esc(find.value.trim())}”.</li>`);
    } catch (error) {
      showError(box, error, "leaderboard");
    }
  };
  find.addEventListener("input", search);
  // Enter opens the first player found; Escape empties the box.
  find.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && find.value.trim()) box.querySelector("a.entry")?.click();
    if (e.key === "Escape" && find.value) {
      e.preventDefault();
      find.value = "";
      search();
    }
  });
  const q = new URLSearchParams(location.search).get("q");
  if (q) {
    find.value = q;
    await search();
  }
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

// The rating graph (#17): display ratings after each match. One player's is in play order, one
// point a match, in the region's colour, with their peak; compare's (#16) puts each player on one
// time axis in their own colour. `series`: `{ name, points, peak, color }`. The tier lines are
// `tiers` the graph reaches. Hover or touch shows the nearest point of each line; with one player a
// click opens its match. Drawn at the box's width, again when it changes.
function ratingGraph(box, { series, tiers = [], byTime = false, label }) {
  const one = series.length === 1;
  // The line draws itself in the first time only, not when a resize draws it again.
  let intro = true;
  const all = series.flatMap((s) => s.points);
  const draw = () => {
    const width = box.clientWidth;
    const height = width < 480 ? 180 : 240;
    const pad = { top: 18, right: 12, bottom: 26, left: 40 };
    const ratings = all.map((p) => p.rating);
    let lo = Math.min(...ratings);
    let hi = Math.max(...ratings);
    for (const t of tiers) if (t.threshold >= lo - 50 && t.threshold <= hi + 50) [lo, hi] = [Math.min(lo, t.threshold), Math.max(hi, t.threshold)];
    const span = Math.max(hi - lo, 40);
    lo = Math.max(0, lo - span * 0.08);
    hi += span * 0.08;
    const inner = width - pad.left - pad.right;
    // Along the x axis: the point's place in play order, or its time.
    const times = all.map((p) => Date.parse(p.playedAt));
    const [t0, t1] = [Math.min(...times), Math.max(...times)];
    const share = (p, i, s) =>
      byTime ? (t1 > t0 ? (Date.parse(p.playedAt) - t0) / (t1 - t0) : 0.5) : s.points.length > 1 ? i / (s.points.length - 1) : 0.5;
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * (height - pad.top - pad.bottom);
    const lines = series.map((s) => s.points.map((p, i) => ({ ...p, x: pad.left + share(p, i, s) * inner, y: y(p.rating) })));
    // Over time a rating holds until the next match: steps. In play order, a line from point to point.
    const path = (pts) => pts.map((p, i) => (i ? (byTime ? `H${p.x.toFixed(1)}V${p.y.toFixed(1)}` : `L${p.x.toFixed(1)},${p.y.toFixed(1)}`) : `M${p.x.toFixed(1)},${p.y.toFixed(1)}`)).join("");
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
    // Both ends on one day: their times say more.
    const sameDay = date(new Date(t0).toISOString()) === date(new Date(t1).toISOString());
    const ends = [t0, t1].map((t) => (sameDay ? dateTime : date)(new Date(t).toISOString()));
    const marks = lines
      .map((pts, n) => {
        const s = series[n];
        const peak = s.peak ? pts.find((p) => p.matchId === s.peak.matchId) : null;
        const last = pts.at(-1);
        return `<g class="series" style="--series:${s.color}">
          ${one ? `<path class="area" d="${path(pts)}L${last.x.toFixed(1)},${height - pad.bottom}L${pts[0].x.toFixed(1)},${height - pad.bottom}Z"/>` : ""}
          <path class="line" d="${path(pts)}" pathLength="1"/>
          ${one && peak ? `<circle class="peak" cx="${peak.x}" cy="${peak.y}" r="4.5"/>` : ""}
          <circle class="last" cx="${last.x}" cy="${last.y}" r="4.5"/></g>`;
      })
      .join("");
    box.innerHTML = `<svg${intro ? ' class="intro"' : ""} width="${width}" height="${height}" role="img" tabindex="0" aria-label="${esc(`${label} Arrow keys step through the points${one ? ", Enter opens a point's match" : ""}.`)}">
        <defs><linearGradient id="graph-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
        <g class="grid-lines">${grid.join("")}</g>${tierLines}${marks}
        <text class="end" x="${pad.left}" y="${height - 6}">${esc(ends[0])}</text>
        <text class="end" x="${width - pad.right}" y="${height - 6}" text-anchor="end">${esc(ends[1])}</text>
        <g class="cursor" hidden><line y1="${pad.top}" y2="${height - pad.bottom}"/>${series.map((s) => `<circle r="5" style="--series:${s.color}"/>`).join("")}</g>
      </svg><div class="tip" hidden></div><p class="sr" aria-live="polite"></p>`;
    const svg = box.querySelector("svg");
    const cursor = svg.querySelector(".cursor");
    const dots = cursor.querySelectorAll("circle");
    const tip = box.querySelector(".tip");
    const said = box.querySelector("[aria-live]");
    let picked = [];
    // With one player, a mouse click opens the match under the cursor; a tap shows its point first, a
    // second tap on it opens it.
    let open = false;
    const showAt = (px) => {
      // One player: the point nearest the pointer. Over time: each player's rating then, from their
      // last match before the pointer (-1 before their first).
      picked = one
        ? [lines[0].reduce((best, p, i, pts) => (Math.abs(p.x - px) < Math.abs(pts[best].x - px) ? i : best), 0)]
        : lines.map((pts) => pts.findLastIndex((p) => p.x <= px + 0.5));
      const cx = one ? lines[0][picked[0]].x : px;
      // An SVG element has no `hidden` property: the attribute itself.
      cursor.removeAttribute("hidden");
      tip.hidden = false;
      cursor.querySelector("line").setAttribute("x1", cx);
      cursor.querySelector("line").setAttribute("x2", cx);
      lines.forEach((pts, n) => {
        const p = pts[picked[n]];
        dots[n].style.display = p ? "" : "none";
        if (!p) return;
        dots[n].setAttribute("cx", cx);
        dots[n].setAttribute("cy", p.y);
      });
      if (one) {
        const at = picked[0];
        const p = lines[0][at];
        const before = at ? lines[0][at - 1].rating : null;
        tip.className = "tip";
        tip.innerHTML = `<b class="num">${rating(p.rating)}</b>${before === null ? "" : ` <span class="${p.rating >= before ? "up" : "down"}">${p.rating >= before ? "+" : "−"}${Math.abs(p.rating - before)}</span>`}
          <small>${esc(date(p.playedAt))} · Match #${p.matchId}${p.matchId === series[0].peak?.matchId ? " · Peak" : ""}</small>`;
        tip.style.top = `${p.y}px`;
        tip.style.left = `${Math.min(Math.max(cx, tip.offsetWidth / 2), width - tip.offsetWidth / 2)}px`;
      } else {
        // Beside the cursor, at the top, to cover the lines as little as it can.
        tip.className = "tip beside";
        const when = new Date(t0 + ((px - pad.left) / inner) * (t1 - t0)).toISOString();
        tip.innerHTML =
          `<small>${esc(dateTime(when))}</small>` +
          lines
            .map((pts, n) => {
              const p = pts[picked[n]];
              return `<span class="row"><i style="--series:${series[n].color}"></i>${esc(series[n].name)} <b class="num">${p ? rating(p.rating) : "–"}</b></span>`;
            })
            .join("");
        tip.style.top = `${pad.top}px`;
        tip.style.left = `${cx + 12 + tip.offsetWidth > width ? cx - 12 - tip.offsetWidth : cx + 12}px`;
      }
    };
    const show = (e) => showAt(Math.min(Math.max(e.clientX - svg.getBoundingClientRect().left, pad.left), width - pad.right));
    // The keyboard steps through the points, each read out as the tooltip says it.
    const stops = [...new Set(lines.flat().map((p) => p.x))].sort((a, b) => a - b);
    let stop = -1;
    svg.addEventListener("keydown", (e) => {
      const keys = { ArrowLeft: stop - 1, ArrowRight: stop + 1, Home: 0, End: stops.length - 1 };
      if (e.key in keys) {
        e.preventDefault();
        stop = Math.min(stops.length - 1, Math.max(0, stop < 0 ? stops.length - 1 : keys[e.key]));
        showAt(stops[stop]);
        said.textContent = tip.textContent.replace(/\s+/g, " ").trim();
      } else if ((e.key === "Enter" || e.key === " ") && one && stop >= 0) {
        e.preventDefault();
        location.href = `/match?id=${lines[0][picked[0]].matchId}`;
      }
    });
    svg.addEventListener("blur", () => {
      cursor.setAttribute("hidden", "");
      tip.hidden = true;
      stop = -1;
    });
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", (e) => {
      const before = tip.hidden ? -1 : picked[0];
      show(e);
      open = e.pointerType === "mouse" || picked[0] === before;
    });
    svg.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      cursor.setAttribute("hidden", "");
      tip.hidden = true;
    });
    svg.addEventListener("click", () => {
      if (one && open && picked.length) location.href = `/match?id=${lines[0][picked[0]].matchId}`;
    });
  };
  draw();
  intro = false;
  let width = box.clientWidth;
  // Compare draws into the same box again: one observer a box.
  box.observer?.disconnect();
  box.observer = new ResizeObserver(() => {
    if (box.clientWidth !== width) (width = box.clientWidth), draw();
  });
  box.observer.observe(box);
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
    .map((f, i) => {
      const won = f.position === 1;
      const what = `${won ? "Won" : `${ordinal(f.position)} of ${f.players}`}, round ${f.round} of match #${f.matchId}`;
      return `<li style="--i:${i}"><a class="${won ? "won" : ""}" href="/match?id=${f.matchId}" title="${what}"><span class="num">${f.position}</span><span class="sr">${what}</span></a></li>`;
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
  ratingGraph($("graph"), {
    series: [{ name: h.player.name, points: h.points, peak: h.peak, color: "var(--accent)" }],
    tiers: [r?.tier, r?.nextTier].filter(Boolean),
    label: graphLabel(h),
  });
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

const compareLink = (ids) => `/compare?ids=${ids.join(",")}&${inRegion()}`;

// Head-to-head on the player page (#18): who they eliminate most and who eliminates them most, each
// with a link to compare the two.
function rivalsSection(p, eliminated, eliminatedBy) {
  if (!eliminated.length && !eliminatedBy.length) return;
  $("rivals-section").hidden = false;
  const list = (rivals) =>
    rivals.length
      ? rivals
          .map(
            (o) => `<li><a href="${playerLink(o.id)}">${esc(o.name)}</a>
              <span class="num">${count(o.kills, "time")}</span>
              <small>${o.rounds ? `in ${count(o.rounds, "round")} together` : ""}</small>
              <a class="vs" href="${compareLink([p.id, o.id])}" aria-label="Compare ${esc(p.name)} and ${esc(o.name)}">Compare</a></li>`,
          )
          .join("")
      : '<li class="muted">No one yet.</li>';
  $("eliminated").innerHTML = list(eliminated);
  $("eliminated-by").innerHTML = list(eliminatedBy);
}

async function playerPage() {
  // The rating history is its own request: the page shows without it if it fails.
  const history = api(`players/${encodeURIComponent(idParam())}/history?${inRegion()}`).catch(() => null);
  try {
    const { player: p, matches, mostEliminated, mostEliminatedBy } = await api(`players/${encodeURIComponent(idParam())}?${inRegion()}`);
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
    countUp($("stats").querySelectorAll("dd"));
    $("next-tier").innerHTML = r?.rank && r.nextTier ? progress(r) : "";
    rivalsSection(p, mostEliminated, mostEliminatedBy);
    $("compare-link").href = compareLink([p.id]);
    $("compare-link").hidden = false;
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

// Compare (#16)

// At most this many players: the series colours are validated as a set of three (all pairs apart for
// colour blindness on the dark background), and a fourth line would be one too many to tell apart.
const compareMax = 3;
const seriesColors = ["#3987e5", "#d95926", "#199e70"];

// Everything compare shows of one player in this region: rating and rivals, history, round stats.
const compared = new Map();
function comparedPlayer(id) {
  if (!compared.has(id)) {
    const path = `players/${id}`;
    const loading = Promise.all([api(`${path}?${inRegion()}`), api(`${path}/history?${inRegion()}`), api(`${path}/stats?${inRegion()}`)]).then(
      ([player, history, stats]) => ({ ...player.player, history, stats: stats.stats }),
    );
    // A failed fetch isn't kept, so adding the player again tries again.
    loading.catch(() => compared.delete(id));
    compared.set(id, loading);
  }
  return compared.get(id);
}

const perRound = (n, rounds) => (rounds ? n / rounds : null);
const fixed2 = (v) => v.toFixed(2);

// The table's rows: a label, each player's value (`null`: none), and which way is better, to mark the
// best when two or more players have one.
const compareRows = [
  { label: "Rating", value: (p) => p.rating?.rating ?? null, show: rating, better: 1 },
  { label: "Rank", value: (p) => p.rating?.rank ?? null, better: -1 },
  { label: "Rated rounds", value: (p) => p.rating?.rounds ?? null },
  { label: "Rounds won", value: (p) => (p.rating?.rounds ? p.rating.wins / p.rating.rounds : null), show: (v) => `${Math.round(v * 100)}%`, better: 1 },
  { label: "Average place", tip: "Where they finish a rated round on average: 1 is a win", value: (p) => p.stats.averagePosition, show: fixed2, better: -1 },
  { label: "Kills a round", tip: "Players they eliminate in a rated round", value: (p) => perRound(p.stats.kills, p.stats.rounds), show: fixed2, better: 1 },
  { label: "Deflects a round", tip: "Balls they deflect in a rated round (not counted in older game versions)", value: (p) => perRound(p.stats.deflects, p.stats.deflectRounds), show: fixed2, better: 1 },
  { label: "Touches a round", tip: "Deflects, plus times a ball someone sent eliminated them", value: (p) => perRound(p.stats.touches, p.stats.deflectRounds), show: fixed2, better: 1 },
  { label: "Peak rating", value: (p) => p.history.peak?.rating ?? null, show: rating, better: 1 },
  { label: "Best win streak", tip: "Most rated rounds won in a row", value: (p) => (p.history.matches ? p.history.bestStreak : null), better: 1 },
  { label: "Recent form", tip: "Rated rounds won of their last ones", value: (p) => (p.history.form.rounds ? p.history.form.wins / p.history.form.rounds : null), show: (v, p) => `${p.history.form.wins} of ${p.history.form.rounds}`, better: 1 },
];

function compareTable(players) {
  const head = players
    .map(
      (p, i) => `<th scope="col"><span class="key"><i style="--series:${seriesColors[i]}"></i><a href="${playerLink(p.id)}">${esc(p.name)}</a></span>
        ${chip(p.rating?.tier)}<button type="button" class="remove" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></th>`,
    )
    .join("");
  const rows = compareRows
    .map((row) => {
      const values = players.map((p) => (row.value(p) === null ? null : Number(row.value(p))));
      const known = values.filter((v) => v !== null);
      const best = row.better && known.length > 1 ? (row.better > 0 ? Math.max(...known) : Math.min(...known)) : null;
      const cells = values
        .map((v, i) => `<td class="num${v !== null && v === best ? " best" : ""}">${v === null ? '<span class="muted">–</span>' : (row.show ?? String)(v, players[i])}</td>`)
        .join("");
      return `<tr><th scope="row"${row.tip ? ` title="${row.tip}"` : ""}>${row.label}</th>${cells}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table class="versus"><thead><tr><td></td>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Stats are over rated rounds in ${regionName(site.region)}, void matches left out. The best of each row is bright.</p>`;
}

// Two players' record against each other (#18): rounds one finished above the other, and kills.
// `current()` says whether these are still the players shown: a slow answer for an earlier pair is dropped.
async function headToHeadSection(a, b, current) {
  const box = $("h2h");
  $("h2h-section").hidden = false;
  box.innerHTML = "";
  try {
    const d = await api(`head-to-head?a=${a.id}&b=${b.id}&${inRegion()}`);
    if (!current()) return;
    if (!d.rounds && !d.a.kills && !d.b.kills) {
      box.innerHTML = `<p class="empty">${esc(a.name)} and ${esc(b.name)} haven't met in a rated round in ${regionName(site.region)} yet.</p>`;
      return;
    }
    const bar = (label, x, y, what) => {
      const total = x + y;
      const share = total ? (100 * x) / total : 50;
      return `<div class="tug"><p><b class="num">${x}</b><span>${label}</span><b class="num">${y}</b></p>
        <div class="split" role="img" aria-label="${esc(`${a.name} ${x}, ${b.name} ${y} ${what}`)}"><span style="width:${share.toFixed(1)}%;--series:${seriesColors[0]}"></span><span style="--series:${seriesColors[1]}"></span></div></div>`;
    };
    box.innerHTML = `<p class="facts"><span>${esc(a.name)} <span class="muted">vs</span> ${esc(b.name)}</span><span>${count(d.rounds, "rated round")} together</span></p>
      ${bar("Finished ahead", d.a.ahead, d.b.ahead, "rounds finished ahead of the other")}
      ${bar("Eliminated the other", d.a.kills, d.b.kills, "times eliminated the other")}`;
  } catch (error) {
    if (current()) showError(box, error, "head-to-head record");
  }
}

async function comparePage() {
  const params = new URLSearchParams(location.search);
  let ids = [...new Set((params.get("ids") ?? "").split(",").filter((s) => /^[1-9]\d{0,15}$/.test(s)))].slice(0, compareMax).map(Number);
  $("region-name").innerHTML = regionName(site.region);
  const table = $("table");
  const input = $("add");
  const suggest = $("suggest");

  const keep = () => {
    const url = new URL(location.href);
    if (ids.length) url.searchParams.set("ids", ids.join(","));
    else url.searchParams.delete("ids");
    history.replaceState(history.state, "", url);
  };

  let shown = 0;
  async function render() {
    const run = ++shown;
    keep();
    input.disabled = ids.length >= compareMax;
    input.placeholder = ids.length >= compareMax ? `${compareMax} players at most` : ids.length ? "Add another player" : "Add a player";
    $("h2h-section").hidden = $("graph-section").hidden = true;
    if (!ids.length) {
      title("Compare");
      $("heading").textContent = "Compare";
      loaded(table, '<p class="empty">Add a player to start, then one or two more to compare them with.</p>');
      return;
    }
    table.setAttribute("aria-busy", "true");
    const results = await Promise.allSettled(ids.map(comparedPlayer));
    if (run !== shown) return; // changed meanwhile
    const missing = ids.filter((_, i) => results[i].status === "rejected" && results[i].reason.message === "not_found");
    if (results.some((r) => r.status === "rejected" && r.reason.message !== "not_found")) {
      return showError(table, new Error("failed"), "comparison");
    }
    ids = ids.filter((id) => !missing.includes(id));
    keep();
    const players = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const names = players.map((p) => p.name);
    title(`${names.join(" vs ")} (${site.short(site.region)})`);
    $("heading").textContent = players.length > 1 ? names.join(" vs ") : "Compare";
    loaded(
      table,
      (missing.length ? `<p class="note">${count(missing.length, "player")} in the link no longer exist${missing.length === 1 ? "s" : ""}.</p>` : "") +
        compareTable(players) +
        (players.length === 1 ? '<p class="note">Add another player to compare them with.</p>' : ""),
    );
    if (players.length === 2) headToHeadSection(players[0], players[1], () => run === shown);
    const series = players
      .map((p, i) => ({ name: p.name, points: p.history.points, peak: p.history.peak, color: seriesColors[i] }))
      .filter((s) => s.points.length);
    if (series.length) {
      $("graph-section").hidden = false;
      $("key").innerHTML = series.map((s) => `<span><i style="--series:${s.color}"></i>${esc(s.name)}</span>`).join("");
      ratingGraph($("graph"), {
        series,
        byTime: true,
        label: `Ratings over time: ${series.map((s) => `${s.name} from ${rating(s.points[0].rating)} to ${rating(s.points.at(-1).rating)}`).join("; ")}.`,
      });
    }
  }

  table.addEventListener("click", (e) => {
    const remove = e.target.closest(".remove");
    if (!remove) return;
    ids = ids.filter((id) => id !== Number(remove.dataset.id));
    render();
    input.focus();
  });

  // Suggestions from the name search, after a pause in typing ("Free tier" in docs/database.md).
  let timer;
  let asked = "";
  const close = () => {
    suggest.hidden = true;
    input.setAttribute("aria-expanded", "false");
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) return close();
    timer = setTimeout(async () => {
      asked = query;
      try {
        const { players } = await api(`players?search=${encodeURIComponent(query)}&${inRegion()}`);
        if (asked !== query || input.value.trim() !== query) return; // typed on meanwhile
        const found = players.filter((p) => !ids.includes(p.id));
        suggest.innerHTML = found.length
          ? found
              .slice(0, 8)
              .map(
                (p) => `<li><button type="button" data-id="${p.id}"><b>${highlight(p.name, query.toLowerCase())}</b>${p.matchedAlias ? `<small>was ${esc(p.matchedAlias)}</small>` : ""}
                  ${chip(p.tier)}<span class="rating num">${p.rating === null ? "" : rating(p.rating)}</span></button></li>`,
              )
              .join("")
          : `<li class="hint">No one in ${regionName(site.region)} is called “${esc(query)}”.</li>`;
        suggest.hidden = false;
        input.setAttribute("aria-expanded", "true");
      } catch {
        suggest.innerHTML = '<li class="hint">The search didn\'t load. Try again.</li>';
        suggest.hidden = false;
      }
    }, 300);
  });
  suggest.addEventListener("click", (e) => {
    const pick = e.target.closest("button[data-id]");
    if (!pick) return;
    ids = [...ids, Number(pick.dataset.id)].slice(0, compareMax);
    input.value = "";
    close();
    render();
    if (!input.disabled) input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowDown" && !suggest.hidden) {
      e.preventDefault();
      suggest.querySelector("button")?.focus();
    }
  });
  suggest.addEventListener("keydown", (e) => {
    const buttons = [...suggest.querySelectorAll("button")];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown") (e.preventDefault(), buttons[Math.min(i + 1, buttons.length - 1)]?.focus());
    if (e.key === "ArrowUp") (e.preventDefault(), i > 0 ? buttons[i - 1].focus() : input.focus());
    if (e.key === "Escape") (close(), input.focus());
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".picker")) close();
  });

  render();
}

// Records (#19)

const playedOn = (r) => (r.matchId ? `<a href="/match?id=${r.matchId}">${esc(date(r.playedAt))}</a>` : "");

// The records, in the order the page shows them: what it is, the value as shown, and where it was set.
const recordList = [
  { key: "highestRating", label: "Highest rating", show: (r) => rating(r.value), where: (r) => `after the match of ${playedOn(r)}` },
  { key: "winStreak", label: "Longest win streak", show: (r) => r.value, where: () => "rated rounds won in a row" },
  { key: "matchWins", label: "Most rounds won in a match", show: (r) => r.value, where: (r) => playedOn(r) },
  { key: "matchKills", label: "Most kills in a match", show: (r) => r.value, where: (r) => playedOn(r) },
  { key: "roundDeflects", label: "Most deflects in a round", show: (r) => r.value, where: (r) => `round ${r.round}, ${playedOn(r)}` },
  { key: "fastestDeflect", label: "Fastest deflect", show: (r) => Math.round(r.value), where: (r) => `ball speed, round ${r.round}, ${playedOn(r)}` },
  { key: "mostWins", label: "Most rounds won", show: (r) => r.value, where: () => "rated rounds, all time" },
  { key: "mostRounds", label: "Most rounds played", show: (r) => r.value, where: () => "rated rounds, all time" },
];

// Rated rounds a day, as bars, oldest first. Each bar's tooltip has the day's matches and players too.
function activityBars(perDay) {
  const most = Math.max(1, ...perDay.map((d) => d.rounds));
  const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const bars = perDay
    .map((d, i) => {
      const what = `${day(d.date)}: ${count(d.rounds, "rated round")}, ${count(d.matches, "match", "matches")}, ${count(d.players, "player")}`;
      return `<li><span class="bar${d.rounds ? "" : " none"}" role="img" tabindex="0" aria-label="${esc(what)}" style="height:${((100 * d.rounds) / most).toFixed(1)}%;--i:${i}"></span>
        <span class="tip" aria-hidden="true"><b class="num">${d.rounds}</b> rounds<small>${esc(day(d.date))} · ${count(d.matches, "match", "matches")} · ${count(d.players, "player")}</small></span></li>`;
    })
    .join("");
  return `<ol class="days">${bars}</ol>
    <p class="axis" aria-hidden="true"><span>${esc(day(perDay[0].date))}</span><span>Rated rounds a day, most ${most}</span><span>Today</span></p>`;
}

async function recordsPage() {
  const short = site.short(site.region);
  title(`${short} records`);
  $("heading").textContent = `${short} records`;
  $("region-name").innerHTML = regionName(site.region);
  try {
    const d = await api(`records?${inRegion()}`);
    $("updated").textContent = d.updatedAt ? `Updated ${dateTime(d.updatedAt)}, about every hour.` : "";
    const set = recordList.filter((r) => d.records[r.key]);
    loaded(
      $("records"),
      set.length
        ? set
            .map(({ key, label, show, where }) => {
              const r = d.records[key];
              return `<li><span class="what">${label}</span><b class="num">${show(r)}</b>
                <span class="who"><a href="${playerLink(r.player.id)}">${esc(r.player.name)}</a><small>${where(r)}</small></span></li>`;
            })
            .join("")
        : `<li class="empty">${d.updatedAt ? `No records in ${regionName(site.region)} yet: they come with the first matches.` : "The records are being counted. Check back in an hour."}</li>`,
    );
    countUp($("records").querySelectorAll("li > b"));
    const a = d.activity;
    if (a.perDay.length) {
      $("activity-section").hidden = false;
      $("activity-figures").innerHTML = `<div><dt>Matches</dt><dd class="num">${a.matches}</dd></div>
        <div><dt>Rated rounds</dt><dd class="num">${a.rounds}</dd></div>
        <div><dt>Players</dt><dd class="num">${a.players}</dd></div>
        <div><dt>Over</dt><dd class="num">${a.days} days</dd></div>`;
      $("activity").innerHTML = activityBars(a.perDay);
      countUp($("activity-figures").querySelectorAll("dd"));
    }
    if (d.topHosts.length) {
      $("hosts-section").hidden = false;
      $("hosts").innerHTML = d.topHosts
        .map((h, i) => `<li><span class="pos num">${i + 1}</span><b>${esc(h.name)}</b><span class="num">${count(h.matches, "match", "matches")}</span></li>`)
        .join("");
    }
  } catch (error) {
    showError($("records"), error, "records");
  }
}

// Live lobbies (#20)

// How often the list asks again: the API's `lobbiesCacheSeconds`, so every ask can be a fresh answer.
const lobbiesRefreshMs = 15000;

// "12 min", "1 h 5 min": how long a lobby has been open.
function openFor(iso) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

async function livePage() {
  const short = site.short(site.region);
  title(`${short} live lobbies`);
  $("heading").textContent = `${short} live lobbies`;
  $("region-name").innerHTML = regionName(site.region);
  const box = $("lobbies");
  let timer;
  // Each ask is numbered: an answer that comes back after a newer ask started is dropped, and only
  // the newest ask sets the next timer, so there's never more than one.
  let asked = 0;
  const refresh = async () => {
    clearTimeout(timer);
    const ask = ++asked;
    try {
      const { lobbies } = await api(`lobbies?${inRegion()}`);
      if (ask !== asked) return;
      // The count in the tab's title, to see from another tab when a lobby opens.
      title(`${lobbies.length ? `(${lobbies.length}) ` : ""}${short} live lobbies`);
      loaded(
        box,
        lobbies.length
          ? lobbies
              .map(
                (l) => `<li><span class="dot" aria-hidden="true"></span>
                  <span class="what"><b>${esc(l.name ?? `${l.hostName}'s lobby`)}</b><small>Hosted by ${esc(l.hostName)}${l.tourney ? " · tourney" : ""}</small></span>
                  <span class="count"><b class="num">${l.players}</b><small>${l.players === 1 ? "player" : "players"}</small></span>
                  <span class="since"><b class="num">${esc(openFor(l.openedAt))}</b><small>open</small></span></li>`,
              )
              .join("")
          : `<li class="empty"><b>No ranked lobby is open in ${regionName(site.region)} right now.</b>
              Ranked lobbies are hosted by community hosts, who run the host tool so their matches are rated. Ask on the
              <a href="https://discord.gg/sv9VVjh5pT">Discord</a> when the next one opens, or how to become a host.</li>`,
      );
      $("checked").textContent = `Checked ${new Date().toLocaleTimeString(undefined, { timeStyle: "short" })}.`;
    } catch (error) {
      if (ask !== asked) return;
      showError(box, error, "lobby list");
    }
    // Only while the page is in view: a background tab doesn't ask.
    if (!document.hidden) timer = setTimeout(refresh, lobbiesRefreshMs);
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
    else clearTimeout(timer);
  });
  refresh();
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
      ...[`${dateTime(m.playedAt)} (${ago(m.playedAt)})`, mapName(m.map), m.preset && `${m.preset} preset`, `Game version ${m.gameVersion}`].filter(Boolean).map(esc),
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
  live: '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  records: '<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  find: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M9.5 17h5v3h-5z"/>',
};

function tabBar(page) {
  const tab = (href, icon, label, current) =>
    `<a href="${href}"${current ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg>${label}</a>`;
  const bar = document.createElement("nav");
  bar.className = "tabbar";
  bar.setAttribute("aria-label", "Sections");
  bar.innerHTML =
    tab("/", "board", "Leaderboard", page === "leaderboard") +
    tab("/live", "live", "Live", page === "live") +
    tab("/records", "records", "Records", page === "records") +
    tab("/tourneys", "trophy", "Tourneys", page === "tourneys" || page === "tourney") +
    tab("/?find", "find", "Find a player", false);
  document.body.append(bar);
  bar.children[4].addEventListener("click", (e) => {
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
    if (calm()) return sheet.close();
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
                <span class="pos num">${p.rank}</span><b>${highlight(p.name, query)}</b>${chip(p.tier)}<span class="rating num">${rating(p.rating)}</span></a></li>`,
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

// "/" puts the cursor in the page's search box, as on most sites with one.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const box = $("find") ?? $("add");
  if (!box || box.disabled || !box.offsetParent) return;
  e.preventDefault();
  box.focus();
  box.select();
});

// A moment's hover on a link to a player or match fetches what that page asks the API for, so it's in
// the browser's cache (`publicCacheSeconds`) and the page fills in at once. A touch fetches straight away.
const warmed = new Set();
let warming;
document.addEventListener("pointerover", (e) => {
  const link = e.target.closest?.('a[href^="/player?"], a[href^="/match?"]');
  if (!link) return;
  clearTimeout(warming);
  warming = setTimeout(
    () => {
      const url = new URL(link.href);
      const id = encodeURIComponent(url.searchParams.get("id") ?? "");
      const region = inRegion(url.searchParams.get("region") ?? site.region);
      const paths = url.pathname === "/player" ? [`players/${id}?${region}`, `players/${id}/history?${region}`] : [`matches/${id}`];
      for (const path of paths) {
        if (warmed.has(path)) continue;
        warmed.add(path);
        fetch(`/api/${path}`, { priority: "low" }).catch(() => warmed.delete(path));
      }
    },
    e.pointerType === "mouse" ? 80 : 0,
  );
});
document.addEventListener("pointerout", (e) => {
  if (e.pointerType === "mouse") clearTimeout(warming);
});

// Back to a page whose lists load after it opens: the browser would restore the scroll before
// they're there, and land at the top. The page puts it back itself once it has loaded.
const scrollKey = () => `scroll:${location.pathname}${location.search}`;
const returning = performance.getEntriesByType("navigation")[0]?.type === "back_forward";
history.scrollRestoration = "manual";
addEventListener("pagehide", () => {
  try {
    sessionStorage.setItem(scrollKey(), String(Math.round(scrollY)));
  } catch {
    // not kept
  }
});
function restoreScroll() {
  if (!returning) return;
  try {
    const y = Number(sessionStorage.getItem(scrollKey()));
    if (y) scrollTo(0, y);
  } catch {
    // not kept
  }
}

const page = document.body.dataset.page;
if (["leaderboard", "player", "compare", "live", "records", "tourneys"].includes(page)) site.pin();
tabBar(page);
backButton();
Promise.resolve(
  ({ leaderboard: leaderboardPage, player: playerPage, compare: comparePage, records: recordsPage, live: livePage, match: matchPage, tourneys: tourneysPage, tourney: tourneyPage })[page]?.(),
).finally(restoreScroll);
