/* global URL, URLSearchParams */
// The head script's early API reads (site/lib/early.ts): each page's paths, written as the page's own
// `api()` calls write them, so `api()` finds them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";

const code = buildSync({
  entryPoints: [fileURLToPath(new URL("../site/lib/early.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  globalName: "early",
  write: false,
}).outputFiles[0].text;
// Arrays from the vm context have its own Array prototype: copied here to compare.
const inContext = runInNewContext(`${code}; early`, { URLSearchParams });
const earlyPaths = (...args) => [...inContext.earlyPaths(...args)];

test("the leaderboard asks for its page, the active filter, titles and lobbies", () => {
  assert.deepEqual(earlyPaths("/", "", "eu"), ["leaderboard?region=eu&page=1", "titles?region=eu", "lobbies?region=eu"]);
  assert.deepEqual(earlyPaths("/index.html", "?page=3&active=1", "na")[0], "leaderboard?region=na&page=3&active=1");
});

test("a player page asks for the player and their history; without an id, only lobbies", () => {
  assert.deepEqual(earlyPaths("/player", "?id=12&region=na", "na"), [
    "players/12?region=na",
    "players/12/history?region=na",
    "titles?region=na",
    "lobbies?region=na",
  ]);
  assert.deepEqual(earlyPaths("/player", "", "eu"), ["lobbies?region=eu"]);
});

test("a match page asks for the match without a region", () => {
  assert.deepEqual(earlyPaths("/match.html", "?id=7", "eu"), ["matches/7", "lobbies?region=eu"]);
});

test("the live page and pages without early reads ask only for lobbies", () => {
  assert.deepEqual(earlyPaths("/live", "", "eu"), ["lobbies?region=eu"]);
  assert.deepEqual(earlyPaths("/compare", "?ids=1,2", "eu"), ["lobbies?region=eu"]);
});
