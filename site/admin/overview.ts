// The overview: what needs doing, at a glance.
import { h } from "./dom";
import { actionTable } from "./log";
import { matchTable } from "./matches";
import { api, regionLabel } from "./state";
import { tourneyTodos } from "./tourneys";
import type { AdminAction, AdminMatch, AdminTourney } from "./types";
import { empty, head, note, section, type View } from "./ui";

const tile = (label: string, value: number, href: string, kind = ""): HTMLElement =>
  h("a", { class: `tile ${kind}`, href }, h("b", { class: "num" }, value), h("span", null, label));

export const overview: View = async (view) => {
  const [{ matches }, { tourneys }, { actions }] = await Promise.all([
    api<{ matches: AdminMatch[] }>("matches?status=review"),
    api<{ tourneys: AdminTourney[] }>("tourneys"),
    api<{ actions: AdminAction[] }>("actions"),
  ]);
  const active = tourneys.filter((t) => t.status === "scheduled" || t.status === "live");
  const todos = tourneys.flatMap((t) => tourneyTodos(t).map((todo) => ({ ...todo, tourney: t })));
  view.append(
    head("Overview"),
    h(
      "div",
      { class: "tiles" },
      tile("In review", matches.length, "#/matches?status=review", matches.length ? "warn" : ""),
      tile("Tourney jobs", todos.length, "#/tourneys", todos.length ? "warn" : ""),
      tile("Upcoming tourneys", active.length, "#/tourneys"),
    ),
  );

  view.append(section("Review queue", h("a", { href: "#/matches?status=review" }, "All matches")));
  if (!matches.length) view.append(empty("Nothing to review. New uploads that need a look show up here."));
  else view.append(matchTable(matches.slice(0, 8)));
  if (matches.length > 8) view.append(note(h("a", { href: "#/matches?status=review" }, `${matches.length - 8} more in review`)));

  view.append(section("Tourney jobs"));
  if (!todos.length) view.append(empty("Every tourney is set up."));
  else {
    view.append(
      h(
        "ul",
        { class: "todos" },
        todos.map((todo) =>
          h("li", null, h("a", { href: `#/tourneys/${todo.tourney.id}` }, h("span", null, todo.text), h("small", null, todo.tourney.name, " · ", regionLabel(todo.tourney.region)))),
        ),
      ),
    );
  }

  view.append(section("Recent actions", h("a", { href: "#/log" }, "Full log")));
  view.append(actionTable(actions.slice(0, 8)));
};
