// Banners above the header, from /api/server: on the test server, so its ratings aren't taken for
// the real ones, and while this region's ratings are being recomputed (docs/rating.md, "Ratings in
// the database"). The test server's stays on top. Kept apart from the shell so a Node test can run it.
import type { Site } from "./region";
import type { Server } from "./types";

function banner(className: string, text: string | null): void {
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

/** Shows the banners once /api/server answers, and keeps the ratings one on the page's region. */
export function showBanners(site: Site): void {
  let server: Server | null = null;
  const draw = (): void => {
    if (!server) return;
    const updating = server.ratingsUpdating.includes(site.region);
    banner(
      "updating-banner",
      updating ? `${site.label(site.region)} ratings are being recalculated. Some numbers may not match until it's done.` : null,
    );
    banner("test-banner", server.testServer ? "Test server: ratings here aren't real." : null);
  };
  site.watch(draw);
  site.server
    .then((answer) => {
      server = answer;
      draw();
    })
    .catch(() => {});
}
