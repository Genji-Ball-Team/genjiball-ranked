// Tools: dry-run a log through the parser, and mark a region's ratings for a recompute.
import { site } from "../lib/site";
import { h, count } from "./dom";
import { api, hosts, messageOf, post, regionLabel, regionOptions } from "./state";
import type { ParseAnswer } from "./types";
import { ask, btn, chip, fact, head, matchPreview, notify, reasonText, statusChip, type View } from "./ui";

const prompt = "Drop a Workshop log here, or pick one";

export const toolsView: View = async (view) => {
  const hostList = await hosts();
  view.append(head("Tools"));

  // Dry-run parse.
  const file = h("input", { type: "file", accept: ".txt,text/plain", required: true });
  const fileName = h("span", { class: "muted" }, prompt);
  file.addEventListener("change", () => (fileName.textContent = file.files?.[0]?.name ?? prompt));
  const drop = h("label", { class: "dropzone" }, file, h("b", null, "Log file"), fileName);
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("drop");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drop"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drop");
    if (e.dataTransfer?.files[0]) {
      file.files = e.dataTransfer.files;
      file.dispatchEvent(new Event("change"));
    }
  });
  const host = h(
    "select",
    null,
    [["", "No host: judge as trusted, nothing stored"], ...hostList.map((x) => [String(x.id), `${x.name} (${x.trust})`])].map(([v, l]) => h("option", { value: v }, l)),
  );
  const region = h("select", null, regionOptions(["", "The host's home region"]).map(([v, l]) => h("option", { value: v }, l)));
  const legacy = h("input", { type: "checkbox" });
  const result = h("div");
  const parse = btn(
    "Parse",
    async () => {
      const picked = file.files?.[0];
      if (!picked) return notify("Pick a log file first.", "error");
      const params = new URLSearchParams();
      if (host.value) params.set("host", host.value);
      if (region.value) params.set("region", region.value);
      if (legacy.checked) params.set("legacy", "1");
      try {
        result.replaceChildren(parseResult(await api<ParseAnswer>(`parse?${params.toString()}`, { method: "POST", raw: picked })));
      } catch (e) {
        result.replaceChildren(h("p", { class: "callout bad" }, messageOf(e)));
      }
    },
    { variant: "primary" },
  );
  view.append(
    h(
      "gb-panel",
      { label: "Dry-run a log", class: "tool" },
      h("p", { class: "muted" }, "What an upload of this file would do and what the parser read. Nothing is written."),
      drop,
      h("div", { class: "fields" }, h("gb-field", { label: "As if uploaded by" }, host), h("gb-field", { label: "Region" }, region)),
      h("gb-field", { label: "Old v1.3.2 log" }, legacy),
      h("small", { class: "hint" }, "Read it as the legacy import would. Needs a host."),
      h("div", { class: "row" }, parse),
      result,
    ),
  );

  // Recompute.
  view.append(
    h(
      "gb-panel",
      { label: "Recompute ratings", class: "tool" },
      h("p", { class: "muted" }, "Marks a region's ratings stale, from its first match or from one match on. The cron recomputes them within 10 minutes; the site shows a banner meanwhile."),
      h("div", { class: "row" }, btn("Recompute…", recompute)),
    ),
  );
};

async function recompute(): Promise<void> {
  const res = await ask({
    title: "Recompute ratings",
    fields: [
      { name: "region", label: "Region", type: "select", required: true, value: site.region, options: regionOptions() },
      { name: "from", label: "From match (optional)", type: "number", min: 1, inputmode: "numeric", placeholder: "From the first match", hint: "Matches before it keep their ratings.", preview: matchPreview },
    ],
    ok: "Recompute",
    danger: true,
    submit: (v) => post<{ region: string; from?: number | null }>(`ratings/recompute?region=${v.region ?? ""}${v.from ? `&from=${v.from}` : ""}`),
  });
  if (res) notify(`${regionLabel(res.region)} ratings will be recomputed${res.from ? ` from match #${res.from}` : ""}.`);
}

function parseResult(r: ParseAnswer): HTMLElement {
  const u = r.upload;
  const ok = u.status < 300;
  const box = h("div", { class: "parse" });
  box.append(
    h(
      "p",
      { class: `callout ${ok ? "good" : "bad"}` },
      h("b", null, `${u.status} ${u.result ?? u.error ?? ""}`),
      " ",
      u.message ?? (ok ? `An upload would answer ${u.result}${u.matches ? `, with ${count(u.matches.length, "match", "matches")}` : ""}.` : ""),
      r.duplicateOf ? ` It's the same file as match #${r.duplicateOf}.` : null,
    ),
  );
  if (r.parser.error) box.append(h("p", { class: "callout bad" }, `Parser: ${r.parser.error.message}`));
  for (const m of r.parser.matches) {
    box.append(
      h(
        "gb-panel",
        { label: `Match ${m.matchKey}`, class: "parsed" },
        h("p", null, chip(m.action), " ", statusChip(m.status)),
        h(
          "dl",
          { class: "fact-grid small" },
          fact("Region", m.region ? regionLabel(m.region) : "–"),
          fact("Version", m.gameVersion ?? "–"),
          fact("Map", m.settings?.map ?? "–"),
          fact("Players", m.players.length),
          fact("Rated rounds", `${m.ratedRounds} of ${m.rounds.length}`),
          fact("Kills", m.kills ?? "–"),
          fact("Complete", m.complete ? "Yes" : "No"),
          m.storedMatchId ? fact("Stored as", h("a", { href: `#/matches/${m.storedMatchId}` }, `#${m.storedMatchId}`)) : null,
        ),
        (m.reviewReasons.length > 0 || m.rejection) &&
          h("ul", { class: "reasons" }, m.reviewReasons.map((x) => h("li", null, reasonText(x))), m.rejection && h("li", { class: "bad" }, m.rejection.message)),
        h("p", { class: "muted small" }, m.players.map((p) => p.name).join(", ")),
        m.problems.length > 0 &&
          h("details", null, h("summary", null, count(m.problems.length, "skipped line", "skipped lines")), h("ul", null, m.problems.map((p) => h("li", null, `Line ${p.line}: ${p.message}`)))),
      ),
    );
  }
  if (r.parser.warnings.length) {
    box.append(h("ul", { class: "reasons" }, r.parser.warnings.map((w) => h("li", null, typeof w === "string" ? w : (w.message ?? JSON.stringify(w))))));
  }
  box.append(h("details", null, h("summary", null, "Full answer"), h("pre", null, JSON.stringify(r, null, 2))));
  return box;
}
