// The admin's building blocks on top of the UI library: buttons, chips, tables, forms in dialogs,
// toasts, and the headings every view uses.
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/dialog.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/field.js";
import "@genji-ball-team/ui/panel.js";
import "@genji-ball-team/ui/segmented.js";
import "@genji-ball-team/ui/skeleton.js";
import "@genji-ball-team/ui/table.js";
import "@genji-ball-team/ui/toast.js";
import { confirmDialog } from "@genji-ball-team/ui/dialog.js";
import { toast } from "@genji-ball-team/ui/toast.js";
import { h, count, longTime, type Child } from "./dom";
import { api, app, messageOf, regionLabel } from "./state";
import type { AdminMatch, FoundPlayer } from "./types";

type Dialogish = HTMLElement & { show(): void; close(value?: string): void };
type Segmented = HTMLElement & { value: string };

// ---- Buttons ----

export interface ButtonOptions {
  variant?: "primary" | "ghost" | "danger";
  /** A shorter button, for rows and cards. */
  small?: boolean;
  /** Danger-coloured text on a quiet button (delete, revoke). */
  tone?: "danger";
  label?: string;
}

/** A button that shows it's working and can't be pressed twice while `onClick` runs. */
export function btn(label: string, onClick: (event: Event) => unknown, options: ButtonOptions = {}): HTMLElement {
  const b = h("gb-button", { variant: options.variant, class: [options.small && "small", options.tone].filter(Boolean).join(" ") || null, "aria-label": options.label }, label);
  b.addEventListener("click", (event) => {
    void (async () => {
      b.setAttribute("busy", "");
      try {
        await onClick(event);
      } finally {
        b.removeAttribute("busy");
      }
    })();
  });
  return b;
}

/** A link that looks like a secondary button. */
export const linkButton = (label: string, href: string, newTab = false): HTMLElement =>
  h("a", { class: "button", href, target: newTab ? "_blank" : null, rel: newTab ? "noopener" : null }, label);

// ---- Chips ----

export type ChipKind = "plain" | "warn" | "good" | "bad";
export const chip = (text: string, kind: ChipKind = "plain", title: string | null = null): HTMLElement =>
  h("gb-chip", { class: kind === "plain" ? null : kind, title }, text);
/** A region is text or a grey chip, never a colour. */
export const regionChip = (id: string | null): HTMLElement =>
  chip(id ? id.toUpperCase() : "none", "plain", regionLabel(id));

const statusKinds: Record<string, ChipKind> = {
  review: "warn",
  accepted: "good",
  void: "plain",
  rejected: "bad",
  scheduled: "plain",
  live: "good",
  done: "plain",
  cancelled: "bad",
};
export const statusChip = (status: string): HTMLElement => chip(status, statusKinds[status] ?? "plain");

export const empty = (text: string): HTMLElement => h("gb-empty", null, text);
export const skeletons = (): HTMLElement[] => [
  h("gb-skeleton", { block: true, class: "tall" }),
  h("gb-skeleton", { block: true }),
  h("gb-skeleton", { block: true }),
];

// ---- Tables ----

export type Heading = string | { sr: string };

/** A `<gb-table>`: columns in `numeric` (by index) line up right. No client sort: lists are short or newest-first. */
export function table(headings: Heading[], rows: HTMLElement[], numeric: number[] = []): HTMLElement {
  return h(
    "gb-table",
    { class: "data" },
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          headings.map((t, i) =>
            h("th", { "data-type": numeric.includes(i) ? "number" : null }, typeof t === "string" ? t : h("span", { class: "sr" }, t.sr)),
          ),
        ),
      ),
      h("tbody", null, rows),
    ),
  );
}

// ---- Toasts ----

export function notify(text: string, kind: "ok" | "error" = "ok"): void {
  toast(text, { kind: kind === "error" ? "error" : "success" });
}

/** Runs a change, says how it went, then draws the view again with the new data. */
export async function run(label: string, change: () => Promise<string | undefined>): Promise<void> {
  try {
    notify((await change()) || `${label}: done.`);
  } catch (error) {
    notify(`${label}: ${messageOf(error)}`, "error");
  }
  await app.refresh();
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify("Copied.");
  } catch {
    notify("Couldn't copy: select it and copy it by hand.", "error");
  }
}

// ---- Forms in dialogs ----

export type Values = Record<string, string>;

export interface FieldSpec {
  name: string;
  label?: string;
  type?: "text" | "select" | "textarea" | "checkbox" | "number" | "datetime-local";
  value?: string | number | boolean | null;
  hint?: string;
  options?: [string | number, string][];
  required?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  maxlength?: number;
  inputmode?: string;
  /** What to show under the input as the admin types (a match's details). */
  preview?: (value: string) => Promise<Child>;
  /** A field of its own making: its element and how to read it. */
  render?: () => { el: HTMLElement; get: () => string };
}

