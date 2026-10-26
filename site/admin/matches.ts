// Matches: the list with its filters, a match's page, and the accept / reject / void actions.
import { site } from "../lib/site";
import { h, count, longTime, time } from "./dom";
import { api, app, post, regionLabel, setQuery, staleNote } from "./state";
import type { AdminMatch } from "./types";
import {
  ask, btn, chip, confirmAction, crumb, empty, fact, head, notify, reasonText, regionChip, run, searchField, section, seg,
  statusChip, table, filterBox, type View,
} from "./ui";

const statuses: [string, string][] = [
  ["review", "Review"],
  ["accepted", "Accepted"],
  ["void", "Void"],
  ["rejected", "Rejected"],
];

export const matchesView: View = async (view, _params, query) => {
  const status = query.get("status") ?? "review";
  // The header's region, unless the filter picked another (or "all").
  const picked = query.get("region") ?? site.region;
  const region = picked === "all" ? "" : picked;
  const { matches } = await api<{ matches: AdminMatch[] }>(`matches?status=${status}${region ? `&region=${region}` : ""}`);
  const filter = filterBox("Filter matches", query.get("q") ?? "", "Filter by id, host or player");
  filter.dataset.autofocus = "";
  const list = h("div");
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    setQuery({ q });
    const shown = q ? matches.filter((m) => [String(m.id), m.hostName, ...m.players].some((s) => s.toLowerCase().includes(q))) : matches;
    list.replaceChildren(
      shown.length ? matchTable(shown) : empty(q ? "No match fits the filter." : `No ${status} matches${region ? ` in ${regionLabel(region)}` : ""}.`),
    );
  };
  filter.addEventListener("input", draw);
  const go = (values: Record<string, string>) => {
    setQuery(values);
    void app.refresh();
  };
  view.append(
    head("Matches"),
    h(
      "div",
      { class: "toolbar" },
      seg(statuses, status, (s) => go({ status: s }), "Status"),
      seg([["all", "All regions"], ...app.regions.map((r): [string, string] => [r.id, r.id.toUpperCase()])], picked, (r) => go({ region: r === site.region ? "" : r }), "Region"),
      searchField("Filter", filter),
    ),
    list,
  );
  draw();
  if (matches.length >= 100) view.append(h("p", { class: "note" }, "Only the newest 100 are listed."));
};

export function matchTable(matches: AdminMatch[]): HTMLElement {
  return table(
    ["Match", "Played", "Host", "Players", "Notes", { sr: "Actions" }],
    matches.map((m) =>
      h(
        "tr",
        null,
        h("td", null, h("a", { class: "id", href: `#/matches/${m.id}` }, `#${m.id}`), " ", regionChip(m.region)),
        h("td", null, time(m.playedAt)),
        h("td", null, m.hostName),
        h("td", { class: "players", title: m.players.join(", ") }, h("b", { class: "num" }, m.players.length), " ", h("span", { class: "muted" }, m.players.join(", "))),
        h("td", { class: "notes" }, matchNotes(m)),
        h("td", { class: "actions" }, matchButtons(m)),
      ),
    ),
  );
}

function matchNotes(m: AdminMatch): HTMLElement[] {
  const notes: (HTMLElement | false | null)[] = [
    ...m.reviewReasons.map((r) => chip(reasonText(r), "warn")),
    m.rejection &&
      chip(m.rejection.code === "admin" ? `Rejected: ${m.rejection.message || "by an admin"}` : m.rejection.message || m.rejection.code, "bad", m.rejection.code),
    m.tournament && chip("Tourney"),
    !m.complete && chip("Incomplete", "plain", "The log has no MATCH_END"),
    m.status === "accepted" && !m.rated && chip("Not rated"),
  ];
  return notes.filter((n): n is HTMLElement => Boolean(n));
}

function matchButtons(m: AdminMatch, big = false): HTMLElement[] {
  const small = !big;
  const buttons: HTMLElement[] = [];
  if (m.status === "review") {
    buttons.push(
      btn("Accept", () => matchAction(m, "accept"), { variant: "primary", small }),
      btn("Reject", () => matchAction(m, "reject"), { small }),
    );
  }
  if (m.status === "rejected" && m.rejection?.code === "admin") buttons.push(btn("Accept", () => matchAction(m, "accept"), { small }));
  if (m.status === "accepted") buttons.push(btn("Void", () => matchAction(m, "void"), { small }));
  if (m.status === "void") buttons.push(btn("Un-void", () => matchAction(m, "unvoid"), { small }));
  return buttons;
}

const actionWords: Record<string, string> = { accept: "accepted", reject: "rejected", void: "voided", unvoid: "un-voided" };

