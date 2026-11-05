// What the pages share about duels (the Duels tab, duel stats, compare, the player page): links and
// the tab's icon.
import { inRegion } from "./api";
import { html, raw, type Html } from "./html";
import { site } from "./site";

/** The Duels tab, or one player's duel stats there, in this page's region. */
export const duelsLink = (playerId?: number, region = site.region): string =>
  playerId === undefined ? `/duels?${inRegion(region)}` : `/duels?player=${playerId}&${inRegion(region)}`;

/**
 * Two crossed blades, drawn like the library's icons (a 1.75px rounded line on a 24px grid, in
 * `currentColor`): the library has no icon for duels.
 */
export const duelIcon = (): Html =>
  html`<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${raw(
    '<g fill="currentColor" fill-opacity="0.22" stroke="none"><path d="M4 4l2.4.6 10 10-1.8 1.8-10-10zM20 4l-2.4.6-10 10 1.8 1.8 10-10z"/></g><path d="M4 4l2.4.6 10 10M4 4l.6 2.4 10 10M20 4l-2.4.6-10 10M20 4l-.6 2.4-10 10M13.4 18.2l4.8-4.8M10.6 18.2l-4.8-4.8M17.4 17.4l2.6 2.6M6.6 17.4 4 20"/>',
  )}</svg>`;

/** A rating change as a signed number, or nothing for none. */
export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** "8–3": wins and losses. */
export const record = (wins: number, losses: number): string => `${wins}–${losses}`;
