// Tourneys: the list, a tourney's page with its lobbies (host, match, screenshot, verify) and sign-ups.
import { site } from "../lib/site";
import { h, count, localInput, longTime, time } from "./dom";
import { api, app, currentRoute, hosts, post, regionLabel, regionOptions, setQuery, staleNote } from "./state";
import type { AdminTourney, Lobby, Signup } from "./types";
import {
  ask, btn, chip, confirmAction, crumb, empty, head, lede, lightbox, matchPreview, notFound, notify, run, section, seg, statusChip,
  table, type FieldSpec, type View,
} from "./ui";

// A done tourney's lobbies stop showing jobs this many days after it started: old screenshots expire.
const doneTourneyJobDays = 14;

/** The open jobs of a tourney's lobbies, for the overview and the badge. */
export function tourneyTodos(t: AdminTourney): { text: string }[] {
  if (t.status === "cancelled") return [];
  const todos: { text: string }[] = [];
  const started = t.status === "live" || t.status === "done";
  if (t.status === "done" && Date.now() - Date.parse(t.startsAt) > doneTourneyJobDays * 86400000) return [];
  if (!t.lobbies.length) todos.push({ text: "No lobbies yet" });
  const over = t.signups.count - t.capacity;
  if (t.status !== "done" && over > 0 && t.lobbies.length) todos.push({ text: `${count(over, "sign-up", "sign-ups")} over capacity: add a lobby` });
  for (const l of t.lobbies) {
    if (t.status !== "done" && !l.hostId) todos.push({ text: `${l.label} has no host` });
    if (started && !l.matchId) todos.push({ text: `${l.label} needs its match` });
    if (l.matchId && !l.screenshotKey && !l.verifiedAt && !l.screenshotExpiredAt) todos.push({ text: `${l.label} needs a screenshot` });
    if (l.matchId && l.screenshotKey && !l.verifiedAt) todos.push({ text: `${l.label} is ready to verify` });
  }
  return todos;
}

