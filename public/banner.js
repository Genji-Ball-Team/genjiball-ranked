// Banners above every page, from /api/server (region.js has fetched it):
// - on the test server (#37), so its ratings aren't mistaken for the real ones;
// - while this region's ratings are being recomputed, since a player's rating and their rating
//   history only agree again once the recompute is done (docs/rating.md, "Ratings in the database").
//   Drawn again when the page shows another region: a match or tourney page takes its own.
"use strict";

(() => {
  let server = null;

  // The page's banner with this class, showing `text`; none when `text` is null. The test server's
  // stays on top.
  function banner(className, text) {
    let p = document.querySelector(`body > .${className}`);
    if (text === null) return p?.remove();
    if (!p) {
      p = document.createElement("p");
      p.className = className;
      const test = document.querySelector("body > .test-banner");
      if (test) test.after(p);
      else document.body.prepend(p);
    }
    p.textContent = text;
  }

  function draw() {
    if (!server) return;
    const updating = server.ratingsUpdating?.includes(site.region);
    banner("updating-banner", updating ? `${site.label(site.region)} ratings are being recalculated. Some numbers may not match until it's done.` : null);
    banner("test-banner", server.testServer ? "Test server: ratings here aren't real." : null);
  }

  site.server
    .then((data) => {
      server = data;
      draw();
    })
    .catch(() => {});
  site.watch(draw);
})();
