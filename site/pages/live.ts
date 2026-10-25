// The live lobbies page (live.html): the ranked lobbies open in the region right now, asked again
// every few seconds while the page is in view.
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/empty.js";
import { api, inRegion } from "../lib/api";
import { plural, title } from "../lib/format";
import { byId, html, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import { start } from "../shell";

/** A lobby of `GET /api/lobbies`. */
interface Lobby {
  /** The lobby's own name, when the host gave it one. */
  name: string | null;
  hostName: string;
  tourney: boolean;
  players: number;
  openedAt: string;
}

// How often the list asks again: the API's `lobbiesCacheSeconds`, so every ask can be a fresh answer.
const lobbiesRefreshMs = 15000;

/** "12 min", "1 h 5 min": how long a lobby has been open. */
function openFor(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

function lobbyRow(l: Lobby): Html {
  return html`<li><span class="dot" aria-hidden="true"></span>
    <span class="what"><b>${l.name ?? `${l.hostName}'s lobby`}</b><small>Hosted by ${l.hostName}</small></span>
    ${l.tourney && html`<gb-chip title="A tourney lobby: counts more on the leaderboard">Tourney</gb-chip>`}
    <span class="figure"><b class="num">${l.players}</b><small>${plural(l.players, "player")}</small></span>
    <span class="figure"><b class="num">${openFor(l.openedAt)}</b><small>open</small></span></li>`;
}

function lobbyRows(lobbies: Lobby[]): Html {
  if (lobbies.length) return html`${lobbies.map(lobbyRow)}`;
  return html`<li><gb-empty>No ranked lobby is open in ${site.label(site.region)} right now.<a slot="action" href="https://discord.gg/sv9VVjh5pT">Ask on the Discord when the next one opens, or how to host</a></gb-empty></li>`;
}

async function livePage(): Promise<void> {
  const short = site.short(site.region);
  title(`${short} live lobbies`);
  const box = byId("lobbies");
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Each ask is numbered: an answer that comes back after a newer ask started is dropped, and only
  // the newest ask sets the next timer, so there's never more than one.
  let asked = 0;
  const refresh = async (): Promise<void> => {
    clearTimeout(timer);
    const ask = ++asked;
    try {
      const { lobbies } = await api<{ lobbies: Lobby[] }>(`lobbies?${inRegion()}`);
      if (ask !== asked) return;
      // The count in the tab's title, to see from another tab when a lobby opens.
      title(`${lobbies.length ? `(${lobbies.length}) ` : ""}${short} live lobbies`);
      loaded(box, lobbyRows(lobbies));
      byId("checked").textContent = `Checked ${new Date().toLocaleTimeString(undefined, { timeStyle: "short" })}.`;
    } catch (error) {
      if (ask !== asked) return;
      showError(box, error, "lobby list");
    }
    // Only while the page is in view: a background tab doesn't ask.
    if (!document.hidden) timer = setTimeout(() => void refresh(), lobbiesRefreshMs);
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
    else clearTimeout(timer);
  });
  await refresh();
}

start("live", livePage);
