// On the test server (#37), a banner on every page so its ratings aren't mistaken for the real ones.
// region.js has fetched /api/server.
"use strict";

site.server
  .then((server) => {
    if (!server.testServer) return;
    const banner = document.createElement("p");
    banner.className = "test-banner";
    banner.textContent = "Test server: ratings here aren't real.";
    document.body.prepend(banner);
  })
  .catch(() => {});
