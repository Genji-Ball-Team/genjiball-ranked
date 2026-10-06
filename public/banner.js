// Banners above every page, from /api/server (region.js has fetched it):
// - on the test server (#37), so its ratings aren't mistaken for the real ones;
// - while this region's ratings are being recomputed, since a player's rating and their rating
//   history only agree again once the recompute is done (docs/rating.md, "Ratings in the database").
"use strict";

site.server
  .then((server) => {
    const banner = (className, text) => {
      const p = document.createElement("p");
      p.className = className;
      p.textContent = text;
      document.body.prepend(p);
    };
    if (server.ratingsUpdating?.includes(site.region)) {
      banner("updating-banner", `${site.label(site.region)} ratings are being recalculated. Some numbers may not match until it's done.`);
    }
    if (server.testServer) banner("test-banner", "Test server: ratings here aren't real.");
  })
  .catch(() => {});
