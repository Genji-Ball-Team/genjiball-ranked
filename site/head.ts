// The head script (build/head.js): a classic script in every page's <head>, above the stylesheet so
// it runs without waiting for it, and before the page paints. It picks the region and puts it on
// <html data-region>, then leaves it on `window.gbSite` for the page's module (lib/site.ts). It also
// asks for the page's first API reads (lib/early.ts), so they load alongside the page's module.
import { askEarly, earlyPaths } from "./lib/early";
import { createSite } from "./lib/region";

window.gbSite = createSite();
window.gbEarly = askEarly(earlyPaths(location.pathname, location.search, window.gbSite.region));
