// EU and NA mode (#48): every page shows one region's data. The region is in the URL (`?region=na`)
// so a shared link opens the same view; without one, the last region viewed, then a guess from the
// browser's time zone. Runs in <head> (head.ts), so `<html data-region>` is
// there from the first frame. The regions are /api/server's (`regions` in src/config.ts); the last
// list seen is kept, so the switch in the header is drawn straight away on later visits.
import type { Region, Server } from "./types";

export interface Site {
  /** The region this page shows. */
  region: string;
  /** Set by a page that shows one match or tourney: the region is that one's, not the URL's. */
  own: boolean;
  /** The regions, once known: from the last visit at first, then /api/server's. */
  readonly regions: readonly Region[] | null;
  /** /api/server, asked once per page. */
  readonly server: Promise<Server>;
  /** Where the switch leads: this page in region `id`. */
  link(id: string): string;
  /** Show region `id`, and the next page without one in its URL opens it. */
  use(id: string): void;
  /** `watcher()` runs each time the page shows a region, or the region list changes. */
  watch(watcher: () => void): void;
  /** Put the region in the URL, for a link that opens the same view when it's shared. */
  pin(): void;
  /** "Europe": the region's name, its id in capitals until the list is known. */
  label(id: string): string;
  /** "EU". */
  short(id: string): string;
}

const store = {
  get<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // not kept
    }
  },
};

export function createSite(): Site {
  const param = () => new URLSearchParams(location.search).get("region")?.trim().toLowerCase() || null;
  const guess = () => (Intl.DateTimeFormat().resolvedOptions().timeZone?.startsWith("America/") ? "na" : "eu");
  let regions = store.get<Region[]>("regions");
  // Before the server supplies the list, only the built-in regions are safe for API requests.
  const known = (id: string) => (regions?.length ? regions.some((r) => r.id === id) : ["eu", "na"].includes(id));
  const preferred = [param(), store.get<string>("region"), guess()];
  const watchers: (() => void)[] = [];
  const changed = () => watchers.forEach((watcher) => watcher());

  const site: Site = {
    region: preferred.find((id) => id && known(id)) ?? regions?.[0]?.id ?? guess(),
    own: false,
    get regions() {
      return regions;
    },
    server: fetch("/api/server").then((res) =>
      res.ok ? (res.json() as Promise<Server>) : Promise.reject(new Error(`HTTP ${res.status}`)),
    ),
    link(id) {
      const url = new URL(location.href);
      for (const key of ["page", "find"]) url.searchParams.delete(key);
      url.searchParams.set("region", id);
      return url.pathname + url.search;
    },
    use(id) {
      site.region = id;
      document.documentElement.dataset.region = id;
      store.set("region", id);
      changed();
    },
    watch(watcher) {
      watchers.push(watcher);
    },
    pin() {
      const url = new URL(location.href);
      if (url.searchParams.get("region") === site.region) return;
      url.searchParams.set("region", site.region);
      history.replaceState(history.state, "", url);
    },
    label: (id) => regions?.find((r) => r.id === id)?.label ?? id.toUpperCase(),
    short: (id) => id.toUpperCase(),
  };

  document.documentElement.dataset.region = site.region;
  site.server
    .then((server) => {
      regions = server.regions;
      store.set("regions", regions);
      const first = regions[0]?.id ?? site.region;
      // Revisit the original choices: an uncached region may now be known. Match and tourney pages
      // keep the region from their own API response.
      const region = site.own ? site.region : (preferred.find((id) => id && known(id)) ?? first);
      if (region !== site.region) {
        site.use(region);
        return location.replace(site.link(region));
      }
      // Kept for the next page only once the server knows it, so a mistyped link isn't remembered.
      if (known(site.region)) {
        store.set("region", site.region);
        return changed();
      }
      // A region that's gone, or a mistyped link: the first region instead. A match or tourney page
      // shows its own region once it's loaded, so it stays.
      site.use(first);
      if (!site.own) location.replace(site.link(site.region));
    })
    .catch(() => {});
  return site;
}