function tourneyFields(t: AdminTourney | null = null): FieldSpec[] {
  return [
    { name: "name", label: "Name", required: true, maxlength: 200, value: t?.name },
    { name: "region", label: "Region", type: "select", required: true, options: regionOptions(), value: t?.region ?? site.region },
    {
      name: "start",
      label: "Starts",
      type: "datetime-local",
      required: true,
      value: t ? localInput(t.startsAt) : "",
      hint: `In your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
    },
    { name: "notes", label: "Notes (optional)", type: "textarea", maxlength: 1000, value: t?.notes ?? "", placeholder: "Shown on the tourney's page" },
  ];
}

function startsAt(start: string): string {
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) throw new Error("That start time isn't a date.");
  return date.toISOString();
}

async function newTourney(): Promise<void> {
  const res = await ask({
    title: "Schedule a tourney",
    fields: tourneyFields(),
    ok: "Schedule",
    submit: (v) => post<{ tourney: AdminTourney }>("tourneys", { name: v.name, region: v.region, startsAt: startsAt(v.start ?? ""), notes: v.notes }),
  });
  if (res) {
    notify(`${res.tourney.name} is scheduled. Add its lobbies next.`);
    location.hash = `#/tourneys/${res.tourney.id}`;
  }
}

export const tourneysView: View = async (view) => {
  const { tourneys } = await api<{ tourneys: AdminTourney[] }>("tourneys");
  view.append(
    head("Tourneys", btn("Schedule a tourney", newTourney, { variant: "primary" })),
    lede(
      "A lobby's match is a tourney match: it counts more on the leaderboard. After it's played, upload the host's screenshot of the final standings and verify it against the standings.",
    ),
  );
  const upcoming = tourneys.filter((t) => t.status === "scheduled" || t.status === "live").sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = tourneys.filter((t) => t.status === "done" || t.status === "cancelled");
  view.append(section("Upcoming and live"), upcoming.length ? h("div", { class: "cards" }, upcoming.map(tourneyCard)) : empty("No tourney is scheduled."));
  if (past.length) view.append(section("Past"), h("div", { class: "cards" }, past.map(tourneyCard)));
};

function tourneyCard(t: AdminTourney): HTMLElement {
  const todos = tourneyTodos(t);
  const ready = t.lobbies.filter((l) => l.hostId).length;
  return h(
    "a",
    { class: "card tourney-card", href: `#/tourneys/${t.id}` },
    h("div", { class: "card-top" }, h("b", null, t.name), statusChip(t.status)),
    h("p", { class: "muted" }, regionLabel(t.region), " · ", longTime(t.startsAt)),
    meter(t.signups.count, t.capacity, `${t.signups.count} / ${t.capacity} signed up${t.signups.open ? "" : " (closed)"}`),
    h(
      "p",
      { class: "card-foot" },
      h("span", null, `${count(t.lobbies.length, "lobby", "lobbies")}, ${ready} with a host`),
      todos.length ? chip(count(todos.length, "job", "jobs"), "warn") : chip("All set", "good"),
    ),
  );
}

function meter(value: number, max: number, label: string): HTMLElement {
  const over = max > 0 && value > max;
  return h(
    "div",
    { class: `meter${over ? " over" : ""}` },
    h("div", { class: "track" }, h("span", { style: `width: ${max ? Math.min(100, (value / max) * 100) : 0}%` })),
    h("small", null, label),
  );
}

export const tourneyView: View = async (view, [id]) => {
  const [{ tourneys }, { signups }] = await Promise.all([
    api<{ tourneys: AdminTourney[] }>("tourneys"),
    api<{ signups: Signup[] }>(`tourneys/${id}/signups`),
  ]);
  const t = tourneys.find((x) => x.id === Number(id));
  if (!t) return notFound(view, [], new URLSearchParams());
  const edit = btn("Edit", async () => {
    const res = await ask({
      title: `Edit ${t.name}`,
      fields: tourneyFields(t),
      submit: (v) => post<{ tourney?: AdminTourney }>(`tourneys/${t.id}`, { name: v.name, region: v.region, startsAt: startsAt(v.start ?? ""), notes: v.notes }),
    });
    if (res) {
      notify(`${res.tourney?.name ?? t.name} saved.`);
      await app.refresh();
    }
  });
  view.append(
    head(
      h("div", null, crumb("#/tourneys", "Tourneys"), h("h1", null, t.name)),
      h("a", { class: "button", href: `/tourney?id=${t.id}`, target: "_blank", rel: "noopener" }, "Public page ↗"),
      edit,
    ),
  );
  view.append(
    h(
      "div",
      { class: "toolbar" },
      seg(
        ["scheduled", "live", "done", "cancelled"].map((s): [string, string] => [s, s[0]!.toUpperCase() + s.slice(1)]),
        t.status,
        (status) => (status === t.status ? undefined : run(t.name, () => post(`tourneys/${t.id}`, { status }).then(() => `${t.name} is ${status}.`))),
        "Status",
      ),
      h("span", { class: "muted" }, regionLabel(t.region), " · ", longTime(t.startsAt), " (", time(t.startsAt), ")"),
    ),
  );
  if (t.notes) view.append(lede(t.notes));

  const over = t.signups.count - t.capacity;
  view.append(section("Lobbies", btn("Add a lobby", () => addLobby(t), over > 0 ? { variant: "primary" } : {})));
  if (over > 0) {
    view.append(h("p", { class: "callout warn" }, `${count(over, "player", "players")} more signed up than the lobbies hold. Add a lobby, or another tourney.`));
  }
  view.append(
    t.lobbies.length
      ? h("div", { class: "lobby-grid" }, t.lobbies.map((l) => lobbyCard(t, l)))
      : empty("No lobbies yet. Add one for every 10 or so sign-ups."),
  );
  view.append(signupSection(t, signups));
};

async function addLobby(t: AdminTourney): Promise<void> {
  const hostList = (await hosts()).filter((x) => x.trust !== "revoked");
  const res = await ask({
    title: `Add a lobby to ${t.name}`,
    fields: [
      { name: "label", label: "Label", required: true, maxlength: 100, value: `Lobby ${t.lobbies.length + 1}` },
      {
        name: "hostId",
        label: "Host",
        type: "select",
        options: [["", "No host yet"], ...hostList.map((x): [number, string] => [x.id, `${x.name} (${regionLabel(x.region)})`])],
        hint: "They get the tourney code in the host tool and upload the screenshot.",
      },
      { name: "roundLimit", label: "Rounds", type: "number", min: 1, max: 50, placeholder: "Default (30)", inputmode: "numeric" },
      { name: "capacity", label: "Players it holds", type: "number", min: 1, max: 12, placeholder: "Default (10)", inputmode: "numeric" },
    ],
    ok: "Add lobby",
    submit: (v) =>
      post<{ lobby: Lobby }>(`tourneys/${t.id}/lobbies`, {
        label: v.label,
        ...(v.hostId ? { hostId: Number(v.hostId) } : {}),
        ...(v.roundLimit ? { roundLimit: Number(v.roundLimit) } : {}),
        ...(v.capacity ? { capacity: Number(v.capacity) } : {}),
      }),
  });
  if (res) {
    notify(`${res.lobby.label} added.`);
    await app.refresh();
  }
}

function lobbyCard(t: AdminTourney, l: Lobby): HTMLElement {
  const edit = btn(
    "Edit",
    async () => {
      const res = await ask({
        title: `Edit ${l.label}`,
        fields: [
          { name: "label", label: "Label", required: true, maxlength: 100, value: l.label },
          { name: "roundLimit", label: "Rounds", type: "number", min: 1, max: 50, value: l.roundLimitDefault ? "" : l.roundLimit, placeholder: "Default (30)", inputmode: "numeric" },
          { name: "capacity", label: "Players it holds", type: "number", min: 1, max: 12, value: l.capacityDefault ? "" : l.capacity, placeholder: "Default (10)", inputmode: "numeric" },
        ],
        submit: (v) =>
          post<{ lobby?: Lobby }>(`lobbies/${l.id}`, {
            label: v.label,
            roundLimit: v.roundLimit ? Number(v.roundLimit) : null,
            capacity: v.capacity ? Number(v.capacity) : null,
          }),
      });
      if (res) {
        notify(`${res.lobby?.label ?? l.label} saved.`);
        await app.refresh();
      }
    },
    { small: true },
  );
  const remove = btn(
    "Delete",
    async () => {
      const ok = await confirmAction(
        `Delete ${l.label}?`,
        l.matchId ? `Its match #${l.matchId} stops being a tourney match, and its screenshot is deleted.` : "Its screenshot, if any, is deleted too.",
        "Delete",
      );
      if (ok) await run(`Delete ${l.label}`, async () => `${l.label} deleted.${staleNote(await api<{ ratingsStale?: boolean }>(`lobbies/${l.id}`, { method: "DELETE" }))}`);
    },
    { small: true, variant: "ghost", tone: "danger" },
  );

  const card = h(
    "article",
    { class: "card lobby-card" },
    h("div", { class: "card-top" }, h("b", null, l.label), h("div", { class: "head-actions" }, edit, remove)),
    h("p", { class: "muted small" }, `${l.roundLimit} rounds${l.roundLimitDefault ? " (default)" : ""} · holds ${l.capacity}${l.capacityDefault ? " (default)" : ""}`),
    h("ol", { class: "steps" }, hostStep(l), matchStep(t, l), screenshotStep(l), verifyStep(t, l)),
  );

  // An image dropped on the card is its screenshot.
  card.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer?.items ?? [])].some((i) => i.type.startsWith("image/"))) return;
    e.preventDefault();
    card.classList.add("drop");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop"));
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drop");
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) void run(`Screenshot for ${l.label}`, () => putScreenshot(l, file));
  });
  return card;
}

