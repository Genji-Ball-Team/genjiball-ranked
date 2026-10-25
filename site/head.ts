// The head script (build/head.js): a classic script in every page's <head>, before the stylesheet
// paints. It picks the region and puts it on <html data-region>, then leaves it on `window.gbSite`
// for the page's module (lib/site.ts).
import { createSite } from "./lib/region";

window.gbSite = createSite();
