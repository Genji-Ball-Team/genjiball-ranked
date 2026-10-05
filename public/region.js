// EU and NA mode (#48): every page shows one region's data. The region is in the URL (`?region=na`)
// so a shared link opens the same view; without one, the last region viewed, then a guess from the
// browser's time zone. Loaded in <head>, so the region's colours (`<html data-region>`, style.css)
// are there from the first frame. The regions are /api/server's (`regions` in src/config.ts); the
// last list seen is kept, so the switch in the header is drawn straight away on later visits.
"use strict";

const site = (() => {
  const store = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // not kept
      }
    },
  };
  const param = () => new URLSearchParams(location.search).get("region")?.trim().toLowerCase() || null;
  const guess = () => (Intl.DateTimeFormat().resolvedOptions().timeZone?.startsWith("America/") ? "na" : "eu");
  const known = (id) => !regions || regions.some((r) => r.id === id);

  let regions = store.get("regions");
  const site = {
    region: [param(), store.get("region"), guess()].find((id) => id && known(id)) ?? regions[0].id,
    // Set by a page that shows one match or tourney: the region is that one's, not the URL's.
    own: false,
    // Where the switch leads: this page in the other region. Pages that show one match or tourney
    // (whose region is its own) send it to a list instead.
    link(id) {
      const url = new URL(location.href);
      for (const key of ["page", "find"]) url.searchParams.delete(key);
      url.searchParams.set("region", id);
      return url.pathname + url.search;
    },
    // Show this region: its colours and switch, and the next page without one in its URL opens it.
    use(id) {
      site.region = id;
      document.documentElement.dataset.region = id;
      store.set("region", id);
      draw();
    },
    // Put the region in the URL, for a link that opens the same view when it's shared.
    pin() {
      const url = new URL(location.href);
      if (url.searchParams.get("region") === site.region) return;
      url.searchParams.set("region", site.region);
      history.replaceState(history.state, "", url);
    },
    label: (id) => regions?.find((r) => r.id === id)?.label ?? id.toUpperCase(),
    short: (id) => id.toUpperCase(),
    server: fetch("/api/server").then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))),
  };

  // The switch, and the region names in the page (`<span data-region-label="na">`, which say "NA"
  // until a first visit has the labels).
  function draw() {
    const top = document.querySelector(".top");
    if (!top || !regions) return;
    for (const span of document.querySelectorAll("[data-region-label]")) span.textContent = site.label(span.dataset.regionLabel);
    let group = top.querySelector(".regions");
    if (!group) {
      group = document.createElement("div");
      group.className = "regions";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Region");
      top.querySelector(".mark").after(group);
    }
    group.innerHTML = regions
      .map((r) => `<a href="${site.link(r.id)}" title="${r.label}"${r.id === site.region ? ' aria-current="true"' : ""}>${site.short(r.id)}</a>`)
      .join("");
  }

  document.documentElement.dataset.region = site.region;
  store.set("region", site.region);
  document.addEventListener("DOMContentLoaded", draw);
  site.server
    .then((server) => {
      regions = server.regions;
      store.set("regions", regions);
      if (known(site.region)) return draw();
      // A region that's gone, or a mistyped link: the first region instead. A match or tourney page
      // shows its own region once it's loaded, so it stays.
      site.use(regions[0].id);
      if (!site.own) location.replace(site.link(site.region));
    })
    .catch(() => {});
  return site;
})();
