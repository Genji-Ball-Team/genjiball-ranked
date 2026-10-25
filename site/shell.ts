// What every page has around its content: the region switch and banners in the header, the player
// search, and on a phone the tab bar, the full-screen search and a back button. A page's module calls
// `start()` with the function that fills the page in.
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/icon.js";
import "@genji-ball-team/ui/nav.js";
import "@genji-ball-team/ui/panel.js";
import "@genji-ball-team/ui/search.js";
import "@genji-ball-team/ui/segmented.js";
import "@genji-ball-team/ui/skeleton.js";
import type { GbSearch, SearchQuery } from "@genji-ball-team/ui/search.js";
import { api, inRegion, openLobbies, playerLink } from "./lib/api";
import { showBanners } from "./lib/banners";
import { rating, tierName } from "./lib/format";
import { html, raw, render } from "./lib/html";
import { site } from "./lib/site";
import type { FoundPlayers } from "./lib/types";

/** The pages whose region goes in the URL, so a shared link opens the same view. */
const pinned = ["leaderboard", "player", "compare", "matches", "live", "records", "tourneys"];

// The region switch next to the wordmark: links to this page in each region, once the regions are
// known (straight away after a first visit).
function drawRegions(): void {
  // The region in the text, by name and never by colour: `data-region-label` for its name ("Europe")
  // and `data-region-short` for its grey chip ("EU"), this page's region unless the attribute names one.
  for (const el of document.querySelectorAll<HTMLElement>("[data-region-label]"))
    el.textContent = site.label(el.dataset.regionLabel || site.region);
  for (const el of document.querySelectorAll<HTMLElement>("[data-region-short]")) {
    el.textContent = site.short(el.dataset.regionShort || site.region);
    el.title = site.label(el.dataset.regionShort || site.region);
  }
  const box = document.getElementById("regions");
  const regions = site.regions;
  if (!box || !regions) return;
  box.hidden = regions.length < 2;
  render(
    box,
    html`${regions.map(
      (r) =>
        html`<a href="${site.link(r.id)}" title="${r.label}"${r.id === site.region && raw(' aria-current="true"')}>${site.short(r.id)}</a>`,
    )}`,
  );
}

/** Makes a `<gb-search>` find players in this page's region (`/api/players?search=`). */
export function findPlayers(search: GbSearch): void {
  search.addEventListener("query", (event) => {
    const { query, signal, answer, fail } = (event as CustomEvent<SearchQuery>).detail;
    api<FoundPlayers>(`players?search=${encodeURIComponent(query)}&${inRegion()}`, { signal })
      .then((found) =>
        answer(
          found.players.map((p) => ({
            name: p.name,
            tier: tierName(p.tier),
            note: p.matchedAlias ? `was ${p.matchedAlias}` : undefined,
            detail: rating(p.rating),
            href: playerLink(p.id),
          })),
        ),
      )
      .catch(() => {
        if (!signal.aborted) fail();
      });
  });
}