const step = (done: boolean, title: string, body: Parameters<typeof h>[2], actions?: Parameters<typeof h>[2]): HTMLElement =>
  h(
    "li",
    { class: done ? "done" : null },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("div", null, h("b", null, title), h("div", { class: "step-body" }, body), actions && h("div", { class: "row" }, actions)),
  );

function hostStep(l: Lobby): HTMLElement {
  const pick = btn(
    l.hostId ? "Change" : "Assign a host",
    async () => {
      const hostList = (await hosts()).filter((x) => x.trust !== "revoked");
      const res = await ask({
        title: `Host of ${l.label}`,
        text: "They get the tourney code in the host tool and upload the screenshot. Any host can run it, whatever their home region.",
        fields: [
          {
            name: "hostId",
            label: "Host",
            type: "select",
            value: l.hostId ?? "",
            options: [["", "No host"], ...hostList.map((x): [number, string] => [x.id, `${x.name} (${x.trust}, ${regionLabel(x.region)})`])],
          },
        ],
        submit: ({ hostId }) => post<{ lobby?: Lobby }>(`lobbies/${l.id}`, { hostId: hostId ? Number(hostId) : null }),
      });
      if (res) {
        const name = hostList.find((x) => x.id === res.lobby?.hostId)?.name;
        notify(res.lobby?.hostId ? `${l.label} is hosted by ${name ?? `host #${res.lobby.hostId}`}.` : `${l.label} has no host.`);
        await app.refresh();
      }
    },
    { small: true },
  );
  return step(Boolean(l.hostId), "Host", l.hostId ? l.hostName : h("span", { class: "faint" }, "None yet"), pick);
}

function matchStep(t: AdminTourney, l: Lobby): HTMLElement {
  const link = btn(
    l.matchId ? "Change" : "Link a match",
    async () => {
      const res = await ask({
        title: `Match of ${l.label}`,
        text: "Uploads with the lobby's tourney code link on their own. Link one by hand when it didn't (it's in review), or to fix a link.",
        fields: [
          {
            name: "matchId",
            label: "Match id",
            value: l.matchId ?? "",
            required: true,
            inputmode: "numeric",
            placeholder: "123",
            preview: matchPreview,
            hint: `It must be from ${regionLabel(t.region)}.`,
          },
        ],
        ok: "Link",
        submit: ({ matchId }) => {
          const digits = (matchId ?? "").replace(/^#\s*/, "");
          if (!/^[1-9]\d*$/.test(digits)) throw new Error("Enter a match id, like 123.");
          return post<{ lobby: Lobby; ratingsStale?: boolean }>(`lobbies/${l.id}`, { matchId: Number(digits) });
        },
      });
      if (res) {
        notify(`${l.label} is match #${res.lobby.matchId}.${staleNote(res)}`);
        await app.refresh();
      }
    },
    { small: true },
  );
  const unlink = l.matchId
    ? btn(
        "Move to ranked",
        async () => {
          const ok = await confirmAction(
            `Move match #${l.matchId} back to ranked?`,
            `It stops being a tourney match and is rated as a normal one. ${l.label} has no result until a match is linked again. To drop the match instead, void it.`,
            "Move to ranked",
          );
          if (ok) {
            await run(l.label, async () => `Match #${l.matchId} is a ranked match again.${staleNote(await post<{ ratingsStale?: boolean }>(`lobbies/${l.id}`, { matchId: null }))}`);
          }
        },
        { small: true, variant: "ghost" },
      )
    : null;
  return step(
    Boolean(l.matchId),
    "Match",
    l.matchId ? h("a", { href: `#/matches/${l.matchId}` }, `Match #${l.matchId}`) : h("span", { class: "faint" }, t.status === "scheduled" ? "After it's played" : "Not linked"),
    [link, unlink],
  );
}

async function putScreenshot(lobby: Lobby, file: Blob): Promise<string> {
  await api(`lobbies/${lobby.id}/screenshot`, { method: "PUT", raw: file });
  return `Screenshot uploaded for ${lobby.label}. Check it against the standings, then verify.`;
}

function screenshotStep(l: Lobby): HTMLElement {
  const upload = btn(
    l.screenshotKey ? "Replace" : "Upload",
    () =>
      new Promise<void>((resolve) => {
        const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          if (!file) return resolve();
          void run(`Screenshot for ${l.label}`, () => putScreenshot(l, file)).then(resolve);
        });
        input.addEventListener("cancel", () => resolve());
        input.click();
      }),
    { small: true },
  );
  const remove = l.screenshotKey
    ? btn(
        "Delete",
        async () => {
          if (await confirmAction(`Delete ${l.label}'s screenshot?`, "The lobby needs a new one to be verified.", "Delete")) {
            await run("Delete screenshot", () => api(`lobbies/${l.id}/screenshot`, { method: "DELETE" }).then(() => "Screenshot deleted."));
          }
        },
        { small: true, variant: "ghost" },
      )
    : null;
  const src = l.screenshotKey ? `/api/screenshots/${l.screenshotKey}` : null;
  const body = src
    ? h("button", { type: "button", class: "thumb", onclick: () => lightbox(src), title: "Enlarge" }, h("img", { src, alt: `${l.label}'s final standings`, loading: "lazy" }))
    : l.screenshotExpiredAt
      ? h("span", { class: "faint" }, "No longer kept (", time(l.screenshotExpiredAt), ")")
      : h("span", { class: "faint" }, "None yet. Drop an image on this card, or upload one.");
  return step(Boolean(l.screenshotKey || l.screenshotExpiredAt), "Screenshot", body, [upload, remove]);
}