async function matchAction(m: AdminMatch, action: "accept" | "reject" | "void" | "unvoid"): Promise<void> {
  const send = async (body: unknown): Promise<string> => {
    const res = await post<{ match: AdminMatch; ratingsStale?: boolean }>(`matches/${m.id}/${action}`, body);
    return `Match #${m.id} ${actionWords[action]}: it's ${res.match.status}.${staleNote(res)}`;
  };
  if (action === "accept" || action === "unvoid") return run(`Match #${m.id}`, () => send({}));
  const message = await ask<string>({
    title: `${action === "reject" ? "Reject" : "Void"} match #${m.id}?`,
    text:
      action === "reject"
        ? "It won't be rated or shown. You can accept it later if you change your mind."
        : "It stays listed as void and its rounds stop counting. You can un-void it.",
    fields: [{ name: "reason", label: "Reason (optional)", type: "textarea", maxlength: 500, placeholder: "Shown in the action log" }],
    ok: action === "reject" ? "Reject" : "Void",
    danger: true,
    submit: ({ reason }) => send(reason ? { reason } : {}),
  });
  if (message) {
    notify(message);
    await app.refresh();
  }
}

export const matchView: View = async (view, [id]) => {
  const { match: m } = await api<{ match: AdminMatch }>(`matches/${id}`);
  view.append(head(h("div", null, crumb("#/matches", "Matches"), h("h1", null, `Match #${m.id} `, statusChip(m.status))), matchButtons(m, true)));
  view.append(
    h(
      "dl",
      { class: "fact-grid" },
      fact("Region", regionLabel(m.region)),
      fact("Played", h("span", { title: longTime(m.playedAt) }, longTime(m.playedAt))),
      fact("Host", h("a", { href: "#/hosts" }, m.hostName), h("small", null, ` #${m.hostId}`)),
      fact("Map", m.map ?? "–"),
      fact("Preset", m.preset ?? "–"),
      fact("Log lines", m.lineCount),
      fact("Rated", m.rated ? "Yes" : "No"),
      fact("Complete", m.complete ? "Yes" : "No, no MATCH_END"),
    ),
  );

  if (m.reviewReasons.length || m.rejection) {
    view.append(section(m.status === "review" ? "Why it's in review" : "Notes"));
    view.append(
      h(
        "ul",
        { class: "reasons" },
        m.reviewReasons.map((r) =>
          h("li", null, reasonText(r), r.startsWith("tourney_") && h("small", null, "Link it to its lobby from the tourney's page, then accept it. Or accept it as a ranked match.")),
        ),
        m.rejection && h("li", { class: "bad" }, m.rejection.message || "Rejected", h("small", null, m.rejection.code)),
      ),
    );
  }

  view.append(section(count(m.players.length, "player", "players")));
  view.append(h("ul", { class: "names" }, m.players.map((p) => h("li", null, p))));

  view.append(section("More"));
  const tourneyButton = btn(m.tournament ? "Make it a ranked match" : "Make it a tourney match", async () => {
    const ok = await confirmAction(
      m.tournament ? `Make match #${m.id} a ranked match?` : `Make match #${m.id} a tourney match?`,
      m.tournament
        ? "It's rated as a normal match. A match a tourney lobby links can't be changed here: unlink it from the lobby."
        : "Its standings are rated with the tourney weight and caps. Usually you link it to its lobby instead.",
      "Change",
      false,
    );
    if (ok) {
      await run(`Match #${m.id}`, async () => `Match #${m.id} is ${m.tournament ? "a ranked" : "a tourney"} match.${staleNote(await post<{ ratingsStale?: boolean }>(`matches/${m.id}/tournament`, { tournament: !m.tournament }))}`);
    }
  });
  view.append(
    h(
      "div",
      { class: "more" },
      h(
        "div",
        null,
        h("b", null, "Region"),
        h("p", { class: "muted" }, "If the host uploaded it under the wrong region. Its ratings leave this region and it's rated in the other."),
        h(
          "div",
          { class: "row" },
          app.regions
            .filter((r) => r.id !== m.region)
            .map((r) =>
              btn(`Move to ${r.label}`, async () => {
                const ok = await confirmAction(`Move match #${m.id} to ${r.label}?`, `Its ratings leave ${regionLabel(m.region)} and it's rated in ${r.label}.`, "Move");
                if (ok) {
                  await run(`Match #${m.id}`, async () => `Match #${m.id} is in ${r.label}.${staleNote(await post<{ ratingsStale?: boolean }>(`matches/${m.id}/region`, { region: r.id }))}`);
                }
              }),
            ),
        ),
      ),
      h("div", null, h("b", null, "Tourney"), h("p", { class: "muted" }, m.tournament ? "It counts as a tourney match." : "It counts as a ranked match."), h("div", { class: "row" }, tourneyButton)),
      (m.status === "accepted" || m.status === "void") &&
        h("div", null, h("b", null, "Public page"), h("p", { class: "muted" }, "What players see."), h("a", { href: `/match?id=${m.id}`, target: "_blank", rel: "noopener" }, "Open match page ↗")),
    ),
  );
};
