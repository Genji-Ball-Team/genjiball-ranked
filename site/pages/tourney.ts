// A tourney's page (tourney.html): when and where, the sign-ups while it's still to come (the one
// public POST of the site), and each lobby's winner, standings and the host's screenshot.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/delta.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/field.js";
import "@genji-ball-team/ui/icon.js";
import "@genji-ball-team/ui/panel.js";
import "@genji-ball-team/ui/table.js";
import type { GbButton } from "@genji-ball-team/ui/button.js";
import type { GbField } from "@genji-ball-team/ui/field.js";
import { toast } from "@genji-ball-team/ui/toast.js";
import { api, idParam, matchLink, NotFound, playerLink } from "../lib/api";
import { count, dateTime, num, rating, title } from "../lib/format";
import { byId, html, render, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import {
  cup,
  fullChip,
  statusChip,
  until,
  verifiedChip,
  winners,
  type Lobby,
  type SignupAnswer,
  type Standing,
  type Tourney,
} from "../lib/tourney";
import { start } from "../shell";

const signupNameKey = "signup-name";

function remember(value: string): void {
  try {
    localStorage.setItem(signupNameKey, value);
  } catch {
    // not kept
  }
}

function remembered(): string {
  try {
    return localStorage.getItem(signupNameKey) ?? "";
  } catch {
    return "";
  }
}

/** The rating after a match, and what it changed by. */
function change(s: Standing): Html {
  if (s.ratingAfter === null) return html`<span class="muted">–</span>`;
  const d = s.ratingBefore === null ? 0 : s.ratingAfter - s.ratingBefore;
  return html`${rating(s.ratingAfter)}${d !== 0 && html`<gb-delta value="${d}"></gb-delta>`}`;
}

function standingsTable(l: Lobby): Html {
  const rows = l.standings.map(
    (s) => html`<tr${s.place === 1 && html` class="first"`}>
      <td class="num">${s.place}</td>
      <td class="name"><a href="${playerLink(s.id)}">${s.name}</a></td>
      <td class="num">${s.wins}</td><td class="num">${s.kills}</td>
      <td class="num muted">${rating(s.ratingBefore)}</td>
      <td class="out num">${change(s)}</td></tr>`,
  );
  return html`<gb-panel compact><gb-table><table>
    <caption class="sr">Standings of ${l.label}</caption>
    <thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col" data-type="number">Won</th><th scope="col" data-type="number">Kills</th>
      <th scope="col" data-type="number">Rating in</th><th scope="col" data-type="number">Out</th></tr></thead>
    <tbody>${rows}</tbody></table></gb-table></gb-panel>`;
}

/** The winners' names as links, "A & B" when they share the place. */
const winnerLinks = (won: Standing[]): Html =>
  html`${won.map((s, i) => html`${i > 0 && " & "}<a href="${playerLink(s.id)}">${s.name}</a>`)}`;

function lobbySection(t: Tourney, l: Lobby): Html {
  const won = winners(l);
  const first = won[0];
  const heading = t.lobbies.length > 1 || !l.standings.length ? html`<h2>${l.label}</h2>` : "";
  const flags = l.standings.length
    ? html`${verifiedChip(l.verified)}${l.void && html`<gb-chip class="cancelled" title="Doesn't count for ratings">Void</gb-chip>`}`
    : "";
  const podium =
    first &&
    html`<p class="podium">${cup}<span><small class="label">Winner</small><b>${winnerLinks(won)}</b>
      <small>${count(first.wins, "round")} won, ${count(first.kills, "kill")}</small></span></p>`;
  const proof = l.screenshot
    ? html`<figure class="proof"><button type="button" class="zoom" data-src="${l.screenshot}" aria-label="Enlarge the screenshot of ${l.label}">
        <img src="${l.screenshot}" alt="Final standings of ${l.label}, as the host saw them" loading="lazy" decoding="async"></button>
        <figcaption>The host's screenshot of the final standings${l.verified && ", checked by an admin"}.</figcaption></figure>`
    : l.screenshotExpired
      ? html`<p class="note proof">The screenshot is no longer kept: only the newest ones are.${l.verified && " An admin checked it against these standings."}</p>`
      : "";
  const missing = t.status === "cancelled" ? "Didn't take place." : t.status === "done" ? "The result isn't in yet." : "Not played yet.";
  const body = l.standings.length
    ? html`${standingsTable(l)}${l.matchId !== null && html`<p class="note"><a href="${matchLink(l.matchId)}">Every round of this lobby</a></p>`}`
    : html`<gb-empty>${missing}</gb-empty>`;
  return html`<section class="lobby">${(heading !== "" || flags !== "") && html`<div class="lobby-head">${heading}${flags}</div>`}${podium}
    <div class="lobby-body"><div>${body}</div>${proof}</div></section>`;
}

// A screenshot at full size over the page. A click anywhere or Escape closes it.
let lightbox: HTMLDialogElement | undefined;
function enlarge(src: string, alt: string): void {
  if (!lightbox) {
    const box = document.createElement("dialog");
    box.className = "screenshot-box";
    render(box, html`<img alt=""><button type="button" aria-label="Close"><gb-icon name="close"></gb-icon></button>`);
    box.addEventListener("click", () => box.close());
    document.body.append(box);
    lightbox = box;
  }
  const img = lightbox.querySelector("img");
  if (img) {
    img.src = src;
    img.alt = alt;
  }
  lightbox.showModal();
}

/** "8 of 10 places" with a bar, and a Full chip once the lobbies are. */
function signupCount(t: Tourney, signed: number): Html {
  const full = t.capacity > 0 && signed >= t.capacity;
  const share = t.capacity ? Math.min(100, Math.round((100 * signed) / t.capacity)) : 0;
  return html`<b class="num">${num(signed)}</b>${t.capacity > 0 && html`<span class="muted">of ${num(t.capacity)} places</span>`}${full && fullChip}${
    t.capacity > 0 && html`<span class="track"><span style="width:${share}%"></span></span>`
  }`;
}

/** The names signed up, first come first; past the capacity they wait for another lobby. */
function signupNames(names: string[], capacity: number): Html {
  return html`${names.map(
    (name, i) =>
      html`${i === capacity && capacity > 0 && html`<li class="cut">Past capacity: these wait for another lobby</li>`}<li${
        capacity > 0 && i >= capacity && html` class="over"`
      }>${name}</li>`,
  )}`;
}

/** What went wrong with a sign-up, in the server's words when it gave some. */
async function signupError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  return data.message ?? `The sign-up didn't go through (HTTP ${res.status}). Try again.`;
}

