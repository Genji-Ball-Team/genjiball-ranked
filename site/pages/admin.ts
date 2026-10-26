// The admin pages (/admin). One page, one view per area, picked by the hash (`#/matches`,
// `#/tourneys/3`), so a view is a link that can be shared between admins. The views are in
// site/admin/; this file is the sign-in, the router and the header.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/field.js";
import "@genji-ball-team/ui/nav.js";
import "@genji-ball-team/ui/segmented.js";
import "@genji-ball-team/ui/toast.js";
import { site } from "../lib/site";
import { byId, h } from "../admin/dom";
import { hostsView } from "../admin/hosts";
import { logView } from "../admin/log";
import { matchesView, matchView } from "../admin/matches";
import { overview } from "../admin/overview";
import { playersView, playerView } from "../admin/players";
import { api, app, currentRoute, keepToken, messageOf, setQuery } from "../admin/state";
import { toolsView } from "../admin/tools";
import { tourneyTodos, tourneysView, tourneyView } from "../admin/tourneys";
import type { AdminTourney, AdminMatch } from "../admin/types";
import { btn, notFound, skeletons, type View } from "../admin/ui";
import type { Server } from "../lib/types";

const routes: [RegExp, View][] = [
  [/^$/, overview],
  [/^matches$/, matchesView],
  [/^matches\/(\d+)$/, matchView],
  [/^tourneys$/, tourneysView],
  [/^tourneys\/(\d+)$/, tourneyView],
  [/^hosts$/, hostsView],
  [/^players$/, playersView],
  [/^players\/(\d+)$/, playerView],
  [/^log$/, logView],
  [/^tools$/, toolsView],
];

// ---- The header: region switch and banners ----

function drawRegions(): void {
  const box = document.getElementById("regions");
  const regions = site.regions;
  if (!box || !regions) return;
  box.hidden = regions.length < 2;
  box.replaceChildren(
    ...regions.map((r) => h("a", { href: site.link(r.id), title: r.label, "aria-current": r.id === site.region ? "true" : null }, site.short(r.id))),
  );
}

let server: Server | null = null;
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
function drawBanners(): void {
  if (!server) return;
  const updating = server.ratingsUpdating.includes(site.region);
  banner("updating-banner", updating ? `${site.label(site.region)} ratings are being recalculated. Some numbers may not match until it's done.` : null);
  banner("test-banner", server.testServer ? "Test server: ratings here aren't real." : null);
}

// The header's EU/NA switch changes the region in place here, rather than loading the page again.
document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>(".top .regions a");
  if (!link || byId("app").hidden) return;
  const id = new URL(link.href).searchParams.get("region");
  if (!app.regions.some((r) => r.id === id)) return;
  event.preventDefault();
  site.use(id ?? site.region);
  setQuery({ region: "" });
  site.pin();
  void app.refresh();
});

// ---- Drawing a view ----

let drawing = 0;
async function refresh({ top = false }: { top?: boolean } = {}): Promise<void> {
  if (byId("app").hidden) return;
  const mine = ++drawing;
  const { path, query } = currentRoute();
  let view: View = notFound;
  let params: string[] = [];
  for (const [pattern, fn] of routes) {
    const found = pattern.exec(path);
    if (found) {
      view = fn;
      params = found.slice(1);
      break;
    }
  }
  const current = path.split("/")[0];
  for (const a of document.querySelectorAll<HTMLAnchorElement>("#side-nav a")) {
    if (a.dataset.nav === current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const box = h("div", { class: "view" });
  const target = byId("view");
  if (top) target.replaceChildren(...skeletons());
  target.setAttribute("aria-busy", "true");
  const scrollY = window.scrollY;
  try {
    await view(box, params, query);
  } catch (e) {
    box.replaceChildren(h("h1", null, "Couldn't load this"), h("p", { class: "error" }, messageOf(e)), btn("Try again", () => refresh()));
  }
  if (mine !== drawing) return;
  target.replaceChildren(box);
  target.removeAttribute("aria-busy");
  if (top) {
    window.scrollTo(0, 0);
    box.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  } else window.scrollTo(0, scrollY);
  badges().catch(() => undefined);
}
app.refresh = refresh;
window.addEventListener("hashchange", () => void refresh({ top: true }));

// The counts on the side nav: matches in review and open tourney jobs.
async function badges(): Promise<void> {
  const [{ matches }, { tourneys }] = await Promise.all([
    api<{ matches: AdminMatch[] }>("matches?status=review"),
    api<{ tourneys: AdminTourney[] }>("tourneys"),
  ]);
  const set = (id: string, n: number) => {
    const el = byId(id);
    el.textContent = String(n);
    el.hidden = !n;
  };
  set("badge-review", matches.length);
  set("badge-tourneys", tourneys.reduce((n, t) => n + tourneyTodos(t).length, 0));
}

// ---- Signing in ----

async function signIn(): Promise<void> {
  const { admin } = await api<{ admin: { name: string } }>("me");
  byId("admin-name").textContent = admin.name;
  app.regions = (await site.server).regions;
  byId("signin").hidden = true;
  byId("app").hidden = false;
  site.pin();
  await refresh({ top: true });
}

function signOut(message: string | null = null): void {
  app.token = null;
  app.hostCache = null;
  keepToken(null);
  byId("app").hidden = true;
  byId("signin").hidden = false;
  const error = byId("signin-error");
  error.textContent = message ?? "";
  error.hidden = !message;
  byId<HTMLInputElement>("token").focus();
}
app.signOut = signOut;

byId<HTMLFormElement>("signin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = byId<HTMLInputElement>("token");
  const button = byId("signin-button");
  app.token = input.value.trim();
  keepToken(app.token);
  input.value = "";
  button.setAttribute("busy", "");
  signIn()
    .catch((e: unknown) => {
      if (app.token) signOut(messageOf(e));
    })
    .finally(() => button.removeAttribute("busy"));
});
byId("signin-button").addEventListener("click", () => byId<HTMLFormElement>("signin-form").requestSubmit());
byId("signout").addEventListener("click", () => signOut());

// "/" focuses the view's search box.
document.addEventListener("keydown", (event) => {
  const target = event.target as Element;
  if (event.key !== "/" || target.closest("input, textarea, select") || document.querySelector("dialog[open]")) return;
  const box = byId("view").querySelector<HTMLInputElement>("input[type=search]");
  if (box) {
    event.preventDefault();
    box.focus();
  }
});

drawRegions();
site.watch(drawRegions);
site.watch(drawBanners);
site.server
  .then((answer) => {
    server = answer;
    drawBanners();
  })
  .catch(() => undefined);

if (app.token) signIn().catch((e: unknown) => signOut(messageOf(e)));
else signOut();
