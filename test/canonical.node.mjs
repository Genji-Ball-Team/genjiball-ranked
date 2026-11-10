/* global URL, URLSearchParams */
// The head script's canonical addresses (site/lib/canonical.ts): a region view names the region it
// shows, a match or tourney only its id, and filters and searches are left out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";

const code = buildSync({
  entryPoints: [fileURLToPath(new URL("../site/lib/canonical.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  globalName: "canonical",
  write: false,
}).outputFiles[0].text;
const { canonicalPath } = runInNewContext(`${code}; canonical`, { URLSearchParams });

test("a region view names the region it shows, as the sitemap does", () => {
  assert.equal(canonicalPath("/", "", "eu"), "/?region=eu");
  assert.equal(canonicalPath("/index.html", "?region=na", "na"), "/?region=na");
  // Without ?region=, the page shows the visitor's region: that's the one named.
  assert.equal(canonicalPath("/matches", "", "na"), "/matches?region=na");
  assert.equal(canonicalPath("/records.html", "?region=eu", "eu"), "/records?region=eu");
});

test("filters and searches are the same page; a later page is its own", () => {
  assert.equal(canonicalPath("/", "?tier=master&min=1500&find=al&region=eu", "eu"), "/?region=eu");
  assert.equal(canonicalPath("/", "?page=3&region=eu", "eu"), "/?page=3&region=eu");
  assert.equal(canonicalPath("/", "?page=1", "eu"), "/?region=eu");
  assert.equal(canonicalPath("/tourneys", "?page=2", "na"), "/tourneys?page=2&region=na");
});

test("a player and a compare page keep their ids and region; a match and a tourney only the id", () => {
  assert.equal(canonicalPath("/player", "?region=na&id=12", "na"), "/player?id=12&region=na");
  assert.equal(canonicalPath("/compare", "?ids=4,4,x,5,6,7", "eu"), "/compare?ids=4,5,6&region=eu");
  assert.equal(canonicalPath("/match", "?id=7&region=na", "eu"), "/match?id=7");
  assert.equal(canonicalPath("/tourney.html", "?id=3", "eu"), "/tourney?id=3");
});

test("no canonical without an id, or for a page search engines skip", () => {
  assert.equal(canonicalPath("/player", "", "eu"), null);
  assert.equal(canonicalPath("/match", "?id=abc", "eu"), null);
  assert.equal(canonicalPath("/compare", "?ids=x", "eu"), null);
  assert.equal(canonicalPath("/admin", "", "eu"), null);
  assert.equal(canonicalPath("/no-such-page", "", "eu"), null);
});