// The sign-ups of an upcoming tourney: how many and who, and, until it starts, a box to add your
// in-game name. Nothing is enforced: it tells the admins how many lobbies to set up.
function signupSection(t: Tourney): void {
  const names = [...(t.signups.names ?? [])];
  let signed = t.signups.count;
  const draw = () => {
    render(byId("signup-count"), signupCount(t, signed));
    render(byId("signup-names"), signupNames(names, t.capacity));
  };
  byId("signup-section").hidden = false;
  byId("signup-closed").hidden = t.signups.open;
  draw();
  if (!t.signups.open) return;

  const form = byId<HTMLFormElement>("signup-form");
  const field = byId<GbField>("signup-field");
  const input = byId<HTMLInputElement>("signup-name");
  const button = byId<GbButton>("signup-button");
  form.hidden = false;
  byId("signup-hint").hidden = false;
  input.value = remembered();
  input.addEventListener("input", () => field.removeAttribute("error"));
  const signUp = async (): Promise<void> => {
    const name = input.value.trim();
    if (!name || button.hasAttribute("busy")) return;
    button.setAttribute("busy", "");
    try {
      // `api()` only says "HTTP 409"; the server's message says which of the 409s it is.
      const res = await fetch(`/api/tourneys/${t.id}/signups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await signupError(res));
      const answer = (await res.json()) as SignupAnswer;
      if (answer.created) names.push(answer.signup.name);
      signed = answer.signups.count;
      remember(answer.signup.name);
      toast(answer.created ? `You're signed up as ${answer.signup.name}.` : `${answer.signup.name} is already signed up.`);
      draw();
    } catch (error) {
      field.setAttribute("error", error instanceof Error ? error.message : "The sign-up didn't go through. Try again.");
    } finally {
      button.removeAttribute("busy");
    }
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void signUp();
  });
}

async function tourneyPage(): Promise<void> {
  // The tourney is in one region: the page takes it, and the switch leads to that region's list.
  site.own = true;
  site.link = (id) => `/tourneys?region=${encodeURIComponent(id)}`;
  try {
    const { tourney: t } = await api<{ tourney: Tourney }>(`tourneys/${encodeURIComponent(idParam())}`);
    site.use(t.region);
    title(`${t.name} (${site.short(t.region)})`);
    byId("name").textContent = t.name;
    render(byId("flags"), html`<gb-chip data-region-short="${t.region}">${site.short(t.region)}</gb-chip>${statusChip(t.status)}`);
    const facts = [
      dateTime(t.startsAt) + (t.status === "scheduled" ? `, ${until(t.startsAt)}` : ""),
      site.label(t.region),
      t.lobbies.length > 0 && count(t.lobbies.length, "lobby", "lobbies"),
    ];
    const won = t.winner && html`<li class="won">${cup}Won by <a href="${playerLink(t.winner.id)}">${t.winner.name}</a></li>`;
    render(byId("facts"), html`${won}${facts.filter(Boolean).map((f) => html`<li>${f}</li>`)}`);
    byId("notes").textContent = t.notes ?? "";
    const upcoming = t.status === "scheduled" || t.status === "live";
    if (upcoming) signupSection(t);
    const box = byId("lobbies");
    loaded(
      box,
      t.lobbies.length
        ? html`${t.lobbies.map((l) => lobbySection(t, l))}`
        : html`<gb-empty>${upcoming ? "Lobbies are set up closer to the start." : "No lobbies."}</gb-empty>`,
    );
    box.addEventListener("click", (e) => {
      const zoom = (e.target as Element).closest<HTMLElement>(".zoom");
      const img = zoom?.querySelector("img");
      if (zoom?.dataset.src && img) enlarge(zoom.dataset.src, img.alt);
    });
  } catch (error) {
    byId("name").textContent = error instanceof NotFound ? "Tourney not found" : "Tourney";
    showError(byId("lobbies"), error, "tourney");
  }
}

start("tourney", tourneyPage);