function verifyStep(t: AdminTourney, l: Lobby): HTMLElement {
  if (l.verifiedAt) {
    return step(
      true,
      "Verified",
      h("span", null, `by ${l.verifiedBy}, `, time(l.verifiedAt)),
      btn("Unverify", () => run(l.label, () => post(`lobbies/${l.id}/verify`, { verified: false, version: l.version }).then(() => `${l.label} is unverified.`)), { small: true, variant: "ghost" }),
    );
  }
  if (!(l.matchId && l.screenshotKey)) return step(false, "Verify", h("span", { class: "faint" }, "Needs a match and a screenshot"));
  return step(
    false,
    "Verify",
    h("span", null, "Check the screenshot against the ", h("a", { href: `/tourney?id=${t.id}`, target: "_blank", rel: "noopener" }, "standings ↗")),
    btn("Verify", () => run(l.label, () => post(`lobbies/${l.id}/verify`, { verified: true, version: l.version }).then(() => `${l.label} is verified.`)), { small: true, variant: "primary" }),
  );
}

function signupSection(t: AdminTourney, signups: Signup[]): HTMLElement {
  const showRemoved = currentRoute().query.get("removed") === "1";
  const active = signups.filter((s) => !s.removedAt);
  const removed = signups.length - active.length;
  const box = h("div");
  const toggle = h("input", { type: "checkbox", checked: showRemoved });
  toggle.addEventListener("change", () => {
    setQuery({ removed: toggle.checked ? "1" : "" });
    void app.refresh();
  });
  box.append(section("Sign-ups", removed ? h("gb-field", { label: `Show removed (${removed})` }, toggle) : null));
  box.append(meter(t.signups.count, t.capacity, `${t.signups.count} of ${t.capacity} places${t.signups.open ? "" : " · sign-ups are closed"}`));
  if (!signups.length) {
    box.append(empty("No sign-ups yet."));
    return box;
  }
  let place = 0;
  const rows = signups
    .filter((s) => showRemoved || !s.removedAt)
    .map((s) => {
      if (!s.removedAt) place++;
      const over = !s.removedAt && place > t.capacity;
      return h(
        "tr",
        { class: s.removedAt ? "removed" : over ? "over" : null },
        h("td", { class: "num" }, s.removedAt ? "" : place),
        h("td", null, h("b", null, s.name), s.discordUserId && chip("Discord"), over && chip("Over capacity", "warn")),
        h("td", null, time(s.signedUpAt)),
        h("td", { class: "muted" }, s.removedAt ? ["Removed by ", s.removedBy, ", ", time(s.removedAt)] : ""),
        h(
          "td",
          { class: "actions" },
          s.removedAt
            ? btn("Restore", () => run(s.name, () => post(`signups/${s.id}`, { removed: false }).then(() => `${s.name} is signed up again.`)), { small: true })
            : btn(
                "Remove",
                async () => {
                  if (await confirmAction(`Remove ${s.name}?`, `They drop off ${t.name}'s sign-ups, and the name can't sign up again unless you restore it.`, "Remove")) {
                    await run(s.name, () => post(`signups/${s.id}`, { removed: true }).then(() => `${s.name} removed from the sign-ups.`));
                  }
                },
                { small: true, variant: "ghost" },
              ),
        ),
      );
    });
  box.append(table(["#", "Name", "Signed up", { sr: "Removal" }, { sr: "Actions" }], rows, [0]));
  return box;
}
