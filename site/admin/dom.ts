// Small DOM helpers for the admin pages. Every value from the server goes into the page as text
// (`h` below): player and host names come from game logs, so nothing here uses innerHTML.

export type Child = Node | string | number | false | null | undefined | readonly Child[];
type Prop = string | number | boolean | null | undefined | ((event: Event) => unknown);
export type Props = Record<string, Prop>;

/**
 * `h("a", { href, onclick }, "text", child)`: attributes are set as attributes (`true` for a bare
 * one, `null`/`false` left out), `on…` functions become listeners, children are text or nodes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...nodes(children));
  return el;
}

function nodes(children: readonly Child[]): (Node | string)[] {
  const out: (Node | string)[] = [];
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "number") out.push(String(child));
    else if (typeof child === "string" || child instanceof Node) out.push(child);
    else out.push(...nodes(child));
  }
  return out;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from the page`);
  return element as T;
}

// ---- Time ----

export const longTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const steps: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [3600, "minute"],
  [86400, "hour"],
  [604800, "day"],
  [2629800, "week"],
  [31557600, "month"],
  [Infinity, "year"],
];
const sizes: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2629800,
  year: 31557600,
};
export function ago(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const unit = steps.find(([limit]) => Math.abs(seconds) < limit)?.[1] ?? "year";
  return relative.format(Math.round(seconds / (sizes[unit] ?? 1)), unit);
}

/** A time as "3 hours ago", the full date on hover. */
export const time = (iso: string | null | undefined, never = "never"): HTMLElement =>
  iso ? h("time", { datetime: iso, title: longTime(iso) }, ago(iso)) : h("span", { class: "faint" }, never);

/** Times are entered in the admin's own time zone and sent as UTC. */
export function localInput(iso: string): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
