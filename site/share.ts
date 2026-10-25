// Share: a button on the player, match and compare pages that opens the share sheet (share-sheet.ts),
// a card of what the page shows to post anywhere. The page hands over plain data (`attach(box, card)`).
// The sheet and its card styles are most of the page's script, so they load only once the button is
// pointed at, focused or pressed.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/icon.js";
import type { GbButton } from "@genji-ball-team/ui/button.js";
import type { ShareCard } from "./cards/types";
import { html, render } from "./lib/html";

export type { ComparedPlayer, CompareCard, MatchCard, MatchRow, PlayerCard, ShareCard } from "./cards/types";

type Sheet = typeof import("./share-sheet");

let current: ShareCard | null = null;
let loading: Promise<Sheet> | undefined;

function load(): Promise<Sheet> {
  loading ??= import("./share-sheet").catch((error: unknown) => {
    // Tried again on the next press (a deploy may have replaced the file mid-visit).
    loading = undefined;
    throw error;
  });
  return loading;
}

/**
 * Puts a Share button at the end of `box` (once), for `card`. Again with a newer card (more loaded)
 * updates it, and redraws the image when the sheet is open; null hides the button.
 */
export function attach(box: HTMLElement, card: ShareCard | null): void {
  let button = box.querySelector<GbButton>(".share-button");
  if (!button) {
    button = document.createElement("gb-button") as GbButton;
    button.className = "share-button";
    button.setAttribute("aria-label", "Share");
    render(button, html`<gb-icon name="share"></gb-icon><span class="share-label">Share</span>`);
    const warm = () => void load().catch(() => {});
    button.addEventListener("pointerenter", warm, { once: true });
    button.addEventListener("focus", warm, { once: true });
    button.addEventListener("click", () => {
      load()
        .then((sheet) => current && sheet.showSheet(current))
        .catch((error: unknown) => console.error("share sheet", error));
    });
    box.append(button);
  }
  current = card;
  button.hidden = !card;
  void loading?.then((sheet) => sheet.setCard(card)).catch(() => {});
}
