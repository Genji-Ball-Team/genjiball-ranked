// Titles (/api/titles): God and Demigod, the 1v1 tourney's winners. They keep their real place on the
// leaderboard and stand out there instead: the UI library's title rows and chips (brand.md, Colour).
import "@genji-ball-team/ui/chip.js";
import { html, type Html } from "./lib/html";
import type { TitleName } from "./lib/types";

/** A title's name in the UI library (`data-title` on a leaderboard row, `title-chip` on a chip). */
export const titleRow: Record<TitleName, "god" | "demigod"> = { God: "god", Demigod: "demigod" };

/** The seal on a titled profile: what the title is, and what it was won with. */
export const titleSeals: Record<TitleName, [string, string]> = {
  God: ["Reigning God", "1v1 champion"],
  Demigod: ["Demigod", "1v1 top 4"],
};

export const titleChip = (title: TitleName): Html => html`<gb-chip title-chip="${titleRow[title]}">${title}</gb-chip>`;
