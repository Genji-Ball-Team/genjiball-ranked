// Duels: enter 1v1 results by hand (one or a pasted list), see what they'll do to ratings first, save
// them (they count from now), and undo one by voiding its match.
import { h, longTime } from "./dom";
import { app, headerRegion, messageOf, post, regionLabel, regionOptions, staleNote } from "./state";
import { btn, chip, confirmAction, empty, head, lede, note, notify, section, seg, table, type View } from "./ui";

interface DuelLine {
  winner: string;
  loser: string;
  winnerScore: number;
  loserScore: number;
}

interface PlannedDuel {
  winner: { id: number | null; name: string };
  loser: { id: number | null; name: string };
  winnerScore: number;
  loserScore: number;
  rated: boolean;
  winnerBefore: number;
  winnerAfter: number;
  loserBefore: number;
  loserAfter: number;
}

interface PublicDuel {
  id: number;
  playedAt: string;
  winnerScore: number;
  loserScore: number;
  rated: boolean;
  winner: { id: number; name: string; ratingBefore: number | null; ratingAfter: number | null };
  loser: { id: number; name: string; ratingBefore: number | null; ratingAfter: number | null };
}

/**
 * One duel a line: `Nachos 15-12 Fealthy` (either order: the higher score won). Returns the duels,
 * or the first line it can't read.
 */
export function parseDuels(text: string): DuelLine[] | string {
  const duels: DuelLine[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const m = /^(.+?)\s+(\d+)\s*[-–—:]\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) return `Line ${i + 1} isn't "Name 15-12 Name": ${line}`;
    const [a, b] = [Number(m[2]), Number(m[3])];
    if (a === b) return `Line ${i + 1} is a draw: one player must win`;
    duels.push(a > b ? { winner: m[1]!, loser: m[4]!, winnerScore: a, loserScore: b } : { winner: m[4]!, loser: m[1]!, winnerScore: b, loserScore: a });
  }
  if (!duels.length) return "Type at least one duel.";
  return duels;
}

const change = (before: number, after: number): HTMLElement => {
  const d = after - before;
  return h("span", { class: d > 0 ? "up" : d < 0 ? "down" : "muted" }, `${before} → ${after} (${d > 0 ? "+" : ""}${d})`);
};