// The phone's search: a full-screen sheet over the page, the keyboard up, results as you type.
let sheet: HTMLDialogElement | undefined;
function searchSheet(): HTMLDialogElement {
  if (sheet) return sheet;
  const box = document.createElement("dialog");
  box.className = "sheet";
  box.setAttribute("aria-label", "Find a player");
  render(
    box,
    html`<div class="sheet-bar">
      <gb-search label="Find a player" hide-label placeholder="Find a player" min-length="2" delay="250"></gb-search>
      <button type="button">Cancel</button>
    </div>`,
  );
  document.body.append(box);
  const search = box.querySelector("gb-search") as GbSearch;
  findPlayers(search);
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Slides back down before closing (the stylesheet's `closing` animation), unless motion is reduced.
  const close = () => {
    if (calm()) return box.close();
    box.classList.add("closing");
    box.addEventListener("animationend", () => (box.classList.remove("closing"), box.close()), { once: true });
  };
  box.querySelector("button")?.addEventListener("click", close);
  box.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  box.addEventListener("close", () => (search.value = ""));
  sheet = box;
  return box;
}
function openSheet(): void {
  const box = searchSheet();
  box.showModal();
  box.querySelector<GbSearch>("gb-search")?.focus();
}

// The phone's tab bar, in thumb reach. Hidden by the stylesheet above phone widths, where the header
// does the same job.
function tabBar(page: string): void {
  const tab = (href: string, icon: string, label: string, current: boolean) =>
    html`<a href="${href}"${current && raw(' aria-current="page"')}><gb-icon name="${icon}"></gb-icon>${label}</a>`;
  const bar = document.createElement("nav");
  bar.className = "tabbar";
  bar.setAttribute("aria-label", "Sections");
  render(
    bar,
    html`${tab("/", "leaderboard", "Leaderboard", page === "leaderboard")}${tab("/live", "live", "Live", page === "live")}${tab(
      "/records",
      "records",
      "Records",
      page === "records",
    )}${tab("/tourneys", "tourney", "Tourneys", page === "tourneys" || page === "tourney")}${tab("/?find", "search", "Find a player", false)}`,
  );
  document.body.append(bar);
  bar.lastElementChild?.addEventListener("click", (e) => {
    e.preventDefault();
    openSheet();
  });
  if (new URLSearchParams(location.search).has("find") && matchMedia("(max-width: 640px)").matches) openSheet();
}

// A dot on Live, in the header and the tab bar, while a lobby is open in the region. The Live page
// itself lists them, so it doesn't ask.
function liveDot(page: string): void {
  if (page === "live") return;
  openLobbies()
    .then(({ lobbies }) => {
      if (!lobbies.length) return;
      for (const link of document.querySelectorAll<HTMLAnchorElement>('gb-nav a[href="/live"], .tabbar a[href="/live"]')) {
        link.classList.add("open-now");
        link.insertAdjacentHTML("beforeend", html`<span class="live-dot" aria-hidden="true"></span><span class="sr">, ${lobbies.length} open now</span>`.value);
      }
    })
    .catch(() => {});
}

// Back, on a phone, on the inner pages reached from this site.
function backButton(): void {
  const head = document.querySelector(".headline");
  if (!head || !document.referrer.startsWith(location.origin) || history.length < 2) return;
  const back = document.createElement("button");
  back.className = "back";
  back.type = "button";
  back.setAttribute("aria-label", "Back");
  render(back, html`<gb-icon name="back"></gb-icon>`);
  back.addEventListener("click", () => history.back());
  head.prepend(back);
}

// A moment's hover on a link to a player or match fetches what that page asks the API for, so it's in
// the browser's cache (`publicCacheSeconds`) and the page fills in at once. A touch fetches straight away.
function prefetch(): void {
  const warmed = new Set<string>();
  let warming: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener("pointerover", (e) => {
    const link = (e.target as Element).closest?.<HTMLAnchorElement>('a[href^="/player?"], a[href^="/match?"]');
    if (!link) return;
    clearTimeout(warming);
    warming = setTimeout(
      () => {
        const url = new URL(link.href);
        const id = encodeURIComponent(url.searchParams.get("id") ?? "");
        const region = inRegion(url.searchParams.get("region") ?? site.region);
        const paths =
          url.pathname === "/player" ? [`players/${id}?${region}`, `players/${id}/history?${region}`] : [`matches/${id}`];
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
}

// Back to a page whose lists load after it opens: the browser would restore the scroll before they're
// there, and land at the top. The page puts it back itself once it has loaded.
const scrollKey = () => `scroll:${location.pathname}${location.search}`;
function keepScroll(): () => void {
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const returning = entry?.type === "back_forward";
  history.scrollRestoration = "manual";
  addEventListener("pagehide", () => {
    try {
      sessionStorage.setItem(scrollKey(), String(Math.round(scrollY)));
    } catch {
      // not kept
    }
  });
  return () => {
    if (!returning) return;
    let y = 0;
    try {
      y = Number(sessionStorage.getItem(scrollKey()));
    } catch {
      // not kept
    }
    if (y) scrollTo(0, y);
  };
}

/** Sets up the page around its content, then fills the content in with `fill`. */
export function start(page: string, fill: () => Promise<void> | void): void {
  if (pinned.includes(page)) site.pin();
  drawRegions();
  site.watch(drawRegions);
  showBanners(site);
  for (const search of document.querySelectorAll<GbSearch>("gb-search[data-players]")) findPlayers(search);
  tabBar(page);
  liveDot(page);
  backButton();
  prefetch();
  const restoreScroll = keepScroll();
  Promise.resolve()
    .then(fill)
    .catch((error: unknown) => console.error(error))
    .finally(restoreScroll);
}