export interface AskOptions<R> {
  title: string;
  text?: string | HTMLElement;
  fields?: FieldSpec[];
  ok?: string;
  danger?: boolean;
  cancel?: boolean;
  submit?: (values: Values) => R | Promise<R>;
}

function fieldFor(f: FieldSpec, getters: Record<string, () => string>): HTMLElement {
  if (f.render) {
    const { el, get } = f.render();
    getters[f.name] = get;
    return el;
  }
  const common = {
    name: f.name,
    required: f.required,
    placeholder: f.placeholder,
    min: f.min,
    max: f.max,
    maxlength: f.maxlength,
    inputmode: f.inputmode,
    autocomplete: "off",
  };
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (f.type === "select") {
    input = h(
      "select",
      common,
      (f.options ?? []).map(([value, label]) => h("option", { value, selected: String(value) === String(f.value ?? "") }, label)),
    );
  } else if (f.type === "textarea") {
    input = h("textarea", { ...common, rows: 3 }, String(f.value ?? ""));
  } else {
    input = h("input", {
      ...common,
      type: f.type ?? "text",
      value: f.type === "checkbox" ? null : String(f.value ?? ""),
      checked: f.type === "checkbox" && Boolean(f.value),
    });
  }
  const isCheck = input instanceof HTMLInputElement && input.type === "checkbox";
  getters[f.name] = isCheck ? () => ((input as HTMLInputElement).checked ? "1" : "") : () => input.value.trim();
  const preview = f.preview ? h("div", { class: "preview" }) : null;
  if (preview && f.preview) {
    const show = f.preview;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void show(input.value.trim()).then((content) => preview.replaceChildren(...(content ? [content as Node] : [])));
      }, 250);
    };
    input.addEventListener("input", draw);
    if (f.value) draw();
  }
  return h("div", { class: "form-row" }, h("gb-field", { label: f.label ?? f.name }, input), f.hint && h("small", { class: "hint" }, f.hint), preview);
}

/**
 * A form in a dialog. `submit(values)` runs with the dialog still open: if it throws, its message shows
 * in the dialog and the admin can fix the input. Resolves to what `submit` returned (or the values), or
 * null when cancelled.
 */
export function ask<R = Values>(options: AskOptions<R>): Promise<R | null> {
  return new Promise((resolve) => {
    const getters: Record<string, () => string> = {};
    const error = h("p", { class: "dialog-error", role: "alert", hidden: true });
    const okButton = h("gb-button", { slot: "actions", variant: options.danger ? "danger" : "primary" }, options.ok ?? "Save");
    const form = h("form", { novalidate: false, class: "dialog-form" }, (options.fields ?? []).map((f) => fieldFor(f, getters)), error);
    const dialog = h(
      "gb-dialog",
      { label: options.title },
      options.text && (typeof options.text === "string" ? h("p", null, options.text) : options.text),
      form,
      options.cancel !== false && h("gb-button", { slot: "actions", value: "cancel" }, "Cancel"),
      okButton,
    ) as Dialogish;
    let done = false;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values: Values = Object.fromEntries(Object.entries(getters).map(([name, get]) => [name, get()]));
      okButton.setAttribute("busy", "");
      error.hidden = true;
      void (async () => {
        try {
          const result = options.submit ? await options.submit(values) : (values as R);
          done = true;
          dialog.close("done");
          resolve(result ?? (values as R));
        } catch (e) {
          error.textContent = `Could not save: ${messageOf(e)}`;
          error.hidden = false;
        } finally {
          okButton.removeAttribute("busy");
        }
      })();
    });
    // The dialog's buttons sit outside the form, so OK and Enter submit it.
    okButton.addEventListener("click", () => form.requestSubmit());
    form.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || !(event.target instanceof HTMLInputElement)) return;
      if (event.target.type === "checkbox" || event.target.type === "radio") return;
      event.preventDefault();
      form.requestSubmit();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (!done) resolve(null);
    });
    document.body.append(dialog);
    dialog.show();
    form.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")?.focus();
  });
}

export const confirmAction = (title: string, text: string, action: string, danger = true): Promise<boolean> =>
  confirmDialog({ title, text, action, danger });

