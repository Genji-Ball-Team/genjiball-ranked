// On the test server (#37), a banner on every page so its ratings aren't mistaken for the real ones.
"use strict";

fetch("/api/server")
  .then((res) => (res.ok ? res.json() : null))
  .then((server) => {
    if (!server?.testServer) return;
    const banner = document.createElement("p");
    banner.className = "test-banner";
    banner.textContent = "Test server: ratings here aren't real.";
    document.body.prepend(banner);
  })
  .catch(() => {});
