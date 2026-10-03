// The site's pages (#14, #44). Each page is static HTML that fills itself from the public read API
// (docs/api.md, "Site"). `<body data-page>` says which page this is.
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const dateTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const winRate = (wins, rounds) => (rounds ? `${Math.round((100 * wins) / rounds)}%` : "–");
const idParam = () => new URLSearchParams(location.search).get("id") ?? "";
const siteName = "Genji Ball Ranked";

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
      return `${head}<li><a class="entry${inactive ? " inactive" : ""}" href="/player?id=${p.id}"${p.tier ? ` style="${tierStyle(p.tier)}"` : ""}>
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
      const d = await api(`leaderboard?page=${page}`);
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
  let shown;
  try {
    const d = await api(`leaderboard?page=${page}`);
    shown = () => {
      loaded(box, d.players.length ? ladder(d.players) : '<li class="empty">No one has enough rated rounds for the leaderboard yet.</li>');
      $("prev").hidden = page <= 1;
      $("next").hidden = !d.hasMore;
    };
    $("prev").href = `?page=${page - 1}`;
    $("next").href = `?page=${page + 1}`;
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
      loaded(box, found.length ? ladder(found) : `<li class="empty">No one on the leaderboard is called “${esc(e.target.value.trim())}”.</li>`);
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

async function playerPage() {
  try {
    const { player: p, matches } = await api(`players/${encodeURIComponent(idParam())}`);
    const r = p.rating;
    document.title = `${p.name} – ${siteName}`;
    $("name").textContent = p.name;
    $("tier").innerHTML = r ? chip(r.tier) : "";
    const others = p.aliases.filter((a) => a !== p.name);
    $("about").innerHTML = [
      r?.inactiveSince && `Inactive since ${esc(date(r.inactiveSince))}: still on the leaderboard, but no rank tag in game.`,
      r && !r.rank && "Not on the leaderboard yet: it takes a few more rated rounds.",
      !r && "No rated rounds yet.",
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
        : '<li class="empty">No matches yet.</li>',
    );
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

async function matchPage() {
  try {
    const { match: m } = await api(`matches/${encodeURIComponent(idParam())}`);
    document.title = `Match ${m.id} – ${siteName}`;
    $("name").textContent = `Match ${m.id}`;
    $("flags").innerHTML = matchFlags(m) + (m.complete ? "" : '<span class="chip plain" title="The log ends before the match did">Unfinished</span>');
    $("facts").innerHTML = [dateTime(m.playedAt), mapName(m.map), m.preset && `${m.preset} preset`, `Game version ${m.gameVersion}`]
      .filter(Boolean)
      .map((f) => `<li>${esc(f)}</li>`)
      .join("");

    const players = [...m.players].sort((a, b) => b.wins - a.wins || (b.ratingAfter ?? -1) - (a.ratingAfter ?? -1));
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
            if (place.left) return `<td class="${cls} left" title="Left">L</td>`;
            if (r.winner === p.id) return `<td class="${cls} first" title="Won"><span>1</span></td>`;
            return `<td class="${cls}">${place.position ?? "–"}</td>`;
          })
          .join("");
        return `<tr><td class="name"><a href="/player?id=${p.id}">${esc(p.name)}</a></td>
          <td class="won">${p.wins}</td><td class="delta">${change(p.ratingBefore, p.ratingAfter)}</td>${cells}</tr>`;
      })
      .join("");
    loaded(
      $("result"),
      `<div class="scroll"><table class="grid">
        <thead><tr><th class="name" scope="col">Player</th><th scope="col">Won</th><th class="delta" scope="col">Rating</th>${head}</tr></thead>
        <tbody>${rows}</tbody></table></div>`,
    );
    $("notes").innerHTML = [
      m.rounds.length ? "Each numbered column is a round: where the player finished, or L if they left." : "No rounds.",
      ...m.rounds.map(roundNote),
    ]
      .filter(Boolean)
      .join("<br>");
  } catch (error) {
    $("name").textContent = error.message === "not_found" ? "Match not found" : "Match";
    showError($("result"), error, "match");
  }
}

// Phone chrome: a tab bar at the bottom, in thumb reach, a full-screen search and a back button on
// the inner pages. Hidden by the stylesheet above phone widths, where the header does the same job.
const icons = {
  board: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  find: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
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
    tab("/", "board", "Leaderboard", page === "leaderboard") + tab("/?find", "find", "Find a player", false) + tab("https://discord.gg/sv9VVjh5pT", "discord", "Discord", false);
  document.body.append(bar);
  bar.children[1].addEventListener("click", (e) => {
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
              (p) => `<li><a href="/player?id=${p.id}"${p.tier ? ` style="${tierStyle(p.tier)}"` : ""}>
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
tabBar(page);
backButton();
({ leaderboard: leaderboardPage, player: playerPage, match: matchPage })[page]?.();
