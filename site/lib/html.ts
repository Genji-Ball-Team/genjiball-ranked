// HTML from templates, escaped by default: html`<b>${name}</b>` escapes `name`, while a value that is
// itself html`…` (or a list of them) goes in as it is. So text from the API can't become markup.

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

type Part = Html | string | number | boolean | null | undefined | readonly Part[];

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
export const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => entities[c] ?? c);

function part(value: Part): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(part).join("");
  // `false`, `null` and `undefined` leave nothing, so `${cond && html`…`}` works.
  if (value === null || value === undefined || value === false) return "";
  return esc(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, i) => (out += part(value) + (strings[i + 1] ?? "")));
  return new Html(out);
}

/** Markup that's already safe, like an icon's SVG from the UI library. */
export const raw = (markup: string): Html => new Html(markup);

/** Puts `content` in `box`. */
export function render(box: Element, content: Html): void {
  box.innerHTML = content.value;
}

/** The element with this id. Throws when the page doesn't have it: a mistake in the page's HTML. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from the page`);
  return element as T;
}
