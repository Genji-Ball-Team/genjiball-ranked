// The action log: every change an admin makes.
import { h, time } from "./dom";
import { api, setQuery } from "./state";
import type { AdminAction } from "./types";
import { empty, filterBox, head, lede, searchField, table, type View } from "./ui";

const words = (action: string): string => action.replaceAll("_", " ");

function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  if (typeof detail !== "object") return String(detail);
  return Object.entries(detail as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${v === null ? "none" : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export function actionTable(actions: AdminAction[]): HTMLElement {
  if (!actions.length) return empty("Nothing yet.");
  return table(
    ["When", "Admin", "Action", "Match", "Host", "Detail"],
    actions.map((a) =>
      h(
        "tr",
        null,
        h("td", null, time(a.at)),
        h("td", null, a.admin),
        h("td", null, h("b", null, words(a.action))),
        h("td", null, a.matchId && h("a", { href: `#/matches/${a.matchId}` }, `#${a.matchId}`)),
        h("td", null, a.hostId && `#${a.hostId}`),
        h("td", { class: "detail" }, detailText(a.detail)),
      ),
    ),
  );
}

export const logView: View = async (view, _params, query) => {
  const { actions } = await api<{ actions: AdminAction[] }>("actions");
  const filter = filterBox("Filter the log", query.get("q") ?? "", "Filter by admin, action or detail");
  filter.dataset.autofocus = "";
  const box = h("div");
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    setQuery({ q });
    box.replaceChildren(
      actionTable(
        q ? actions.filter((a) => [a.admin, words(a.action), detailText(a.detail), String(a.matchId ?? "")].some((s) => s.toLowerCase().includes(q))) : actions,
      ),
    );
  };
  filter.addEventListener("input", draw);
  view.append(head("Action log"), lede("Every change an admin makes, newest first."), h("div", { class: "toolbar" }, searchField("Filter", filter)), box);
  draw();
};
