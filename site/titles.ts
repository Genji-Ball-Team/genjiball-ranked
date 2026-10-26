// Titles (/api/titles): God and Demigod, the 1v1 tourney's winners. They keep their real place on the
// leaderboard; their row and profile stand out instead (site.css, "Titles"). God is light: a white rim
// running round the row, a glowing place, sparkles and motes. Demigod is dark red: a slower red rim
// turning the other way, a red haze, and red mist on the profile.
import "@genji-ball-team/ui/chip.js";
import { html, type Html } from "./lib/html";
import type { TitleName } from "./lib/types";

/** The class that gives a row or profile the title's look. */
export const titleLooks: Record<TitleName, string> = { God: "god", Demigod: "demi" };

/** The seal on a titled profile: what the title is, and what it was won with. */
export const titleSeals: Record<TitleName, [string, string]> = {
  God: ["Reigning God", "1v1 champion"],
  Demigod: ["Demigod", "1v1 top 4"],
};

export const titleChip = (title: TitleName): Html =>
  html`<gb-chip title-chip="${title === "God" ? "god" : "demigod"}">${title}</gb-chip>`;

/** The effect's randomly placed bits, as markup, for a leaderboard row or a profile. */
export function titleFx(title: TitleName, where: "row" | "profile"): string {
  const between = (a: number, b: number) => (a + Math.random() * (b - a)).toFixed(2);
  const bits = (n: number, cls: string, style: () => string) =>
    Array.from({ length: n }, () => `<i class="${cls}" style="${style()}"></i>`).join("");
  if (title === "Demigod") {
    if (where === "row") return '<i class="haze"></i>';
    return bits(
      4,
      "mist",
      () => `left:${between(-5, 80)}%;--w:${between(150, 220)}px;--t:${between(6, 9)}s;--dx:${between(-30, 20)}px;animation-delay:${between(0, 4)}s`,
    );
  }
  const motes = bits(
    where === "row" ? 8 : 16,
    "mote",
    () =>
      `left:${between(2, 98)}%;bottom:${between(-5, 30)}%;--s:${between(2, 4)}px;--t:${between(2.5, 5)}s;--dx:${between(-14, 14)}px;--dy:${between(-90, -40)}px;animation-delay:${between(0, 4)}s`,
  );
  const sparks =
    where === "row"
      ? bits(6, "spark", () => `left:${between(3, 95)}%;top:${between(5, 80)}%;--t:${between(1.6, 3)}s;animation-delay:${between(0, 3)}s`)
      : "";
  return motes + sparks;
}
