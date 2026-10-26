/* global URL, URLSearchParams, setTimeout */
// Run the head script and the banners (site/head.ts and site/lib/banners.ts, bundled here as the
// build does) with a stubbed page: the ratings banner follows the region the page shows, also one a
// match page takes after /api/server answered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";

const bundle = (file, options = {}) =>
  buildSync({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, format: "iife", write: false, ...options })
    .outputFiles[0].text;
const head = bundle("../site/head.ts");
const banners = bundle("../site/lib/banners.ts", { globalName: "banners" });
const regions = [{ id: "eu", label: "Europe" }, { id: "na", label: "North America" }];

// The body's paragraphs, top first, as `class: text`.
function page(server) {
  const body = [];
  const element = () => {
    const p = {
      className: "",
      textContent: "",
      remove: () => body.splice(body.indexOf(p), 1),
      after: (next) => body.splice(body.indexOf(p) + 1, 0, next),
    };
    return p;
  };
  const document = {
    documentElement: { dataset: {} },
    addEventListener() {},
    querySelector: (selector) => body.find((p) => selector === `body > .${p.className}`) ?? null,
    createElement: element,
    body: { prepend: (p) => body.unshift(p) },
  };
  const context = {
    URL,
    URLSearchParams,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "Europe/Amsterdam" }) }) },
    localStorage: { getItem: () => null, setItem() {} },
    location: { pathname: "/match", search: "?region=eu", href: "https://example.com/match?region=eu", replace() {} },
    document,
    fetch: async () => ({ ok: true, json: async () => ({ regions, ...server }) }),
  };
  const site = runInNewContext(`var window = globalThis;\n${head}\n${banners}\nbanners.showBanners(window.gbSite);\nwindow.gbSite;`, context);
  return { site, shown: () => body.map((p) => `${p.className}: ${p.textContent}`) };
}

const settle = async (site) => {
  await site.server;
  await new Promise((resolve) => setTimeout(resolve));
};

test("the ratings banner follows a match page's own region, under the test server's", async () => {
  const { site, shown } = page({ ratingsUpdating: ["na"], testServer: true });
  site.own = true;
  await settle(site);
  assert.deepEqual(shown(), ["test-banner: Test server: ratings here aren't real."]);
  site.use("na");
  assert.deepEqual(shown(), [
    "test-banner: Test server: ratings here aren't real.",
    "updating-banner: North America ratings are being recalculated. Some numbers may not match until it's done.",
  ]);
  site.use("eu");
  assert.deepEqual(shown(), ["test-banner: Test server: ratings here aren't real."]);
});

test("a region the page took before /api/server answered gets its banner once it does", async () => {
  const { site, shown } = page({ ratingsUpdating: ["na"] });
  site.own = true;
  site.use("na");
  assert.deepEqual(shown(), []);
  await settle(site);
  assert.deepEqual(shown(), ["updating-banner: North America ratings are being recalculated. Some numbers may not match until it's done."]);
});