/** A player search to pick another player (merges): the id of the one picked. */
export function playerPicker(excludeId: number): { el: HTMLElement; get: () => string } {
  let picked = "";
  const results = h("div", { class: "picks", role: "radiogroup", "aria-label": "Players" });
  const input = h("input", { type: "search", placeholder: "Name or old name", autocomplete: "off" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        const search = input.value.trim();
        picked = "";
        if (search.length < 2) return results.replaceChildren();
        try {
          const { players } = await api<{ players: FoundPlayer[] }>(`players?search=${encodeURIComponent(search)}`);
          const others = players.filter((p) => p.id !== excludeId);
          results.replaceChildren(
            ...(others.length
              ? others.map((p) =>
                  h(
                    "label",
                    { class: "pick" },
                    h("input", { type: "radio", name: "pick", value: p.id, onchange: () => (picked = String(p.id)) }),
                    h("span", null, h("b", null, p.name), h("small", null, ` #${p.id}`)),
                  ),
                )
              : [empty("No other player has that name.")]),
          );
        } catch (e) {
          results.replaceChildren(h("p", { class: "error" }, messageOf(e)));
        }
      })();
    }, 250);
  });
  return { el: h("div", { class: "form-row" }, h("gb-field", { label: "Merge into" }, input), results), get: () => picked };
}

/** A screenshot, full size, over the page. */
export function lightbox(src: string): void {
  const dialog = h(
    "dialog",
    { class: "lightbox" },
    h("img", { src, alt: "Screenshot of the final standings" }),
    h("button", { type: "button", "aria-label": "Close" }, "×"),
  );
  dialog.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// ---- Headings and small parts ----

export const head = (title: Child, ...rest: Child[]): HTMLElement =>
  h("div", { class: "view-head" }, h("div", null, typeof title === "string" ? h("h1", null, title) : title), h("div", { class: "head-actions" }, rest));
export const crumb = (href: string, label: string): HTMLElement => h("a", { class: "crumb", href }, `← ${label}`);
export const section = (title: string, ...rest: Child[]): HTMLElement =>
  h("div", { class: "section-head" }, h("h2", null, title), h("div", { class: "head-actions" }, rest));
export const fact = (label: string, ...value: Child[]): HTMLElement => h("div", null, h("dt", null, label), h("dd", null, value));
export const lede = (text: string): HTMLElement => h("p", { class: "lede" }, text);
export const note = (...content: Child[]): HTMLElement => h("p", { class: "note" }, content);
export const callout = (kind: "warn" | "good" | "bad" | "", ...content: Child[]): HTMLElement =>
  h("p", { class: `callout ${kind}` }, content);

/** One choice out of a few, as a `<gb-segmented>`. */
export function seg(options: [string, string][], current: string, onPick: (value: string) => unknown, label: string): HTMLElement {
  const el = h(
    "gb-segmented",
    { label, value: current },
    options.map(([value, text]) => h("button", { type: "button", value }, text)),
  ) as Segmented;
  el.addEventListener("change", () => void onPick(el.value));
  return el;
}

/** A filter box. */
export function filterBox(label: string, value: string, placeholder = ""): HTMLInputElement {
  return h("input", { type: "search", placeholder, value, autocomplete: "off", "aria-label": label });
}
export const searchField = (label: string, input: HTMLInputElement, big = false): HTMLElement =>
  h("gb-field", { label, class: big ? "search big" : "search" }, input);

export async function matchPreview(value: string): Promise<Child> {
  const digits = value.replace(/^#\s*/, "");
  if (!digits) return "";
  if (!/^[1-9]\d*$/.test(digits)) return h("span", { class: "error" }, "A match id is a number, like 123.");
  try {
    const { match: m } = await api<{ match: AdminMatch }>(`matches/${digits}`);
    return h(
      "div",
      { class: "match-preview" },
      h("b", null, `#${m.id} `),
      statusChip(m.status),
      " ",
      regionChip(m.region),
      h("small", null, ` ${longTime(m.playedAt)} · hosted by ${m.hostName} · ${count(m.players.length, "player", "players")}`),
    );
  } catch (e) {
    return h("span", { class: "error" }, messageOf(e));
  }
}

// ---- Words for codes ----

const reasons: Record<string, string> = {
  duplicate_name: "Two players had the same name",
  untrusted_host: "The host isn't trusted yet",
  tourney_unknown_lobby: "Its tourney code is for a lobby that doesn't exist",
  tourney_cancelled: "Its tourney was cancelled",
  tourney_wrong_host: "Uploaded by a host who isn't the lobby's",
  tourney_wrong_region: "Played in another region than its tourney",
  tourney_lobby_taken: "Its lobby already has a match",
  tourney_round_limit: "Played with another round limit than its lobby's",
};
export const reasonText = (code: string): string => reasons[code] ?? code.replaceAll("_", " ");

export type View = (view: HTMLElement, params: string[], query: URLSearchParams) => Promise<void> | void;

export const notFound: View = (view) => {
  view.append(h("h1", null, "No such page"), h("p", null, h("a", { href: "#/" }, "Back to the overview")));
};
