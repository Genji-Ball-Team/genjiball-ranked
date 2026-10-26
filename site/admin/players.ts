// Players: find one by name or old name, rename, mark as alt, merge and undo merges.
import { h, count, time } from "./dom";
import { api, app, post, regionLabel, setQuery, staleNote, messageOf } from "./state";
import type { AdminPlayer, FoundPlayer, Merge } from "./types";
import {
  ask, btn, chip, confirmAction, crumb, empty, fact, filterBox, head, lede, notify, playerPicker, run, searchField, section, table, type View,
} from "./ui";

export const playersView: View = async (view, _params, query) => {
  const input = filterBox("Find a player", query.get("q") ?? "", "Name or old name");
  input.dataset.autofocus = "";
  const results = h("div");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = async (): Promise<void> => {
    const q = input.value.trim();
    setQuery({ q });
    if (q.length < 2) return results.replaceChildren(empty("Type at least two letters of a name, old names too."));
    try {
      const { players } = await api<{ players: FoundPlayer[] }>(`players?search=${encodeURIComponent(q)}`);
      if (input.value.trim() !== q) return;
      results.replaceChildren(
        players.length
          ? h(
              "ul",
              { class: "player-list" },
              players.map((p) =>
                h("li", null, h("a", { href: `#/players/${p.id}` }, h("b", null, p.name), h("small", null, `#${p.id}`), h("span", { class: "muted" }, p.aliases.filter((a) => a !== p.name).join(", ")))),
              ),
            )
          : empty("No player has that name."),
      );
    } catch (e) {
      results.replaceChildren(h("p", { class: "error" }, messageOf(e)));
    }
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void search(), 250);
  });
  const { merges } = await api<{ merges: Merge[] }>("merges");
  view.append(
    head("Players"),
    lede(
      "When a player changes name, merge the old name into the new one: their names, matches and ratings become one player. A merge can be undone. It only joins names; it doesn't tell who is behind an account.",
    ),
    searchField("Find a player", input, true),
    results,
    section("Recent merges"),
    mergeTable(merges),
  );
  await search();
};

function mergeTable(merges: Merge[]): HTMLElement {
  if (!merges.length) return empty("No merges yet.");
  return table(
    ["Merged", "Into", "Names moved", "By", { sr: "Actions" }],
    merges.map((m) =>
      h(
        "tr",
        { class: m.undoneAt ? "removed" : null },
        h("td", null, h("a", { href: `#/players/${m.from.id}` }, m.from.name)),
        h("td", null, h("a", { href: `#/players/${m.into.id}` }, m.into.name)),
        h("td", { class: "muted" }, m.aliases.join(", ")),
        h(
          "td",
          null,
          m.mergedBy,
          ", ",
          time(m.mergedAt),
          m.undoneAt && h("small", { class: "muted block" }, `undone by ${m.undoneBy}, `, time(m.undoneAt)),
        ),
        h(
          "td",
          { class: "actions" },
          !m.undoneAt &&
            btn(
              "Undo",
              async () => {
                if (await confirmAction(`Undo merging ${m.from.name} into ${m.into.name}?`, `${m.from.name} gets their names and matches back, and the ratings are rebuilt.`, "Undo merge")) {
                  await run("Undo merge", async () => `${m.from.name} is their own player again.${staleNote(await post<{ ratingsStale?: boolean }>(`merges/${m.id}/undo`))}`);
                }
              },
              { small: true, variant: "ghost" },
            ),
        ),
      ),
    ),
  );
}

