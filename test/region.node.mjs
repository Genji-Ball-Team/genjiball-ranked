/* global URL, URLSearchParams */
// Run the actual head script with a pending server request: pages use site.region immediately.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../public/region.js", import.meta.url), "utf8");
const regions = [{ id: "eu", label: "Europe" }, { id: "na", label: "North America" }];

function load({ query = "", stored = {}, timeZone = "Europe/Amsterdam" } = {}) {
  const storage = new Map(Object.entries(stored).map(([key, value]) => [key, JSON.stringify(value)]));
  const dataset = {};
  const redirects = [];
  let resolve, reject;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  const site = runInNewContext(`${script}\nsite;`, {
    URL, URLSearchParams,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    location: { search: query, href: `https://example.com/${query}`, replace: (url) => redirects.push(url) },
    document: { documentElement: { dataset }, addEventListener() {}, querySelector: () => null },
    fetch: () => response,
  });
  return {
    site, dataset, storage, redirects,
    async finish(list = regions) {
      resolve({ ok: true, json: async () => ({ regions: list }) });
      await site.server;
      await Promise.resolve();
    },
    async fail() {
      reject(new Error("unavailable"));
      await site.server.catch(() => {});
      await Promise.resolve();
    },
  };
}

test("an unknown URL or saved region uses a safe region while the server is pending or fails", async () => {
  const page = load({ query: "?region=xx", stored: { region: "xx" } });
  assert.equal(page.site.region, "eu");
  assert.equal(page.dataset.region, "eu");
  assert.equal(page.storage.get("region"), '"xx"');
  await page.fail();
  assert.equal(page.site.region, "eu");
});

test("a first-visit NA link works immediately and is saved only after validation", async () => {
  const page = load({ query: "?region=NA" });
  assert.equal(page.site.region, "na");
  assert.equal(page.storage.has("region"), false);
  await page.finish();
  assert.equal(page.storage.get("region"), '"na"');
});

test("a cached valid selection beats the time zone guess when the URL is invalid", async () => {
  const page = load({ query: "?region=xx", stored: { regions, region: "na" } });
  assert.equal(page.site.region, "na");
  await page.finish();
  assert.equal(page.site.region, "na");
});

test("an empty cached list still selects a safe initial region", async () => {
  const page = load({ stored: { regions: [] } });
  assert.equal(page.site.region, "eu");
  await page.finish();
  assert.equal(page.site.region, "eu");
});

test("the server can validate a URL region absent from the cache", async () => {
  const page = load({ query: "?region=ap" });
  assert.equal(page.site.region, "eu");
  await page.finish([...regions, { id: "ap", label: "Asia Pacific" }]);
  assert.equal(page.site.region, "ap");
  assert.equal(page.storage.get("region"), '"ap"');
  assert.deepEqual(page.redirects, ["/?region=ap"]);
});

test("a match's own region survives the server response", async () => {
  const page = load({ query: "?region=eu" });
  page.site.own = true;
  page.site.use("na");
  await page.finish();
  assert.equal(page.site.region, "na");
  assert.equal(page.storage.get("region"), '"na"');
  assert.deepEqual(page.redirects, []);
});
