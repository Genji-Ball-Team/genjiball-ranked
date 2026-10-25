// Share: a button on the player, match and compare pages that draws a card of what the page shows,
// to post anywhere: the phone's own share menu, a copied image to paste in Discord, a download, the
// link, or a post on X, Reddit or Bluesky. Two sizes, wide (Discord, X) and story (9:16, phones), and
// a few styles to pick from, each shown as a small preview.
// The page hands over plain data (`attach(box, card)`); the card is drawn on a canvas, in the brand's
// colours and Saira, by one of the styles in cards/. A link posted without the image still shows a
// preview of its own (src/site/preview.ts).
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/dialog.js";
import "@genji-ball-team/ui/icon.js";
import "@genji-ball-team/ui/segmented.js";
import "@genji-ball-team/ui/toast.js";
import type { GbButton } from "@genji-ball-team/ui/button.js";
import type { GbDialog } from "@genji-ball-team/ui/dialog.js";
import type { GbSegmented } from "@genji-ball-team/ui/segmented.js";
import type { GbToast, GbToastRegion, ToastKind } from "@genji-ball-team/ui/toast.js";
import { drawCard, isStyle, styles, type StyleName } from "./cards";
import { refreshPalette } from "./cards/kit";
import type { ShareCard } from "./cards/types";
import { html, render } from "./lib/html";

export type { ComparedPlayer, CompareCard, MatchCard, MatchRow, PlayerCard, ShareCard } from "./cards/types";

// Settings

type Format = "wide" | "story";
const formats: Record<Format, { w: number; h: number; label: string; hint: string }> = {
  wide: { w: 1200, h: 630, label: "Wide", hint: "Discord, X" },
  story: { w: 1080, h: 1920, label: "Story", hint: "Instagram, TikTok" },
};
const formatKey = "share-format";
const styleKey = "share-style";
const isFormat = (value: string | null): value is Format => value !== null && Object.hasOwn(formats, value);

/** A setting picked last time. Browser storage can throw (private windows, blocked cookies). */
function kept<T extends string>(key: string, is: (value: string | null) => value is T, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return is(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not kept
  }
}

/** Every name on the card, so the font's other subset (latin-ext) loads for names that need it. */
function words(card: ShareCard): string {
  const names =
    card.kind === "player" ? [card.name] : card.kind === "match" ? [...card.winners, ...card.rows.map((r) => r.name)] : card.players.map((p) => p.name);
  return [card.region, ...names].join(" ");
}

async function draw(card: ShareCard, format: Format, style: StyleName): Promise<Blob> {
  const { w, h } = formats[format];
  await Promise.all([400, 500, 600, 700, 800].map((weight) => document.fonts.load(`${weight} 40px Saira`, words(card)))).catch(() => undefined);
  // Read now, so the card has the colours the page has.
  refreshPalette();
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  drawCard(ctx, style, card, format === "story");
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));
}

/** The images drawn for the current card, by style and size: switching back is instant, and the previews reuse them. */
const drawings = new Map<string, Promise<Blob>>();
function drawing(card: ShareCard, format: Format, style: StyleName): Promise<Blob> {
  const key = `${style} ${format}`;
  let made = drawings.get(key);
  if (!made) {
    made = draw(card, format, style);
    drawings.set(key, made);
    // A failed draw is tried again next time.
    made.catch(() => drawings.delete(key));
  }
  return made;
}

// The sheet

let current: ShareCard | null = null;
let format: Format = kept(formatKey, isFormat, "wide");
let style: StyleName = kept(styleKey, isStyle, "broadcast");
let sheet: GbDialog | undefined;
let blob: Blob | null = null;
/** Counts the draws, so a slow one that is overtaken by a newer one is dropped. */
let drawn = 0;

const actionNames = ["native", "copy", "download", "link", "x", "reddit", "bluesky"] as const;
type Action = (typeof actionNames)[number];
/** The actions that don't need the image, and still work when it didn't draw. */
const linkActions: readonly Action[] = ["link", "x", "reddit", "bluesky"];

// Letters and digits of any script stay; the rest (spaces, slashes) become one dash.
const fileName = (card: ShareCard) => `genjiball-${card.file.replace(/[^\p{L}\p{N}]+/gu, "-")}-${format}.png`;

function canShareFiles(): boolean {
  try {
    return Boolean(navigator.canShare?.({ files: [new File([""], "x.png", { type: "image/png" })] }));
  } catch {
    return false;
  }
}

/** Says something short in a toast above the sheet. Toasts have their own region in the dialog: the page's would be behind its dimmed backdrop. */
function say(message: string, kind: ToastKind = "success"): void {
  const region = sheet?.querySelector<GbToastRegion>("gb-toast-region");
  if (!region) return;
  const note = document.createElement("gb-toast") as GbToast;
  note.kind = kind;
  note.append(message);
  region.replaceChildren(note);
}

