// Lists that load after the page opens: placeholder rows until the answer, then the answer, or a line
// saying what went wrong.
import "@genji-ball-team/ui/empty.js";
import { NotFound } from "./api";
import { html, render, type Html } from "./html";

/** Puts what loaded in `box`, in place of its placeholder rows. */
export function loaded(box: HTMLElement, content: Html): void {
  render(box, content);
  // Rise in over the placeholder rows the first time only, not on every later answer: the first rows
  // one after another (`--i`, site.css), then the class goes so the next answer just shows.
  if (box.hasAttribute("data-loading")) {
    [...box.children].slice(0, 12).forEach((row, i) => (row as HTMLElement).style.setProperty("--i", String(i)));
    box.classList.add("appear");
    setTimeout(() => box.classList.remove("appear"), 800);
  }
  box.removeAttribute("aria-busy");
  box.removeAttribute("data-loading");
}

/** Says in `box` that `what` ("leaderboard", "player") didn't load, or doesn't exist. */
export function showError(box: HTMLElement, error: unknown, what: string): void {
  const line =
    error instanceof NotFound
      ? html`There's no ${what} with this link. Find players on the <a href="/">leaderboard</a>.`
      : html`The ${what} didn't load. Reload the page to try again.`;
  loaded(box, box.tagName === "OL" || box.tagName === "UL" ? html`<li class="empty">${line}</li>` : html`<gb-empty>${line}</gb-empty>`);
}