export const duelsView: View = async (view) => {
  let region = headerRegion();
  const input = h("textarea", {
    rows: 6,
    class: "duel-input",
    "aria-label": "Duels, one a line",
    placeholder: "Nachos 15-12 Fealthy\nPlayer 1 9-15 Player 2",
    spellcheck: "false",
    autocomplete: "off",
  });
  const out = h("div");
  const recent = h("div");

  const showRecent = async (): Promise<void> => {
    try {
      const res = await fetch(`/api/duels?region=${encodeURIComponent(region)}`, { cache: "no-store" });
      const { duels } = (await res.json()) as { duels: PublicDuel[] };
      recent.replaceChildren(
        duels.length
          ? table(
              ["When", "Winner", "Score", "Loser", "Rating", { sr: "Actions" }],
              duels.map((d) =>
                h(
                  "tr",
                  null,
                  h("td", null, longTime(d.playedAt)),
                  h("td", null, h("a", { href: `#/players/${d.winner.id}` }, d.winner.name)),
                  h("td", null, `${d.winnerScore}-${d.loserScore}`),
                  h("td", null, h("a", { href: `#/players/${d.loser.id}` }, d.loser.name)),
                  h(
                    "td",
                    null,
                    d.rated && d.winner.ratingBefore !== null && d.winner.ratingAfter !== null
                      ? `+${d.winner.ratingAfter - d.winner.ratingBefore} / ${(d.loser.ratingAfter ?? 0) - (d.loser.ratingBefore ?? 0)}`
                      : chip("not rated", "plain", "Past the pair's rated duels for the day"),
                  ),
                  h(
                    "td",
                    null,
                    btn(
                      "Undo",
                      async () => {
                        const ok = await confirmAction(
                          "Undo this duel?",
                          `${d.winner.name} ${d.winnerScore}-${d.loserScore} ${d.loser.name} is taken off, and ratings are recalculated as if it never happened.`,
                          "Undo duel",
                        );
                        if (!ok) return;
                        try {
                          const r = await post<{ ratingsStale?: boolean }>(`matches/${d.id}/void`, { reason: "Duel undone" });
                          notify(`Duel undone.${staleNote(r)}`);
                        } catch (e) {
                          notify(`Undo: ${messageOf(e)}`, "error");
                        }
                        await showRecent();
                      },
                      { small: true, tone: "danger" },
                    ),
                  ),
                ),
              ),
            )
          : empty(`No duels in ${regionLabel(region)} yet.`),
      );
    } catch (e) {
      recent.replaceChildren(h("p", { class: "error" }, messageOf(e)));
    }
  };

  // Each new name gets a box: ticked, it's added as a new player when saved.
  const newBoxes = new Map<string, HTMLInputElement>();

  const preview = async (): Promise<void> => {
    const duels = parseDuels(input.value);
    if (typeof duels === "string") return out.replaceChildren(h("p", { class: "error" }, duels));
    try {
      const res = await post<{ duels: PlannedDuel[]; newPlayers: string[] }>("duels/preview", { region, duels });
      newBoxes.clear();
      const newList = res.newPlayers.map((name) => {
        const box = h("input", { type: "checkbox" });
        newBoxes.set(name, box);
        return h("li", null, h("label", null, box, " Add ", h("b", null, name), " as a new player"));
      });
      out.replaceChildren(
        table(
          ["Winner", "Score", "Loser", "Winner's rating", "Loser's rating"],
          res.duels.map((d) =>
            h(
              "tr",
              null,
              h("td", null, d.winner.name, d.winner.id === null && " ", d.winner.id === null && chip("new", "warn")),
              h("td", null, `${d.winnerScore}-${d.loserScore}`),
              h("td", null, d.loser.name, d.loser.id === null && " ", d.loser.id === null && chip("new", "warn")),
              h("td", null, d.rated ? change(d.winnerBefore, d.winnerAfter) : chip("not rated", "plain", "Past the pair's rated duels for the day")),
              h("td", null, d.rated ? change(d.loserBefore, d.loserAfter) : ""),
            ),
          ),
        ),
        newList.length
          ? h(
              "div",
              { class: "callout warn" },
              h("p", null, "These names aren't a player yet. Check the spelling: it must be their in-game name exactly, so their lobbies count for the same player later."),
              h("ul", { class: "plain" }, newList),
            )
          : "",
        h("div", { class: "actions" }, btn(`Save ${res.duels.length === 1 ? "duel" : `${res.duels.length} duels`} in ${regionLabel(region)}`, save, { variant: "primary" })),
      );
    } catch (e) {
      out.replaceChildren(h("p", { class: "error" }, messageOf(e)));
    }
  };

  const save = async (): Promise<void> => {
    const duels = parseDuels(input.value);
    if (typeof duels === "string") return notify(duels, "error");
    const newPlayers = [...newBoxes].filter(([, box]) => box.checked).map(([name]) => name);
    try {
      const res = await post<{ duels: unknown[]; ratingsStale?: boolean }>("duels", { region, duels, newPlayers });
      notify(`${res.duels.length === 1 ? "Duel" : `${res.duels.length} duels`} saved.${staleNote(res)}`);
      input.value = "";
      out.replaceChildren();
      await showRecent();
    } catch (e) {
      notify(`Save: ${messageOf(e)}`, "error");
    }
  };

  view.append(
    head("Duels"),
    lede(
      "Enter 1v1 results, one a line, like \"Nachos 15-12 Fealthy\" (either order: the higher score wins). They count from the moment you save, in the region you pick, and change that region's rating. Preview first to check names and rating changes.",
    ),
    h(
      "div",
      { class: "duel-form" },
      seg(
        regionOptions(),
        region,
        (value) => {
          region = value;
          out.replaceChildren();
          void showRecent();
        },
        "Region",
      ),
      input,
      h("div", { class: "actions" }, btn("Preview", preview)),
    ),
    out,
    section("Recent duels"),
    note("Undo takes a duel off and recalculates ratings from it, like voiding a match."),
    recent,
  );
  if (!app.regions.some((r) => r.id === region)) region = app.regions[0]?.id ?? region;
  await showRecent();
};
