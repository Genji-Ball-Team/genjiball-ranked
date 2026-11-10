// The page's canonical address (<link rel="canonical">), set by the head script (head.ts). EU and NA
// are separate boards, so a region view's canonical names its region: the one the page shows, which
// without `?region=` is the visitor's last or guessed one, so the static HTML can't say it. That is
// also how sitemap.xml lists them (`/?region=eu`). A match or tourney shows its own region, so its
// canonical is its id alone. Filters, search and the like are views of the same page and are left out.
// For a link preview crawler, which runs no script, the Worker writes the same into the player, match
// and compare pages (src/site/preview.ts).

import { comparedIds } from "./early";

type Key = "region" | "id" | "ids" | "page";

/** What each page's canonical keeps, in this order. A page not listed (admin, 404) has none. */
const kept: Record<string, readonly Key[]> = {
  "/": ["page", "region"],
  "/matches": ["region"],
  "/duels": ["region"],
  "/live": ["region"],
  "/records": ["region"],
  "/tourneys": ["page", "region"],
  "/ranked": ["region"],
  "/host": ["region"],
  "/data": ["region"],
  "/player": ["id", "region"],
  "/compare": ["ids", "region"],
  "/match": ["id"],
  "/tourney": ["id"],
};

/** `/player?id=12&region=eu`: the page's canonical path and query, or null when it has none. */
export function canonicalPath(pathname: string, search: string, region: string): string | null {
  const path = pathname.replace(/\.html$/, "").replace(/^\/index$/, "/");
  const keys = kept[path];
  if (!keys) return null;
  const query = new URLSearchParams(search);
  const parts: string[] = [];
  for (const key of keys) {
    if (key === "region") parts.push(`region=${encodeURIComponent(region)}`);
    else if (key === "page") {
      const page = Number(query.get("page"));
      if (Number.isInteger(page) && page > 1) parts.push(`page=${page}`);
    } else if (key === "id") {
      const id = query.get("id")?.trim() ?? "";
      if (!/^[1-9]\d{0,15}$/.test(id)) return null;
      parts.push(`id=${id}`);
    } else {
      const ids = comparedIds(search);
      if (!ids.length) return null;
      parts.push(`ids=${ids.join(",")}`);
    }
  }
  return parts.length ? `${path}?${parts.join("&")}` : path;
}

/** Puts the canonical in <head>: the one the Worker wrote for a crawler, or a new one. */
export function setCanonical(path: string | null): void {
  if (!path) return;
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.append(link);
  }
  link.href = new URL(path, location.origin).href;
}