export const playerView: View = async (view, [id]) => {
  const { player: p, merges } = await api<{ player: AdminPlayer; merges: Merge[] }>(`players/${id}`);
  const rename = btn("Set display name", async () => {
    const res = await ask({
      title: `Display name of ${p.name}`,
      text: "Uploads don't change a name an admin set. The rank tags keep the name the game last showed.",
      fields: [
        { name: "name", label: "Display name", value: p.name, maxlength: 100 },
        { name: "follow", label: "Follow the logs instead", type: "checkbox", value: !p.nameFixed, hint: "The name they were last seen with." },
      ],
      submit: (v) => {
        if (!v.follow && !v.name) throw new Error("Enter a name, or follow the logs.");
        return post<{ player: AdminPlayer }>(`players/${p.id}/name`, { name: v.follow ? null : v.name });
      },
    });
    if (res) {
      notify(`Player #${p.id} is ${res.player.name}.`);
      await app.refresh();
    }
  });
  const merge = btn(
    "Merge into…",
    async () => {
      const res = await ask({
        title: `Merge ${p.name} into another player`,
        text: `${p.name}'s names and matches become the other player's, who keeps their id. Use it when one person played under both names.`,
        fields: [{ name: "into", render: () => playerPicker(p.id) }],
        ok: "Merge",
        danger: true,
        submit: async ({ into }) => {
          if (!into) throw new Error("Pick the player to merge into.");
          return { into, res: await post<{ ratingsStale?: boolean }>(`players/${p.id}/merge`, { into }) };
        },
      });
      if (res) {
        notify(`${p.name} merged.${staleNote(res.res)}`);
        location.hash = `#/players/${res.into}`;
      }
    },
    { tone: "danger" },
  );
  const alt = btn(p.alt ? "Not an alt" : "Mark as alt", async () => {
    const ok = p.alt
      ? await confirmAction(`${p.name} isn't an alt?`, `${p.name} goes back on the leaderboard with a place, like anyone.`, "Not an alt")
      : await confirmAction(
          `Mark ${p.name} as an alt?`,
          'They\'re rated as normal and their profile and matches stay public, with an "alt" tag. They aren\'t on the leaderboard (nor the in-game top 10 or the Discord bot\'s) and have no place there. Nothing is recomputed.',
          "Mark as alt",
        );
    if (ok) {
      await run("Alt", async () => ((await post<{ player: AdminPlayer }>(`players/${p.id}/alt`, { alt: !p.alt })).player.alt ? `${p.name} is an alt.` : `${p.name} isn't an alt.`));
    }
  });
  view.append(
    head(
      h("div", null, crumb("#/players", "Players"), h("h1", null, p.name, " ", h("small", { class: "muted id" }, `#${p.id}`), p.alt && chip("Alt"))),
      h("a", { class: "button", href: `/player?id=${p.id}`, target: "_blank", rel: "noopener" }, "Public page ↗"),
      !p.mergedInto && rename,
      !p.mergedInto && alt,
      !p.mergedInto && merge,
    ),
  );
  if (p.mergedInto) {
    view.append(h("p", { class: "callout" }, "Merged into ", h("a", { href: `#/players/${p.mergedInto}` }, `player #${p.mergedInto}`), ". Undo the merge below to split them again."));
  }
  view.append(
    h(
      "dl",
      { class: "fact-grid" },
      fact("Matches", p.matches),
      fact("Name", p.nameFixed ? "Set by an admin" : "From the logs"),
      fact("Leaderboard", p.alt ? "Hidden: an alt" : "Listed"),
      fact("First seen", time(p.createdAt)),
    ),
  );

  view.append(section("Ratings"));
  view.append(
    p.ratings.length
      ? table(
          ["Region", "Rating", "Rounds", "Won", "Last played"],
          p.ratings.map((r) =>
            h("tr", null, h("td", null, regionLabel(r.region)), h("td", { class: "num" }, Math.round(r.rating)), h("td", { class: "num" }, r.rounds), h("td", { class: "num" }, r.wins), h("td", null, time(r.lastPlayedAt))),
          ),
          [1, 2, 3],
        )
      : empty("No rated rounds yet."),
  );

  view.append(section(count(p.aliases.length, "name", "names")));
  view.append(
    table(
      ["Name", "First seen", "Last seen"],
      p.aliases.map((a) => h("tr", null, h("td", null, h("b", null, a.name), a.name === p.name && chip("Display")), h("td", null, time(a.firstSeenAt, "–")), h("td", null, time(a.lastSeenAt, "–")))),
    ),
  );

  view.append(section("Merges"), mergeTable(merges));
};
