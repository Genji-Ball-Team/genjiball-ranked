// Hosts: who may upload, how far they're trusted, and their tokens.
import { site } from "../lib/site";
import { h, time } from "./dom";
import { app, hosts, post, regionLabel, regionOptions, setQuery } from "./state";
import type { Host } from "./types";
import { ask, btn, chip, confirmAction, copy, empty, filterBox, head, lede, run, searchField, table, type View } from "./ui";

export const hostsView: View = async (view, _params, query) => {
  app.hostCache = null;
  const list = await hosts();
  const showRevoked = query.get("revoked") === "1";
  const filter = filterBox("Filter hosts", query.get("q") ?? "", "Filter by name");
  filter.dataset.autofocus = "";
  const box = h("div");
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    setQuery({ q });
    const shown = list.filter((x) => (showRevoked || x.trust !== "revoked") && (!q || x.name.toLowerCase().includes(q)));
    box.replaceChildren(
      shown.length ? table(["Host", "Trust", "Home region", "Created", "Last upload", { sr: "Actions" }], shown.map(hostRow)) : empty("No host fits."),
    );
  };
  filter.addEventListener("input", draw);
  const revoked = list.filter((x) => x.trust === "revoked").length;
  const toggle = h("input", { type: "checkbox", checked: showRevoked });
  toggle.addEventListener("change", () => {
    setQuery({ revoked: toggle.checked ? "1" : "" });
    void app.refresh();
  });
  view.append(
    head("Hosts", btn("New host", newHost, { variant: "primary" })),
    lede("A host uploads with their own token from the host tool. A trusted host's matches count straight away; an untrusted host's wait in review."),
    h("div", { class: "toolbar" }, searchField("Filter", filter), revoked ? h("gb-field", { label: `Show revoked (${revoked})` }, toggle) : null),
    box,
  );
  draw();
};

function hostRow(x: Host): HTMLElement {
  const revoked = x.trust === "revoked";
  const regionSelect = h(
    "select",
    { "aria-label": `${x.name}'s home region`, disabled: revoked },
    regionOptions(["", "None"]).map(([v, l]) => h("option", { value: v, selected: (x.region ?? "") === v }, l)),
  );
  regionSelect.addEventListener("change", () => {
    void run(x.name, () =>
      post(`hosts/${x.id}/region`, { region: regionSelect.value || null }).then(
        () => `${x.name}'s home region is ${regionLabel(regionSelect.value || null)}. Stored matches keep theirs.`,
      ),
    );
  });
  const other = x.trust === "trusted" ? "untrusted" : "trusted";
  return h(
    "tr",
    { class: revoked ? "removed" : null },
    h("td", null, h("b", null, x.name), h("small", { class: "muted" }, ` #${x.id}`)),
    h("td", null, chip(x.trust, x.trust === "trusted" ? "good" : x.trust === "revoked" ? "bad" : "warn")),
    h("td", null, h("gb-field", { label: "Home region", class: "bare" }, regionSelect)),
    h("td", null, time(x.createdAt)),
    h("td", null, time(x.lastUploadAt)),
    h(
      "td",
      { class: "actions" },
      revoked
        ? null
        : [
            btn(`Make ${other}`, () => run(x.name, () => post(`hosts/${x.id}/trust`, { trust: other }).then(() => `${x.name} is ${other}. It applies from their next upload.`)), { small: true }),
            btn(
              "Revoke",
              async () => {
                if (await confirmAction(`Revoke ${x.name}'s token?`, "Their uploads stop working straight away. This can't be undone: they'd need a new host token.", "Revoke")) {
                  await run(x.name, () => post(`hosts/${x.id}/revoke`).then(() => `${x.name}'s token is revoked.`));
                }
              },
              { small: true, variant: "ghost", tone: "danger" },
            ),
          ],
    ),
  );
}

async function newHost(): Promise<void> {
  const res = await ask({
    title: "New host",
    text: "Makes a host token for the host tool. You'll see the token once, right after.",
    fields: [
      { name: "name", label: "Name", required: true, maxlength: 200, placeholder: "Their Discord or in-game name" },
      {
        name: "trust",
        label: "Trust",
        type: "select",
        value: "untrusted",
        options: [
          ["untrusted", "Untrusted: their matches wait in review"],
          ["trusted", "Trusted: their matches count straight away"],
        ],
      },
      {
        name: "region",
        label: "Home region",
        type: "select",
        value: site.region,
        options: regionOptions(["", "None: each upload says"]),
        hint: "Where their uploads were played, when the host tool doesn't say.",
      },
    ],
    ok: "Create token",
    submit: (v) => post<{ host: Host; token: string }>("hosts", { name: v.name, trust: v.trust, region: v.region || null }),
  });
  if (!res) return;
  app.hostCache = null;
  await app.refresh();
  await ask({
    title: `Token for ${res.host.name}`,
    text: h("p", { class: "callout warn" }, "Copy it now and send it to them privately. It isn't shown again: if it's lost, revoke it and make a new one."),
    fields: [
      {
        name: "token",
        render: () => ({
          el: h("div", { class: "token" }, h("code", null, res.token), btn("Copy", () => copy(res.token), { small: true, variant: "primary" })),
          get: () => "",
        }),
      },
    ],
    ok: "Done",
    cancel: false,
  });
}
