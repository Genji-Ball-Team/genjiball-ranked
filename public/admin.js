// The admin pages (/admin). One page, one view per area, picked by the hash (`#/matches`,
// `#/tourneys/3`), so a view is a link that can be shared between admins. Every value from the server
// goes into the page as text (`h` below): player and host names come from game logs.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  // ---- Small DOM helpers ----

  // `h("a", { href, onclick }, "text", child)`: attributes are set as attributes (`true` for a bare
  // one, `null`/`false` left out), `on…` functions become listeners, children are text or nodes.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else el.setAttribute(key === "className" ? "class" : key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
    }
    return el;
  }

  // A button that shows it's working and can't be pressed twice while `onClick` runs.
  function btn(label, onClick, className = "") {
    const b = h("button", { type: "button", class: className || null }, label);
    b.addEventListener("click", async (event) => {
      if (b.disabled) return;
      b.disabled = true;
      b.classList.add("busy");
      try {
        await onClick(event);
      } finally {
        b.disabled = false;
        b.classList.remove("busy");
      }
    });
    return b;
  }

  const chip = (text, kind = "plain", title = null) => h("span", { class: `chip ${kind}`, title }, text);
  const empty = (text) => h("p", { class: "empty" }, text);
  const scroll = (table) => h("div", { class: "scroll" }, table);

  function table(headings, rows) {
    return h("table", { class: "data" }, h("thead", {}, h("tr", {}, headings.map((t) => h("th", {}, t)))), h("tbody", {}, rows));
  }

  // ---- Time ----

  const longTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  function ago(iso) {
    const seconds = (Date.parse(iso) - Date.now()) / 1000;
    const steps = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [2629800, "week"], [31557600, "month"], [Infinity, "year"]];
    const sizes = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
    const [, unit] = steps.find(([limit]) => Math.abs(seconds) < limit);
    return relative.format(Math.round(seconds / sizes[unit]), unit);
  }
  // A time as "3 hours ago", the full date on hover.
  const time = (iso, never = "never") => (iso ? h("time", { datetime: iso, title: longTime(iso) }, ago(iso)) : h("span", { class: "faint" }, never));
  // Times are entered in the admin's own time zone and sent as UTC.
  const localInput = (iso) => {
    const d = new Date(iso);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };

  // ---- The API ----

  const storage = {
    get: () => {
      try {
        return sessionStorage.getItem("adminToken");
      } catch {
        return null;
      }
    },
    set: (value) => {
      try {
        if (value) sessionStorage.setItem("adminToken", value);
        else sessionStorage.removeItem("adminToken");
      } catch {
        // not kept
      }
    },
  };
  let token = storage.get();

  async function api(path, { method = "GET", body, raw } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (raw) headers["Content-Type"] = raw.type || "application/octet-stream";
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`/api/admin/${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      signOut(data.message || "Your token was signed out.");
      throw new Error(data.message || "Signed out");
    }
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  }
  const post = (path, body = {}) => api(path, { method: "POST", body });
  const staleNote = (res) => (res?.ratingsStale ? " Ratings are being recomputed (within 10 minutes)." : "");

  // ---- Toasts, dialogs ----

  function toast(text, kind = "ok") {
    const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, h("span", {}, text),
      h("button", { type: "button", class: "x", "aria-label": "Dismiss", onclick: () => t.remove() }, "×"));
    $("toasts").append(t);
    setTimeout(() => t.remove(), kind === "error" ? 10000 : 5000);
  }

  // Runs a change, says how it went, then draws the view again with the new data.
  async function run(label, change) {
    try {
      toast((await change()) || `${label}: done.`);
    } catch (error) {
      toast(`${label}: ${error.message}`, "error");
    }
    await refresh();
  }

  // A form in a modal dialog. `submit(values)` runs with the dialog still open: if it throws, its
  // message shows in the dialog and the admin can fix the input. Resolves to what `submit` returned
  // (or the values), or null when cancelled.
  function ask({ title, text, fields = [], ok = "Save", danger = false, submit, wide = false, cancel = true }) {
    return new Promise((resolve) => {
      const getters = {};
      const error = h("p", { class: "dialog-error", role: "alert", hidden: true });
      const okButton = h("button", { class: danger ? "danger" : "primary" }, ok);
      const dialog = h("dialog", { class: `modal${wide ? " wide" : ""}` });
      const form = h("form", { novalidate: true },
        h("h2", {}, title),
        text && (typeof text === "string" ? h("p", { class: "muted" }, text) : text),
        fields.map((f) => field(f, getters)),
        error,
        h("div", { class: "dialog-actions" }, cancel && h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"), okButton));
      dialog.append(form);
      let done = false;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const values = Object.fromEntries(Object.entries(getters).map(([name, get]) => [name, get()]));
        okButton.disabled = true;
        okButton.classList.add("busy");
        error.hidden = true;
        try {
          const result = submit ? await submit(values) : values;
          done = true;
          dialog.close();
          resolve(result ?? values);
        } catch (e) {
          error.textContent = e.message;
          error.hidden = false;
        } finally {
          okButton.disabled = false;
          okButton.classList.remove("busy");
        }
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (!done) resolve(null);
      });
      document.body.append(dialog);
      dialog.showModal();
      form.querySelector("input:not([type=hidden]), textarea, select")?.focus();
    });
  }

  const confirmAction = (title, text, ok, danger = true) => ask({ title, text, ok, danger });

  // One field of `ask`: { name, label, type, value, hint, options: [[value, label]], preview, render }.
  function field(f, getters) {
    if (f.render) {
      const { el, get } = f.render();
      getters[f.name] = get;
      return el;
    }
    const common = { name: f.name, required: f.required, placeholder: f.placeholder, min: f.min, max: f.max, maxlength: f.maxlength, inputmode: f.inputmode, autocomplete: "off" };
    let input;
    if (f.type === "select") {
      input = h("select", common, f.options.map(([value, label]) => h("option", { value, selected: String(value) === String(f.value ?? "") }, label)));
    } else if (f.type === "textarea") {
      input = h("textarea", { ...common, rows: 3 }, f.value ?? "");
    } else {
      input = h("input", { ...common, type: f.type ?? "text", value: f.type === "checkbox" || f.type === "file" ? null : f.value ?? "", checked: f.type === "checkbox" && f.value, accept: f.accept });
    }
    getters[f.name] = f.type === "checkbox" ? () => input.checked : f.type === "file" ? () => input.files[0] ?? null : () => input.value.trim();
    if (f.type === "checkbox") return h("label", { class: "check" }, input, h("span", {}, f.label), f.hint && h("small", {}, f.hint));
    const preview = f.preview && h("div", { class: "preview" });
    if (preview) {
      let timer;
      const show = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => preview.replaceChildren(await f.preview(input.value.trim())), 250);
      };
      input.addEventListener("input", show);
      if (f.value) show();
    }
    return h("label", { class: "field" }, h("span", {}, f.label), input, f.hint && h("small", {}, f.hint), preview);
  }

  // A player search to pick another player (merges): the id of the one picked.
  function playerPicker(excludeId) {
    let picked = null;
    const results = h("div", { class: "picks", role: "radiogroup", "aria-label": "Players" });
    const input = h("input", { type: "search", placeholder: "Name or old name", autocomplete: "off" });
    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const search = input.value.trim();
        picked = null;
        if (search.length < 2) return results.replaceChildren();
        try {
          const { players } = await api(`players?search=${encodeURIComponent(search)}`);
          const others = players.filter((p) => p.id !== excludeId);
          results.replaceChildren(...(others.length ? others.map((p) => h("label", { class: "pick" },
            h("input", { type: "radio", name: "pick", value: p.id, onchange: () => (picked = p.id) }),
            h("span", {}, h("b", {}, p.name), h("small", {}, `#${p.id} · ${p.aliases.join(", ")}`)))) : [empty("No other player has that name.")]));
        } catch (e) {
          results.replaceChildren(h("p", { class: "error" }, e.message));
        }
      }, 250);
    });
    const el = h("div", { class: "field" }, h("span", {}, "Merge into"), input, results);
    return { el, get: () => picked };
  }

  // A screenshot, full size, over the page.
  function lightbox(src) {
    const dialog = h("dialog", { class: "lightbox", onclick: () => dialog.close() },
      h("img", { src, alt: "Screenshot of the final standings" }), h("button", { type: "button", "aria-label": "Close" }, "×"));
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.");
    } catch {
      toast("Couldn't copy: select it and copy it by hand.", "error");
    }
  }

  // ---- Regions ----

  let regions = [];
  const regionLabel = (id) => regions.find((r) => r.id === id)?.label ?? id ?? "none";
  const regionChip = (id) => chip(id ? id.toUpperCase() : "none", "plain region", regionLabel(id));
  const regionOptions = (first) => [...(first ? [first] : []), ...regions.map((r) => [r.id, r.label])];

  // The header's EU/NA switch changes the region in place here, rather than loading the page again.
  document.addEventListener("click", (event) => {
    const link = event.target.closest(".top .regions a");
    if (!link || $("app").hidden) return;
    const id = new URL(link.href).searchParams.get("region");
    if (!regions.some((r) => r.id === id)) return;
    event.preventDefault();
    site.use(id);
    setQuery({ region: "" });
    site.pin();
    refresh();
  });

  // ---- Words for codes ----

  const reasons = {
    duplicate_name: "Two players had the same name",
    untrusted_host: "The host isn't trusted yet",
    tourney_unknown_lobby: "Its tourney code is for a lobby that doesn't exist",
    tourney_cancelled: "Its tourney was cancelled",
    tourney_wrong_host: "Uploaded by a host who isn't the lobby's",
    tourney_wrong_region: "Played in another region than its tourney",
    tourney_lobby_taken: "Its lobby already has a match",
    tourney_round_limit: "Played with another round limit than its lobby's",
  };
  const reasonText = (code) => reasons[code] ?? code.replaceAll("_", " ");
  const statusKinds = { review: "warn", accepted: "good", void: "plain", rejected: "bad", scheduled: "plain", live: "good", done: "plain", cancelled: "bad" };
  const statusChip = (status) => chip(status, statusKinds[status] ?? "plain");
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ---- Routing ----

  const routes = [
    [/^$/, overview],
    [/^matches$/, matchesView],
    [/^matches\/(\d+)$/, matchView],
    [/^tourneys$/, tourneysView],
    [/^tourneys\/(\d+)$/, tourneyView],
    [/^hosts$/, hostsView],
    [/^players$/, playersView],
    [/^players\/(\d+)$/, playerView],
    [/^log$/, logView],
    [/^tools$/, toolsView],
  ];

  function currentRoute() {
    const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
    return { path: path.replace(/\/$/, ""), query: new URLSearchParams(query) };
  }
  // Changes the hash's query (filters) without drawing the view again.
  function setQuery(values) {
    const { path, query } = currentRoute();
    for (const [key, value] of Object.entries(values)) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    const q = query.toString();
    history.replaceState(history.state, "", `#/${path}${q ? `?${q}` : ""}`);
  }

  let drawing = 0;
  async function refresh({ top = false } = {}) {
    if ($("app").hidden) return;
    const mine = ++drawing;
    const { path, query } = currentRoute();
    const [pattern, view] = routes.find(([p]) => p.test(path)) ?? [null, notFound];
    const params = pattern ? path.match(pattern).slice(1) : [];
    const section = path.split("/")[0];
    for (const a of document.querySelectorAll("#side-nav a")) {
      if (a.dataset.nav === section) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    const box = h("div", { class: "view" });
    const target = $("view");
    if (top) target.replaceChildren(h("div", { class: "skeleton tall" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
    target.setAttribute("aria-busy", "true");
    const scrollY = window.scrollY;
    try {
      await view(box, params, query);
    } catch (e) {
      box.replaceChildren(h("h1", {}, "Couldn't load this"), h("p", { class: "error" }, e.message), btn("Try again", () => refresh()));
    }
    if (mine !== drawing) return;
    target.replaceChildren(box);
    target.removeAttribute("aria-busy");
    if (top) {
      window.scrollTo(0, 0);
      box.querySelector("[data-autofocus]")?.focus();
    } else window.scrollTo(0, scrollY);
    badges().catch(() => {});
  }
  window.addEventListener("hashchange", () => refresh({ top: true }));

  function notFound(view) {
    view.append(h("h1", {}, "No such page"), h("p", {}, h("a", { href: "#/" }, "Back to the overview")));
  }

  const head = (title, ...rest) => h("div", { class: "view-head" }, h("div", {}, ...(Array.isArray(title) ? title : [h("h1", {}, title)])), h("div", { class: "head-actions" }, rest));
  const crumb = (href, label) => h("a", { class: "crumb", href }, `← ${label}`);
  const section = (title, ...rest) => h("div", { class: "section-head" }, h("h2", {}, title), h("div", { class: "head-actions" }, rest));

  // ---- What needs doing ----

  // A done tourney's lobbies stop showing jobs this many days after it started: old screenshots expire.
  const doneTourneyJobDays = 14;

  // The open jobs of a tourney's lobbies, for the overview and the badge.
  function tourneyTodos(t) {
    if (t.status === "cancelled") return [];
    const todos = [];
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

  async function badges() {
    const [{ matches }, { tourneys }] = await Promise.all([api("matches?status=review"), api("tourneys")]);
    const set = (id, n) => {
      $(id).textContent = n;
      $(id).hidden = !n;
    };
    set("badge-review", matches.length);
    set("badge-tourneys", tourneys.reduce((n, t) => n + tourneyTodos(t).length, 0));
  }

  // ---- Overview ----

  async function overview(view) {
    const [{ matches }, { tourneys }, { actions }] = await Promise.all([api("matches?status=review"), api("tourneys"), api("actions")]);
    const active = tourneys.filter((t) => t.status === "scheduled" || t.status === "live");
    const todos = tourneys.flatMap((t) => tourneyTodos(t).map((todo) => ({ ...todo, tourney: t })));
    view.append(head("Overview"),
      h("div", { class: "tiles" },
        tile("In review", matches.length, "#/matches?status=review", matches.length ? "warn" : ""),
        tile("Tourney jobs", todos.length, "#/tourneys", todos.length ? "warn" : ""),
        tile("Upcoming tourneys", active.length, "#/tourneys")));

    view.append(section("Review queue", h("a", { href: "#/matches?status=review" }, "All matches")));
    if (!matches.length) view.append(empty("Nothing to review. New uploads that need a look show up here."));
    else view.append(matchTable(matches.slice(0, 8)));
    if (matches.length > 8) view.append(h("p", { class: "note" }, h("a", { href: "#/matches?status=review" }, `${matches.length - 8} more in review`)));

    view.append(section("Tourney jobs"));
    if (!todos.length) view.append(empty("Every tourney is set up."));
    else view.append(h("ul", { class: "todos" }, todos.map((todo) => h("li", {}, h("a", { href: `#/tourneys/${todo.tourney.id}` },
      h("span", {}, todo.text), h("small", {}, todo.tourney.name, " · ", regionLabel(todo.tourney.region)))))));

    view.append(section("Recent actions", h("a", { href: "#/log" }, "Full log")));
    view.append(actionTable(actions.slice(0, 8)));
  }

  const tile = (label, value, href, kind = "") => h("a", { class: `tile ${kind}`, href }, h("b", { class: "num" }, value), h("span", {}, label));

  // ---- Matches ----

  const statuses = [["review", "Review"], ["accepted", "Accepted"], ["void", "Void"], ["rejected", "Rejected"]];

  function seg(options, current, onPick, label) {
    return h("div", { class: "seg", role: "group", "aria-label": label }, options.map(([value, text]) =>
      h("button", { type: "button", "aria-pressed": String(value === current), onclick: () => onPick(value) }, text)));
  }

  async function matchesView(view, _params, query) {
    const status = query.get("status") ?? "review";
    // The header's region, unless the filter picked another (or "all").
    const picked = query.get("region") ?? site.region;
    const region = picked === "all" ? "" : picked;
    const { matches } = await api(`matches?status=${status}${region ? `&region=${region}` : ""}`);
    const filter = h("input", { type: "search", placeholder: "Filter by id, host or player", value: query.get("q") ?? "", "data-autofocus": true });
    const list = h("div", {});
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      setQuery({ q });
      const shown = q ? matches.filter((m) => [String(m.id), m.hostName, ...m.players].some((s) => s.toLowerCase().includes(q))) : matches;
      list.replaceChildren(shown.length ? matchTable(shown) : empty(q ? "No match fits the filter." : `No ${status} matches${region ? ` in ${regionLabel(region)}` : ""}.`));
    };
    filter.addEventListener("input", draw);
    const go = (values) => {
      setQuery(values);
      refresh();
    };
    view.append(head("Matches"),
      h("div", { class: "toolbar" },
        seg(statuses, status, (s) => go({ status: s }), "Status"),
        seg([["all", "All regions"], ...regions.map((r) => [r.id, r.id.toUpperCase()])], picked, (r) => go({ region: r === site.region ? "" : r }), "Region"),
        h("label", { class: "search" }, filter)),
      list);
    draw();
    if (matches.length >= 100) view.append(h("p", { class: "note" }, "Only the newest 100 are listed."));
  }

  function matchTable(matches) {
    return scroll(table(["Match", "Played", "Host", "Players", "Notes", ""], matches.map((m) => h("tr", {},
      h("td", {}, h("a", { class: "id", href: `#/matches/${m.id}` }, `#${m.id}`), " ", regionChip(m.region)),
      h("td", {}, time(m.playedAt)),
      h("td", {}, m.hostName),
      h("td", { class: "players", title: m.players.join(", ") }, h("b", { class: "num" }, m.players.length), " ", h("span", { class: "muted" }, m.players.join(", "))),
      h("td", { class: "notes" }, matchNotes(m)),
      h("td", { class: "actions" }, matchButtons(m))))));
  }

  function matchNotes(m) {
    return [
      ...m.reviewReasons.map((r) => chip(reasonText(r), "warn")),
      m.rejection && chip(m.rejection.code === "admin" ? `Rejected: ${m.rejection.message || "by an admin"}` : m.rejection.message || m.rejection.code, "bad", m.rejection.code),
      m.tournament && chip("Tourney", "gold"),
      !m.complete && chip("Incomplete", "plain", "The log has no MATCH_END"),
      m.status === "accepted" && !m.rated && chip("Not rated", "plain"),
    ];
  }

  function matchButtons(m, big = false) {
    const cls = big ? "" : "small";
    const buttons = [];
    if (m.status === "review") {
      buttons.push(btn("Accept", () => matchAction(m, "accept"), `primary ${cls}`), btn("Reject", () => matchAction(m, "reject"), cls));
    }
    if (m.status === "rejected" && m.rejection?.code === "admin") buttons.push(btn("Accept", () => matchAction(m, "accept"), cls));
    if (m.status === "accepted") buttons.push(btn("Void", () => matchAction(m, "void"), cls));
    if (m.status === "void") buttons.push(btn("Un-void", () => matchAction(m, "unvoid"), cls));
    return buttons;
  }

  const actionWords = { accept: "accepted", reject: "rejected", void: "voided", unvoid: "un-voided" };
  async function matchAction(m, action) {
    const send = async (body) => {
      const res = await post(`matches/${m.id}/${action}`, body);
      return `Match #${m.id} ${actionWords[action]}: it's ${res.match.status}.${staleNote(res)}`;
    };
    if (action === "accept" || action === "unvoid") return run(`Match #${m.id}`, () => send({}));
    const message = await ask({
      title: `${action === "reject" ? "Reject" : "Void"} match #${m.id}?`,
      text: action === "reject"
        ? "It won't be rated or shown. You can accept it later if you change your mind."
        : "It stays listed as void and its rounds stop counting. You can un-void it.",
      fields: [{ name: "reason", label: "Reason (optional)", type: "textarea", maxlength: 500, placeholder: "Shown in the action log" }],
      ok: action === "reject" ? "Reject" : "Void",
      danger: true,
      submit: ({ reason }) => send(reason ? { reason } : {}),
    });
    if (message) {
      toast(message);
      await refresh();
    }
  }

  async function matchView(view, [id]) {
    const { match: m } = await api(`matches/${id}`);
    view.append(head([crumb("#/matches", "Matches"), h("h1", {}, `Match #${m.id} `, statusChip(m.status))], matchButtons(m, true)));
    view.append(h("dl", { class: "fact-grid" },
      fact("Region", regionLabel(m.region)),
      fact("Played", h("span", { title: longTime(m.playedAt) }, longTime(m.playedAt))),
      fact("Host", h("a", { href: "#/hosts" }, m.hostName), h("small", {}, ` #${m.hostId}`)),
      fact("Map", m.map ?? "–"),
      fact("Preset", m.preset ?? "–"),
      fact("Log lines", m.lineCount),
      fact("Rated", m.rated ? "Yes" : "No"),
      fact("Complete", m.complete ? "Yes" : "No, no MATCH_END")));

    if (m.reviewReasons.length || m.rejection) {
      view.append(section(m.status === "review" ? "Why it's in review" : "Notes"));
      view.append(h("ul", { class: "reasons" },
        m.reviewReasons.map((r) => h("li", {}, reasonText(r), r.startsWith("tourney_") && h("small", {}, "Link it to its lobby from the tourney's page, then accept it. Or accept it as a ranked match."))),
        m.rejection && h("li", { class: "bad" }, m.rejection.message || "Rejected", h("small", {}, m.rejection.code))));
    }

    view.append(section(count(m.players.length, "player", "players")));
    view.append(h("ul", { class: "names" }, m.players.map((p) => h("li", {}, p))));

    view.append(section("More"));
    const tourneyButton = btn(m.tournament ? "Make it a ranked match" : "Make it a tourney match", async () => {
      const ok = await confirmAction(m.tournament ? `Make match #${m.id} a ranked match?` : `Make match #${m.id} a tourney match?`,
        m.tournament ? "It's rated as a normal match. A match a tourney lobby links can't be changed here: unlink it from the lobby." : "Its standings are rated with the tourney weight and caps. Usually you link it to its lobby instead.",
        "Change", false);
      if (ok) await run(`Match #${m.id}`, async () => `Match #${m.id} is ${m.tournament ? "a ranked" : "a tourney"} match.` + staleNote(await post(`matches/${m.id}/tournament`, { tournament: !m.tournament })));
    });
    view.append(h("div", { class: "more" },
      h("div", {}, h("b", {}, "Region"), h("p", { class: "muted" }, "If the host uploaded it under the wrong region. Its ratings leave this region and it's rated in the other."),
        h("div", { class: "row" }, regions.filter((r) => r.id !== m.region).map((r) => btn(`Move to ${r.label}`, async () => {
          const ok = await confirmAction(`Move match #${m.id} to ${r.label}?`, `Its ratings leave ${regionLabel(m.region)} and it's rated in ${r.label}.`, "Move");
          if (ok) await run(`Match #${m.id}`, async () => `Match #${m.id} is in ${r.label}.` + staleNote(await post(`matches/${m.id}/region`, { region: r.id })));
        })))),
      h("div", {}, h("b", {}, "Tourney"), h("p", { class: "muted" }, m.tournament ? "It counts as a tourney match." : "It counts as a ranked match."), h("div", { class: "row" }, tourneyButton)),
      (m.status === "accepted" || m.status === "void") && h("div", {}, h("b", {}, "Public page"), h("p", { class: "muted" }, "What players see."), h("a", { href: `/match?id=${m.id}`, target: "_blank" }, "Open match page ↗"))));
  }

  const fact = (label, ...value) => h("div", {}, h("dt", {}, label), h("dd", {}, value));

  // ---- Tourneys ----

  let hostCache = null;
  async function hosts() {
    hostCache ??= api("hosts").then((r) => r.hosts);
    try {
      return await hostCache;
    } catch (e) {
      hostCache = null;
      throw e;
    }
  }

  function tourneyFields(t = null) {
    return [
      { name: "name", label: "Name", required: true, maxlength: 200, value: t?.name },
      { name: "region", label: "Region", type: "select", required: true, options: regionOptions(), value: t?.region ?? site.region },
      { name: "start", label: "Starts", type: "datetime-local", required: true, value: t ? localInput(t.startsAt) : "", hint: `In your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).` },
      { name: "notes", label: "Notes (optional)", type: "textarea", maxlength: 1000, value: t?.notes ?? "", placeholder: "Shown on the tourney's page" },
    ];
  }
  const startsAt = (start) => {
    const date = new Date(start);
    if (Number.isNaN(date.getTime())) throw new Error("That start time isn't a date.");
    return date.toISOString();
  };

  async function newTourney() {
    const res = await ask({
      title: "Schedule a tourney",
      fields: tourneyFields(),
      ok: "Schedule",
      submit: (v) => post("tourneys", { name: v.name, region: v.region, startsAt: startsAt(v.start), notes: v.notes }),
    });
    if (res) {
      toast(`${res.tourney.name} is scheduled. Add its lobbies next.`);
      location.hash = `#/tourneys/${res.tourney.id}`;
    }
  }

  async function tourneysView(view) {
    const { tourneys } = await api("tourneys");
    view.append(head("Tourneys", btn("Schedule a tourney", newTourney, "primary")));
    view.append(h("p", { class: "lede" }, "A lobby's match is a tourney match: it counts more on the leaderboard. After it's played, upload the host's screenshot of the final standings and verify it against the standings."));
    const upcoming = tourneys.filter((t) => t.status === "scheduled" || t.status === "live").sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const past = tourneys.filter((t) => t.status === "done" || t.status === "cancelled");
    view.append(section("Upcoming and live"), upcoming.length ? h("div", { class: "cards" }, upcoming.map(tourneyCard)) : empty("No tourney is scheduled."));
    if (past.length) view.append(section("Past"), h("div", { class: "cards" }, past.map(tourneyCard)));
  }

  function tourneyCard(t) {
    const todos = tourneyTodos(t);
    const ready = t.lobbies.filter((l) => l.hostId).length;
    return h("a", { class: "card tourney-card", href: `#/tourneys/${t.id}` },
      h("div", { class: "card-top" }, h("b", {}, t.name), statusChip(t.status)),
      h("p", { class: "muted" }, regionLabel(t.region), " · ", longTime(t.startsAt)),
      meter(t.signups.count, t.capacity, `${t.signups.count} / ${t.capacity} signed up${t.signups.open ? "" : " (closed)"}`),
      h("p", { class: "card-foot" }, h("span", {}, `${count(t.lobbies.length, "lobby", "lobbies")}, ${ready} with a host`),
        todos.length ? chip(count(todos.length, "job", "jobs"), "warn") : chip("All set", "good")));
  }

  function meter(value, max, label) {
    const over = max > 0 && value > max;
    return h("div", { class: `meter${over ? " over" : ""}` }, h("div", { class: "track" }, h("span", { style: `width: ${max ? Math.min(100, (value / max) * 100) : 0}%` })), h("small", {}, label));
  }

  async function tourneyView(view, [id]) {
    const [{ tourneys }, { signups }] = await Promise.all([api("tourneys"), api(`tourneys/${id}/signups`)]);
    const t = tourneys.find((x) => x.id === Number(id));
    if (!t) return notFound(view);
    const edit = btn("Edit", async () => {
      const res = await ask({
        title: `Edit ${t.name}`,
        fields: tourneyFields(t),
        submit: (v) => post(`tourneys/${t.id}`, { name: v.name, region: v.region, startsAt: startsAt(v.start), notes: v.notes }),
      });
      if (res) {
        toast(`${res.tourney?.name ?? t.name} saved.`);
        await refresh();
      }
    });
    view.append(head([crumb("#/tourneys", "Tourneys"), h("h1", {}, t.name)],
      h("a", { class: "button", href: `/tourney?id=${t.id}`, target: "_blank" }, "Public page ↗"), edit));
    view.append(h("div", { class: "toolbar" },
      seg(["scheduled", "live", "done", "cancelled"].map((s) => [s, s[0].toUpperCase() + s.slice(1)]), t.status, (status) => status !== t.status &&
        run(t.name, () => post(`tourneys/${t.id}`, { status }).then(() => `${t.name} is ${status}.`)), "Status"),
      h("span", { class: "muted" }, regionLabel(t.region), " · ", longTime(t.startsAt), " (", time(t.startsAt), ")")));
    if (t.notes) view.append(h("p", { class: "lede" }, t.notes));

    const over = t.signups.count - t.capacity;
    view.append(section(`Lobbies`, btn("Add a lobby", () => addLobby(t), over > 0 ? "primary" : "")));
    if (over > 0) view.append(h("p", { class: "callout warn" }, `${count(over, "player", "players")} more signed up than the lobbies hold. Add a lobby, or another tourney.`));
    view.append(t.lobbies.length ? h("div", { class: "lobby-grid" }, t.lobbies.map((l) => lobbyCard(t, l))) : empty("No lobbies yet. Add one for every 10 or so sign-ups."));

    view.append(signupSection(t, signups));
  }

  async function addLobby(t) {
    const hostList = (await hosts()).filter((x) => x.trust !== "revoked");
    const res = await ask({
      title: `Add a lobby to ${t.name}`,
      fields: [
        { name: "label", label: "Label", required: true, maxlength: 100, value: `Lobby ${t.lobbies.length + 1}` },
        { name: "hostId", label: "Host", type: "select", options: [["", "No host yet"], ...hostList.map((x) => [x.id, `${x.name} (${regionLabel(x.region)})`])], hint: "They get the tourney code in the host tool and upload the screenshot." },
        { name: "roundLimit", label: "Rounds", type: "number", min: 1, max: 50, placeholder: "Default (30)", inputmode: "numeric" },
        { name: "capacity", label: "Players it holds", type: "number", min: 1, max: 12, placeholder: "Default (10)", inputmode: "numeric" },
      ],
      ok: "Add lobby",
      submit: (v) => post(`tourneys/${t.id}/lobbies`, {
        label: v.label,
        ...(v.hostId && { hostId: Number(v.hostId) }),
        ...(v.roundLimit && { roundLimit: Number(v.roundLimit) }),
        ...(v.capacity && { capacity: Number(v.capacity) }),
      }),
    });
    if (res) {
      toast(`${res.lobby.label} added.`);
      await refresh();
    }
  }

  function lobbyCard(t, l) {
    const edit = btn("Edit", async () => {
      const res = await ask({
        title: `Edit ${l.label}`,
        fields: [
          { name: "label", label: "Label", required: true, maxlength: 100, value: l.label },
          { name: "roundLimit", label: "Rounds", type: "number", min: 1, max: 50, value: l.roundLimitDefault ? "" : l.roundLimit, placeholder: "Default (30)", inputmode: "numeric" },
          { name: "capacity", label: "Players it holds", type: "number", min: 1, max: 12, value: l.capacityDefault ? "" : l.capacity, placeholder: "Default (10)", inputmode: "numeric" },
        ],
        submit: (v) => post(`lobbies/${l.id}`, { label: v.label, roundLimit: v.roundLimit ? Number(v.roundLimit) : null, capacity: v.capacity ? Number(v.capacity) : null }),
      });
      if (res) {
        toast(`${res.lobby?.label ?? l.label} saved.`);
        await refresh();
      }
    }, "small");
    const remove = btn("Delete", async () => {
      const ok = await confirmAction(`Delete ${l.label}?`, l.matchId ? `Its match #${l.matchId} stops being a tourney match, and its screenshot is deleted.` : "Its screenshot, if any, is deleted too.", "Delete");
      if (ok) await run(`Delete ${l.label}`, async () => `${l.label} deleted.` + staleNote(await api(`lobbies/${l.id}`, { method: "DELETE" })));
    }, "small ghost danger");

    const card = h("article", { class: "card lobby-card" },
      h("div", { class: "card-top" }, h("b", {}, l.label), h("div", { class: "head-actions" }, edit, remove)),
      h("p", { class: "muted small" }, `${l.roundLimit} rounds${l.roundLimitDefault ? " (default)" : ""} · holds ${l.capacity}${l.capacityDefault ? " (default)" : ""}`),
      h("ol", { class: "steps" }, hostStep(l), matchStep(t, l), screenshotStep(l), verifyStep(t, l)));

    // An image dropped on the card is its screenshot.
    card.addEventListener("dragover", (e) => {
      if (![...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) return;
      e.preventDefault();
      card.classList.add("drop");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drop");
      const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
      if (file) run(`Screenshot for ${l.label}`, () => putScreenshot(l, file));
    });
    return card;
  }

  const step = (done, title, body, actions) => h("li", { class: done ? "done" : "" }, h("span", { class: "dot", "aria-hidden": "true" }),
    h("div", {}, h("b", {}, title), h("div", { class: "step-body" }, body), actions && h("div", { class: "row" }, actions)));

  function hostStep(l) {
    const pick = btn(l.hostId ? "Change" : "Assign a host", async () => {
      const hostList = (await hosts()).filter((x) => x.trust !== "revoked");
      const res = await ask({
        title: `Host of ${l.label}`,
        text: "They get the tourney code in the host tool and upload the screenshot. Any host can run it, whatever their home region.",
        fields: [{ name: "hostId", label: "Host", type: "select", value: l.hostId ?? "", options: [["", "No host"], ...hostList.map((x) => [x.id, `${x.name} (${x.trust}, ${regionLabel(x.region)})`])] }],
        submit: ({ hostId }) => post(`lobbies/${l.id}`, { hostId: hostId ? Number(hostId) : null }),
      });
      if (res) {
        const name = hostList.find((x) => x.id === res.lobby?.hostId)?.name;
        toast(res.lobby?.hostId ? `${l.label} is hosted by ${name ?? `host #${res.lobby.hostId}`}.` : `${l.label} has no host.`);
        await refresh();
      }
    }, "small");
    return step(Boolean(l.hostId), "Host", l.hostId ? l.hostName : h("span", { class: "faint" }, "None yet"), pick);
  }

  async function matchPreview(value) {
    const digits = value.replace(/^#\s*/, "");
    if (!digits) return "";
    if (!/^[1-9]\d*$/.test(digits)) return h("span", { class: "error" }, "A match id is a number, like 123.");
    try {
      const { match: m } = await api(`matches/${digits}`);
      return h("div", { class: "match-preview" }, h("b", {}, `#${m.id} `), statusChip(m.status), " ", regionChip(m.region),
        h("small", {}, `${longTime(m.playedAt)} · hosted by ${m.hostName} · ${count(m.players.length, "player", "players")}`));
    } catch (e) {
      return h("span", { class: "error" }, e.message);
    }
  }

  function matchStep(t, l) {
    const link = btn(l.matchId ? "Change" : "Link a match", async () => {
      const res = await ask({
        title: `Match of ${l.label}`,
        text: "Uploads with the lobby's tourney code link on their own. Link one by hand when it didn't (it's in review), or to fix a link.",
        fields: [{ name: "matchId", label: "Match id", value: l.matchId ?? "", required: true, inputmode: "numeric", placeholder: "123", preview: matchPreview, hint: `It must be from ${regionLabel(t.region)}.` }],
        ok: "Link",
        submit: async ({ matchId }) => {
          const digits = matchId.replace(/^#\s*/, "");
          if (!/^[1-9]\d*$/.test(digits)) throw new Error("Enter a match id, like 123.");
          return post(`lobbies/${l.id}`, { matchId: Number(digits) });
        },
      });
      if (res) {
        toast(`${l.label} is match #${res.lobby.matchId}.${staleNote(res)}`);
        await refresh();
      }
    }, "small");
    const unlink = l.matchId && btn("Move to ranked", async () => {
      const ok = await confirmAction(`Move match #${l.matchId} back to ranked?`, `It stops being a tourney match and is rated as a normal one. ${l.label} has no result until a match is linked again. To drop the match instead, void it.`, "Move to ranked");
      if (ok) await run(l.label, async () => `Match #${l.matchId} is a ranked match again.` + staleNote(await post(`lobbies/${l.id}`, { matchId: null })));
    }, "small ghost");
    return step(Boolean(l.matchId), "Match", l.matchId ? h("a", { href: `#/matches/${l.matchId}` }, `Match #${l.matchId}`) : h("span", { class: "faint" }, t.status === "scheduled" ? "After it's played" : "Not linked"), [link, unlink]);
  }

  async function putScreenshot(lobby, file) {
    await api(`lobbies/${lobby.id}/screenshot`, { method: "PUT", raw: file });
    return `Screenshot uploaded for ${lobby.label}. Check it against the standings, then verify.`;
  }

  function screenshotStep(l) {
    const upload = btn(l.screenshotKey ? "Replace" : "Upload", () => new Promise((resolve) => {
      const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
      input.addEventListener("change", async () => {
        if (input.files[0]) await run(`Screenshot for ${l.label}`, () => putScreenshot(l, input.files[0]));
        resolve();
      });
      input.addEventListener("cancel", resolve);
      input.click();
    }), "small");
    const remove = l.screenshotKey && btn("Delete", async () => {
      if (await confirmAction(`Delete ${l.label}'s screenshot?`, "The lobby needs a new one to be verified.", "Delete")) {
        await run("Delete screenshot", () => api(`lobbies/${l.id}/screenshot`, { method: "DELETE" }).then(() => "Screenshot deleted."));
      }
    }, "small ghost");
    const src = l.screenshotKey && `/api/screenshots/${l.screenshotKey}`;
    const body = src
      ? h("button", { type: "button", class: "thumb", onclick: () => lightbox(src), title: "Enlarge" }, h("img", { src, alt: `${l.label}'s final standings`, loading: "lazy" }))
      : l.screenshotExpiredAt ? h("span", { class: "faint" }, "No longer kept (", time(l.screenshotExpiredAt), ")") : h("span", { class: "faint" }, "None yet. Drop an image on this card, or upload one.");
    return step(Boolean(l.screenshotKey || l.screenshotExpiredAt), "Screenshot", body, [upload, remove]);
  }

  function verifyStep(t, l) {
    if (l.verifiedAt) {
      return step(true, "Verified", h("span", {}, `by ${l.verifiedBy}, `, time(l.verifiedAt)),
        btn("Unverify", () => run(l.label, () => post(`lobbies/${l.id}/verify`, { verified: false, version: l.version }).then(() => `${l.label} is unverified.`)), "small ghost"));
    }
    if (!(l.matchId && l.screenshotKey)) return step(false, "Verify", h("span", { class: "faint" }, "Needs a match and a screenshot"));
    return step(false, "Verify", h("span", {}, "Check the screenshot against the ", h("a", { href: `/tourney?id=${t.id}`, target: "_blank" }, "standings ↗")),
      btn("Verify", () => run(l.label, () => post(`lobbies/${l.id}/verify`, { verified: true, version: l.version }).then(() => `${l.label} is verified.`)), "small primary"));
  }

  function signupSection(t, signups) {
    const showRemoved = currentRoute().query.get("removed") === "1";
    const active = signups.filter((s) => !s.removedAt);
    const removed = signups.length - active.length;
    const box = h("div", {});
    box.append(section(`Sign-ups`, removed ? h("label", { class: "check inline" },
      h("input", { type: "checkbox", checked: showRemoved, onchange: (e) => { setQuery({ removed: e.target.checked ? "1" : "" }); refresh(); } }), h("span", {}, `Show removed (${removed})`)) : null));
    box.append(meter(t.signups.count, t.capacity, `${t.signups.count} of ${t.capacity} places${t.signups.open ? "" : " · sign-ups are closed"}`));
    if (!signups.length) {
      box.append(empty("No sign-ups yet."));
      return box;
    }
    let place = 0;
    const rows = signups.filter((s) => showRemoved || !s.removedAt).map((s) => {
      if (!s.removedAt) place++;
      const over = !s.removedAt && place > t.capacity;
      return h("tr", { class: s.removedAt ? "removed" : over ? "over" : null },
        h("td", { class: "num" }, s.removedAt ? "" : place),
        h("td", {}, h("b", {}, s.name), s.discordUserId && chip("Discord", "plain"), over && chip("Over capacity", "warn")),
        h("td", {}, time(s.signedUpAt)),
        h("td", { class: "muted" }, s.removedAt ? ["Removed by ", s.removedBy, ", ", time(s.removedAt)] : ""),
        h("td", { class: "actions" }, s.removedAt
          ? btn("Restore", () => run(s.name, () => post(`signups/${s.id}`, { removed: false }).then(() => `${s.name} is signed up again.`)), "small")
          : btn("Remove", async () => {
            if (await confirmAction(`Remove ${s.name}?`, `They drop off ${t.name}'s sign-ups, and the name can't sign up again unless you restore it.`, "Remove")) {
              await run(s.name, () => post(`signups/${s.id}`, { removed: true }).then(() => `${s.name} removed from the sign-ups.`));
            }
          }, "small ghost")));
    });
    box.append(scroll(table(["#", "Name", "Signed up", "", ""], rows)));
    return box;
  }

  // ---- Hosts ----

  async function hostsView(view, _params, query) {
    hostCache = null;
    const list = await hosts();
    const showRevoked = query.get("revoked") === "1";
    const filter = h("input", { type: "search", placeholder: "Filter by name", value: query.get("q") ?? "", "data-autofocus": true });
    const box = h("div", {});
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      setQuery({ q });
      const shown = list.filter((x) => (showRevoked || x.trust !== "revoked") && (!q || x.name.toLowerCase().includes(q)));
      box.replaceChildren(shown.length ? scroll(table(["Host", "Trust", "Home region", "Created", "Last upload", ""], shown.map(hostRow))) : empty("No host fits."));
    };
    filter.addEventListener("input", draw);
    const revoked = list.filter((x) => x.trust === "revoked").length;
    view.append(head("Hosts", btn("New host", newHost, "primary")),
      h("p", { class: "lede" }, "A host uploads with their own token from the host tool. A trusted host's matches count straight away; an untrusted host's wait in review."),
      h("div", { class: "toolbar" }, h("label", { class: "search" }, filter),
        revoked ? h("label", { class: "check inline" }, h("input", { type: "checkbox", checked: showRevoked, onchange: (e) => { setQuery({ revoked: e.target.checked ? "1" : "" }); refresh(); } }), h("span", {}, `Show revoked (${revoked})`)) : null),
      box);
    draw();
  }

  function hostRow(x) {
    const revoked = x.trust === "revoked";
    const regionSelect = h("select", { "aria-label": `${x.name}'s home region`, disabled: revoked }, regionOptions(["", "None"]).map(([v, l]) => h("option", { value: v, selected: (x.region ?? "") === v }, l)));
    regionSelect.addEventListener("change", () => run(x.name, () => post(`hosts/${x.id}/region`, { region: regionSelect.value || null })
      .then(() => `${x.name}'s home region is ${regionLabel(regionSelect.value || null)}. Stored matches keep theirs.`)));
    const other = x.trust === "trusted" ? "untrusted" : "trusted";
    return h("tr", { class: revoked ? "removed" : null },
      h("td", {}, h("b", {}, x.name), h("small", { class: "muted" }, ` #${x.id}`)),
      h("td", {}, chip(x.trust, x.trust === "trusted" ? "good" : x.trust === "revoked" ? "bad" : "warn")),
      h("td", {}, regionSelect),
      h("td", {}, time(x.createdAt)),
      h("td", {}, time(x.lastUploadAt)),
      h("td", { class: "actions" }, revoked ? null : [
        btn(`Make ${other}`, () => run(x.name, () => post(`hosts/${x.id}/trust`, { trust: other }).then(() => `${x.name} is ${other}. It applies from their next upload.`)), "small"),
        btn("Revoke", async () => {
          if (await confirmAction(`Revoke ${x.name}'s token?`, "Their uploads stop working straight away. This can't be undone: they'd need a new host token.", "Revoke")) {
            await run(x.name, () => post(`hosts/${x.id}/revoke`).then(() => `${x.name}'s token is revoked.`));
          }
        }, "small ghost danger"),
      ]));
  }

  async function newHost() {
    const res = await ask({
      title: "New host",
      text: "Makes a host token for the host tool. You'll see the token once, right after.",
      fields: [
        { name: "name", label: "Name", required: true, maxlength: 200, placeholder: "Their Discord or in-game name" },
        { name: "trust", label: "Trust", type: "select", value: "untrusted", options: [["untrusted", "Untrusted: their matches wait in review"], ["trusted", "Trusted: their matches count straight away"]] },
        { name: "region", label: "Home region", type: "select", value: site.region, options: regionOptions(["", "None: each upload says"]), hint: "Where their uploads were played, when the host tool doesn't say." },
      ],
      ok: "Create token",
      submit: (v) => post("hosts", { name: v.name, trust: v.trust, region: v.region || null }),
    });
    if (!res) return;
    hostCache = null;
    await refresh();
    const code = h("code", {}, res.token);
    await ask({
      title: `Token for ${res.host.name}`,
      text: h("p", { class: "callout warn" }, "Copy it now and send it to them privately. It isn't shown again: if it's lost, revoke it and make a new one."),
      fields: [{ name: "token", render: () => ({ el: h("div", { class: "token" }, code, btn("Copy", () => copy(res.token), "small primary")), get: () => null }) }],
      ok: "Done",
      cancel: false,
    });
  }

  // ---- Players ----

  async function playersView(view, _params, query) {
    const input = h("input", { type: "search", placeholder: "Name or old name", value: query.get("q") ?? "", "data-autofocus": true, "aria-label": "Find a player" });
    const results = h("div", {});
    let timer;
    const search = async () => {
      const q = input.value.trim();
      setQuery({ q });
      if (q.length < 2) return results.replaceChildren(empty("Type at least two letters of a name, old names too."));
      try {
        const { players } = await api(`players?search=${encodeURIComponent(q)}`);
        if (input.value.trim() !== q) return;
        results.replaceChildren(players.length ? h("ul", { class: "player-list" }, players.map((p) => h("li", {}, h("a", { href: `#/players/${p.id}` },
          h("b", {}, p.name), h("small", {}, `#${p.id}`), h("span", { class: "muted" }, p.aliases.filter((a) => a !== p.name).join(", ")))))) : empty("No player has that name."));
      } catch (e) {
        results.replaceChildren(h("p", { class: "error" }, e.message));
      }
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(search, 250);
    });
    const { merges } = await api("merges");
    view.append(head("Players"),
      h("p", { class: "lede" }, "When a player changes name, merge the old name into the new one: their names, matches and ratings become one player. A merge can be undone. It only joins names; it doesn't tell who is behind an account."),
      h("label", { class: "search big" }, input), results,
      section("Recent merges"), mergeTable(merges));
    await search();
  }

  function mergeTable(merges) {
    if (!merges.length) return empty("No merges yet.");
    return scroll(table(["Merged", "Into", "Names moved", "By", ""], merges.map((m) => h("tr", { class: m.undoneAt ? "removed" : null },
      h("td", {}, h("a", { href: `#/players/${m.from.id}` }, m.from.name)),
      h("td", {}, h("a", { href: `#/players/${m.into.id}` }, m.into.name)),
      h("td", { class: "muted" }, m.aliases.join(", ")),
      h("td", {}, m.mergedBy, ", ", time(m.mergedAt), m.undoneAt && h("small", { class: "muted" }, h("br"), `undone by ${m.undoneBy}, `, time(m.undoneAt))),
      h("td", { class: "actions" }, !m.undoneAt && btn("Undo", async () => {
        if (await confirmAction(`Undo merging ${m.from.name} into ${m.into.name}?`, `${m.from.name} gets their names and matches back, and the ratings are rebuilt.`, "Undo merge")) {
          await run("Undo merge", async () => `${m.from.name} is their own player again.` + staleNote(await post(`merges/${m.id}/undo`)));
        }
      }, "small ghost"))))));
  }

  async function playerView(view, [id]) {
    const { player: p, merges } = await api(`players/${id}`);
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
          return post(`players/${p.id}/name`, { name: v.follow ? null : v.name });
        },
      });
      if (res) {
        toast(`Player #${p.id} is ${res.player.name}.`);
        await refresh();
      }
    });
    const merge = btn("Merge into…", async () => {
      const res = await ask({
        title: `Merge ${p.name} into another player`,
        text: `${p.name}'s names and matches become the other player's, who keeps their id. Use it when one person played under both names.`,
        fields: [{ name: "into", render: () => playerPicker(p.id) }],
        ok: "Merge",
        danger: true,
        submit: async ({ into }) => {
          if (!into) throw new Error("Pick the player to merge into.");
          return { into, res: await post(`players/${p.id}/merge`, { into }) };
        },
      });
      if (res) {
        toast(`${p.name} merged.${staleNote(res.res)}`);
        location.hash = `#/players/${res.into}`;
      }
    }, "danger");
    const alt = btn(p.alt ? "Not an alt" : "Mark as alt", async () => {
      const ok = p.alt
        ? await confirmAction(`${p.name} isn't an alt?`, `${p.name} goes back on the leaderboard with a place, like anyone.`, "Not an alt")
        : await confirmAction(`Mark ${p.name} as an alt?`, "They're rated as normal and their profile and matches stay public, with an \"alt\" tag. They aren't on the leaderboard (nor the in-game top 10 or the Discord bot's) and have no place there. Nothing is recomputed.", "Mark as alt");
      if (ok) await run("Alt", async () => (await post(`players/${p.id}/alt`, { alt: !p.alt })).player.alt ? `${p.name} is an alt.` : `${p.name} isn't an alt.`);
    });
    view.append(head([crumb("#/players", "Players"), h("h1", {}, p.name, " ", h("small", { class: "muted id" }, `#${p.id}`), p.alt && chip("Alt", "plain"))],
      h("a", { class: "button", href: `/player?id=${p.id}`, target: "_blank" }, "Public page ↗"),
      !p.mergedInto && rename, !p.mergedInto && alt, !p.mergedInto && merge));
    if (p.mergedInto) view.append(h("p", { class: "callout" }, "Merged into ", h("a", { href: `#/players/${p.mergedInto}` }, `player #${p.mergedInto}`), ". Undo the merge below to split them again."));
    view.append(h("dl", { class: "fact-grid" },
      fact("Matches", p.matches),
      fact("Name", p.nameFixed ? "Set by an admin" : "From the logs"),
      fact("Leaderboard", p.alt ? "Hidden: an alt" : "Listed"),
      fact("First seen", time(p.createdAt))));

    view.append(section("Ratings"));
    view.append(p.ratings.length ? scroll(table(["Region", "Rating", "Rounds", "Won", "Last played"], p.ratings.map((r) => h("tr", {},
      h("td", {}, regionLabel(r.region)), h("td", { class: "num" }, Math.round(r.rating)), h("td", { class: "num" }, r.rounds), h("td", { class: "num" }, r.wins), h("td", {}, time(r.lastPlayedAt)))))) : empty("No rated rounds yet."));

    view.append(section(count(p.aliases.length, "name", "names")));
    view.append(scroll(table(["Name", "First seen", "Last seen"], p.aliases.map((a) => h("tr", {},
      h("td", {}, h("b", {}, a.name), a.name === p.name && chip("Display", "plain")), h("td", {}, time(a.firstSeenAt, "–")), h("td", {}, time(a.lastSeenAt, "–")))))));

    view.append(section("Merges"), mergeTable(merges));
  }

  // ---- Action log ----

  const words = (action) => action.replaceAll("_", " ");
  function detailText(detail) {
    if (detail === null || detail === undefined) return "";
    if (typeof detail !== "object") return String(detail);
    return Object.entries(detail).map(([k, v]) => `${k}: ${v === null ? "none" : typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
  }

  function actionTable(actions) {
    if (!actions.length) return empty("Nothing yet.");
    return scroll(table(["When", "Admin", "Action", "Match", "Host", "Detail"], actions.map((a) => h("tr", {},
      h("td", {}, time(a.at)), h("td", {}, a.admin), h("td", {}, h("b", {}, words(a.action))),
      h("td", {}, a.matchId && h("a", { href: `#/matches/${a.matchId}` }, `#${a.matchId}`)),
      h("td", {}, a.hostId && `#${a.hostId}`),
      h("td", { class: "detail" }, detailText(a.detail))))));
  }

  async function logView(view, _params, query) {
    const { actions } = await api("actions");
    const filter = h("input", { type: "search", placeholder: "Filter by admin, action or detail", value: query.get("q") ?? "", "data-autofocus": true });
    const box = h("div", {});
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      setQuery({ q });
      box.replaceChildren(actionTable(q ? actions.filter((a) => [a.admin, words(a.action), detailText(a.detail), String(a.matchId ?? "")].some((s) => s.toLowerCase().includes(q))) : actions));
    };
    filter.addEventListener("input", draw);
    view.append(head("Action log"), h("p", { class: "lede" }, "Every change an admin makes, newest first."), h("div", { class: "toolbar" }, h("label", { class: "search" }, filter)), box);
    draw();
  }

  // ---- Tools ----

  async function toolsView(view) {
    const hostList = await hosts();
    view.append(head("Tools"));

    // Dry-run parse.
    const file = h("input", { type: "file", accept: ".txt,text/plain", required: true });
    const fileName = h("span", { class: "muted" }, "Drop a Workshop log here, or pick one");
    file.addEventListener("change", () => (fileName.textContent = file.files[0]?.name ?? "Drop a Workshop log here, or pick one"));
    const drop = h("label", { class: "dropzone" }, file, h("b", {}, "Log file"), fileName);
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("drop");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drop"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drop");
      if (e.dataTransfer.files[0]) {
        file.files = e.dataTransfer.files;
        file.dispatchEvent(new Event("change"));
      }
    });
    const host = h("select", {}, [["", "No host: judge as trusted, nothing stored"], ...hostList.map((x) => [x.id, `${x.name} (${x.trust})`])].map(([v, l]) => h("option", { value: v }, l)));
    const region = h("select", {}, regionOptions(["", "The host's home region"]).map(([v, l]) => h("option", { value: v }, l)));
    const legacy = h("input", { type: "checkbox" });
    const result = h("div", {});
    const parse = btn("Parse", async () => {
      if (!file.files[0]) return toast("Pick a log file first.", "error");
      const params = new URLSearchParams();
      if (host.value) params.set("host", host.value);
      if (region.value) params.set("region", region.value);
      if (legacy.checked) params.set("legacy", "1");
      try {
        result.replaceChildren(parseResult(await api(`parse?${params}`, { method: "POST", raw: file.files[0] })));
      } catch (e) {
        result.replaceChildren(h("p", { class: "callout bad" }, e.message));
      }
    }, "primary");
    view.append(h("section", { class: "card tool" },
      h("h2", {}, "Dry-run a log"), h("p", { class: "muted" }, "What an upload of this file would do and what the parser read. Nothing is written."),
      drop,
      h("div", { class: "fields" }, h("label", { class: "field" }, h("span", {}, "As if uploaded by"), host), h("label", { class: "field" }, h("span", {}, "Region"), region)),
      h("label", { class: "check" }, legacy, h("span", {}, "Old v1.3.2 log"), h("small", {}, "Read it as the legacy import would. Needs a host.")),
      h("div", { class: "row" }, parse), result));

    // Recompute.
    view.append(h("section", { class: "card tool" },
      h("h2", {}, "Recompute ratings"), h("p", { class: "muted" }, "Marks a region's ratings stale, from its first match or from one match on. The cron recomputes them within 10 minutes; the site shows a banner meanwhile."),
      h("div", { class: "row" }, btn("Recompute…", recompute))));
  }

  async function recompute() {
    const res = await ask({
      title: "Recompute ratings",
      fields: [
        { name: "region", label: "Region", type: "select", required: true, value: site.region, options: regionOptions() },
        { name: "from", label: "From match (optional)", type: "number", min: 1, inputmode: "numeric", placeholder: "From the first match", hint: "Matches before it keep their ratings.", preview: matchPreview },
      ],
      ok: "Recompute",
      danger: true,
      submit: (v) => post(`ratings/recompute?region=${v.region}${v.from ? `&from=${v.from}` : ""}`),
    });
    if (res) toast(`${regionLabel(res.region)} ratings will be recomputed${res.from ? ` from match #${res.from}` : ""}.`);
  }

  function parseResult(r) {
    const u = r.upload;
    const ok = u.status < 300;
    const box = h("div", { class: "parse" });
    box.append(h("p", { class: `callout ${ok ? "good" : "bad"}` }, h("b", {}, `${u.status} ${u.result ?? u.error ?? ""}`), " ",
      u.message ?? (ok ? `An upload would answer ${u.result}${u.matches ? `, with ${count(u.matches.length, "match", "matches")}` : ""}.` : ""),
      r.duplicateOf && ` It's the same file as match #${r.duplicateOf}.`));
    if (r.parser.error) box.append(h("p", { class: "callout bad" }, `Parser: ${r.parser.error.message}`));
    for (const m of r.parser.matches) {
      box.append(h("div", { class: "card" },
        h("div", { class: "card-top" }, h("b", {}, `Match ${m.matchKey}`), h("span", {}, chip(m.action, "plain"), " ", statusChip(m.status))),
        h("dl", { class: "fact-grid small" },
          fact("Region", m.region ? regionLabel(m.region) : "–"), fact("Version", m.gameVersion ?? "–"), fact("Map", m.settings?.map ?? "–"),
          fact("Players", m.players.length), fact("Rated rounds", `${m.ratedRounds} of ${m.rounds.length}`), fact("Kills", m.kills ?? "–"),
          fact("Complete", m.complete ? "Yes" : "No"), m.storedMatchId && fact("Stored as", h("a", { href: `#/matches/${m.storedMatchId}` }, `#${m.storedMatchId}`))),
        (m.reviewReasons.length > 0 || m.rejection) && h("ul", { class: "reasons" }, m.reviewReasons.map((x) => h("li", {}, reasonText(x))), m.rejection && h("li", { class: "bad" }, m.rejection.message)),
        h("p", { class: "muted small" }, m.players.map((p) => p.name).join(", ")),
        m.problems.length > 0 && h("details", {}, h("summary", {}, count(m.problems.length, "skipped line", "skipped lines")), h("ul", {}, m.problems.map((p) => h("li", {}, `Line ${p.line}: ${p.message}`))))));
    }
    if (r.parser.warnings.length) box.append(h("ul", { class: "reasons" }, r.parser.warnings.map((w) => h("li", {}, typeof w === "string" ? w : w.message ?? JSON.stringify(w)))));
    box.append(h("details", {}, h("summary", {}, "Full answer"), h("pre", {}, JSON.stringify(r, null, 2))));
    return box;
  }

  // ---- Signing in ----

  async function signIn() {
    const { admin } = await api("me");
    $("admin-name").textContent = admin.name;
    ({ regions } = await site.server);
    $("signin").hidden = true;
    $("app").hidden = false;
    site.pin();
    await refresh({ top: true });
  }

  function signOut(message = null) {
    token = null;
    hostCache = null;
    storage.set(null);
    $("app").hidden = true;
    $("signin").hidden = false;
    $("signin-error").textContent = message ?? "";
    $("signin-error").hidden = !message;
    $("token").focus();
  }

  $("signin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    token = $("token").value.trim();
    storage.set(token);
    $("token").value = "";
    button.disabled = true;
    button.classList.add("busy");
    try {
      await signIn();
    } catch (e) {
      if (token) signOut(e.message);
    } finally {
      button.disabled = false;
      button.classList.remove("busy");
    }
  });
  $("signout").addEventListener("click", () => signOut());

  // "/" focuses the view's search box.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.target.closest("input, textarea, select") || document.querySelector("dialog[open]")) return;
    const box = $("view").querySelector("input[type=search]");
    if (box) {
      event.preventDefault();
      box.focus();
    }
  });

  if (token) signIn().catch((e) => signOut(e.message));
  else signOut();
})();