function build(): GbDialog {
  const native = canShareFiles();
  const copyImage = Boolean((navigator.clipboard as Clipboard | undefined)?.write && window.ClipboardItem);
  const button = (act: Action, label: string, primary = false) =>
    html`<gb-button data-act="${act}"${primary && html` variant="primary"`} disabled>${label}</gb-button>`;
  const dialog = document.createElement("gb-dialog") as GbDialog;
  dialog.className = "share-sheet";
  dialog.label = "Share";
  render(
    dialog,
    html`<gb-segmented label="Image size" value="${format}">${Object.entries(formats).map(
        ([key, f]) => html`<button type="button" value="${key}" title="${f.hint}">${f.label}</button>`,
      )}</gb-segmented>
      <figure class="share-preview" aria-busy="true"><img alt=""></figure>
      <div class="share-styles" role="group" aria-label="Style">${Object.entries(styles).map(
        ([key, s]) => html`<button type="button" value="${key}" aria-pressed="${key === style}"><img alt=""><span>${s.label}</span></button>`,
      )}</div>
      <div class="share-actions">
        ${native && button("native", "Share…", true)}
        ${copyImage && button("copy", "Copy image", !native)}
        ${button("download", "Download", !native && !copyImage)}
        ${button("link", "Copy link")}
      </div>
      <div class="share-actions">
        ${button("x", "Post on X")}${button("reddit", "Reddit")}${button("bluesky", "Bluesky")}
      </div>
      <gb-toast-region></gb-toast-region>
      <gb-button slot="actions" value="close">Close</gb-button>`,
  );
  dialog.addEventListener("change", (event) => {
    const picked = (event.target as GbSegmented).value;
    if (!isFormat(picked) || picked === format) return;
    format = picked;
    keep(formatKey, format);
    void redraw();
  });
  dialog.addEventListener("click", (event) => {
    const picked = (event.target as Element).closest<HTMLButtonElement>(".share-styles button")?.value;
    if (isStyle(picked) && picked !== style) {
      style = picked;
      keep(styleKey, style);
      for (const b of dialog.querySelectorAll<HTMLButtonElement>(".share-styles button")) b.setAttribute("aria-pressed", String(b.value === style));
      void redraw();
      return;
    }
    const act = (event.target as Element).closest<GbButton>("gb-button[data-act]")?.dataset.act;
    if (act && actionNames.includes(act as Action) && !(event.target as GbButton).disabled) {
      actions[act as Action]().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) say("That didn't work here. Try Download instead.", "error");
      });
    }
  });
  document.body.append(dialog);
  return dialog;
}

const open = (url: string): void => void window.open(url, "_blank", "noopener");
const post = (url: string, params: Record<string, string>): string => `${url}?${new URLSearchParams(params)}`;

const actions: Record<Action, () => Promise<void>> = {
  async native() {
    if (!current || !blob) return;
    const file = new File([blob], fileName(current), { type: "image/png" });
    await navigator.share({ files: [file], title: current.title, text: `${current.text} ${current.url}` });
  },
  async copy() {
    if (!blob) return;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    say("Image copied. Paste it in Discord or anywhere else.");
  },
  async download() {
    if (!current || !blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName(current);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    say("Saved.");
  },
  async link() {
    if (!current) return;
    await navigator.clipboard.writeText(current.url);
    say("Link copied. It shows a preview in Discord and X.");
  },
  async x() {
    if (current) open(post("https://x.com/intent/post", { text: current.text, url: current.url }));
  },
  async reddit() {
    if (current) open(post("https://www.reddit.com/submit", { url: current.url, title: current.title }));
  },
  async bluesky() {
    if (current) open(post("https://bsky.app/intent/compose", { text: `${current.text} ${current.url}` }));
  },
};

/** Draws the card in the current size into the sheet. */
async function redraw(): Promise<void> {
  const card = current;
  if (!sheet || !card) return;
  const run = ++drawn;
  const figure = sheet.querySelector<HTMLElement>(".share-preview");
  const img = figure?.querySelector("img");
  const buttons = sheet.querySelectorAll<GbButton>("gb-button[data-act]");
  if (!figure || !img) return;
  figure.setAttribute("aria-busy", "true");
  figure.dataset.format = format;
  for (const b of buttons) b.disabled = true;
  try {
    const made = await drawing(card, format, style);
    if (run !== drawn) return;
    blob = made;
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
    img.alt = `Share image: ${card.title}`;
    for (const b of buttons) b.disabled = false;
  } catch (error) {
    console.error("share image", error);
    if (run !== drawn) return;
    blob = null;
    say("The image didn't draw. The link still works.", "error");
    for (const b of buttons) b.disabled = !linkActions.includes(b.dataset.act as Action);
  } finally {
    if (run === drawn) figure.removeAttribute("aria-busy");
  }
  if (run === drawn) await previews(card, run);
}

/** Draws every style small, in the current size, on its button. One at a time, after the picked one. */
async function previews(card: ShareCard, run: number): Promise<void> {
  const group = sheet?.querySelector<HTMLElement>(".share-styles");
  if (!group) return;
  group.dataset.format = format;
  for (const button of group.querySelectorAll<HTMLButtonElement>("button")) {
    const img = button.querySelector("img");
    if (!img || !isStyle(button.value)) continue;
    try {
      const made = await drawing(card, format, button.value);
      if (run !== drawn) return;
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(made);
    } catch {
      // The label is still there to pick it by.
    }
  }
}

/**
 * Puts a Share button at the end of `box` (once), for `card`. Again with a newer card (more loaded)
 * updates it, and redraws the image when the sheet is open; null hides the button.
 */
export function attach(box: HTMLElement, card: ShareCard | null): void {
  let button = box.querySelector<GbButton>(".share-button");
  if (!button) {
    button = document.createElement("gb-button") as GbButton;
    button.className = "share-button";
    button.setAttribute("aria-label", "Share");
    render(button, html`<gb-icon name="share"></gb-icon><span class="share-label">Share</span>`);
    button.addEventListener("click", () => {
      sheet ??= build();
      sheet.show();
      void redraw();
    });
    box.append(button);
  }
  if (card !== current) drawings.clear();
  current = card;
  button.hidden = !card;
  if (card && sheet?.open) void redraw();
}
