// Share: a button on the player, match and compare pages that draws a card of what the page shows,
// to post anywhere: the phone's own share menu, a copied image to paste in Discord, a download, the
// link, or a post on X, Reddit or Bluesky. Two sizes: wide (Discord, X) and story (9:16, phones).
// The page hands over plain data (`attach(box, card)`); the card is drawn here, on a canvas, in the
// brand's colours and Saira. A link posted without the image still shows a preview of its own
// (src/site/preview.ts).
import "@genji-ball-team/ui/button.js";
import "@genji-ball-team/ui/dialog.js";
import "@genji-ball-team/ui/icon.js";
import "@genji-ball-team/ui/segmented.js";
import "@genji-ball-team/ui/toast.js";
import { contrastRatio, oklchToRgb, type Rgb as Unit } from "@genji-ball-team/ui/color.js";
import type { GbButton } from "@genji-ball-team/ui/button.js";
import type { GbDialog } from "@genji-ball-team/ui/dialog.js";
import { icons } from "@genji-ball-team/ui/icons.js";
import type { GbSegmented } from "@genji-ball-team/ui/segmented.js";
import { tokens, type TokenName } from "@genji-ball-team/ui/tokens.js";
import type { GbToast, GbToastRegion, ToastKind } from "@genji-ball-team/ui/toast.js";
import { html, render } from "./lib/html";
import type { Tier, TitleName } from "./lib/types";
import { titleSeals } from "./titles";

// What the page hands over

/** What every card has: the post's link and words, and what to call the downloaded file. */
interface CardBase {
  /** The downloaded file's name, before the size: "Name-eu". Anything but letters and digits becomes a dash. */
  file: string;
  /** Where the post links to. */
  url: string;
  /** The post's title (Reddit) and the image's alt text. */
  title: string;
  /** The post's text (X, Bluesky, the phone's share menu). */
  text: string;
  /** The region's name ("Europe"), shown as text and never as a colour. */
  region: string;
}

/** A player's profile. The history part (`peak`, `bestStreak`, `form`, `points`) can come later. */
export interface PlayerCard extends CardBase {
  kind: "player";
  name: string;
  crown: TitleName | null;
  tier: Tier | null;
  rating: number | null;
  rank: number | null;
  rounds: number | null;
  /** "54%". */
  winRate: string | null;
  peak: number | null;
  bestStreak: number | null;
  /** Places of the last rated rounds, oldest first. */
  form: number[];
  /** Rating after each match, oldest first. */
  points: number[];
}

export interface MatchRow {
  place: number;
  name: string;
  won: number;
  kills: number;
  before: number | null;
  after: number | null;
}

/** A finished match. */
export interface MatchCard extends CardBase {
  kind: "match";
  id: number;
  date: string;
  map: string;
  /** "Tourney name, lobby", for a tourney match. */
  tourney: string | null;
  /** "4 rounds". */
  rounds: string;
  /** "6 players". */
  playerCount: string;
  winners: string[];
  /** "3 rounds won · 12 kills", about the first winner. */
  winnerLine: string;
  rows: MatchRow[];
}

export interface ComparedPlayer {
  name: string;
  tier: Tier | null;
  rating: number | null;
  rank: number | null;
  /** "54%". */
  winRate: string | null;
  /** The same as a fraction, to tell who is ahead. */
  winShare: number | null;
  killsPerRound: number | null;
  peak: number | null;
  /** Rating after each match, with when it was played (ms). */
  points: { rating: number; t: number }[];
}

/** Up to three players side by side, told apart by their line's stroke as on the compare chart. */
export interface CompareCard extends CardBase {
  kind: "compare";
  players: ComparedPlayer[];
}

export type ShareCard = PlayerCard | MatchCard | CompareCard;

// Settings

type Format = "wide" | "story";
const formats: Record<Format, { w: number; h: number; label: string; hint: string }> = {
  wide: { w: 1200, h: 630, label: "Wide", hint: "Discord, X" },
  story: { w: 1080, h: 1920, label: "Story", hint: "Instagram, TikTok" },
};
const formatKey = "share-format";
const isFormat = (value: string | null): value is Format => value !== null && Object.hasOwn(formats, value);

// Colours

/** A colour as the canvas wants it: red, green and blue, 0–255. */
type Rgb = [number, number, number];
type Palette = Record<TokenName, Rgb>;

const toRgb = (unit: Unit): Rgb => [unit[0] * 255, unit[1] * 255, unit[2] * 255];
const toUnit = ([r, g, b]: Rgb): Unit => [r / 255, g / 255, b / 255];

/** The brand's tokens as the page has them (CSS custom properties), or the library's own values. */
function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const palette: Partial<Palette> = {};
  for (const name of Object.keys(tokens) as TokenName[]) {
    const value = style.getPropertyValue(`--${name}`).trim() || tokens[name];
    // The sizes and fonts aren't colours; they never get drawn from here.
    if (value.startsWith("oklch(")) palette[name] = toRgb(oklchToRgb(value));
  }
  return palette as Palette;
}
let c = readPalette();

const rgba = ([r, g, b]: Rgb, a = 1): string => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
/** Dark or light text on a colour, whichever reads better. */
const onColor = (color: Rgb): Rgb =>
  contrastRatio(toUnit(color), toUnit(c.bg)) > contrastRatio(toUnit(color), toUnit(c.fg)) ? c.bg : c.fg;

/** A title's look on the card: God is white light, Demigod dark red. */
const titleLooks: Record<TitleName, () => { seal: Rgb; light: Rgb; name: Rgb[]; glow: Rgb }> = {
  God: () => ({ seal: c["god-cream"], light: c.god, name: [c.god, c["god-cream"], c["god-rim"]], glow: c.god }),
  Demigod: () => ({ seal: c["demi-hi"], light: c["demi-hi"], name: [c["demi-hi"], c.demi], glow: c.demi }),
};

// Drawing

const fontStack = tokens.font;

function font(ctx: CanvasRenderingContext2D, size: number, weight = 400, narrow = false): void {
  ctx.font = `${weight} ${size}px ${fontStack}`;
  if ("fontStretch" in ctx) ctx.fontStretch = narrow ? "condensed" : "normal";
}

interface TextOptions {
  size: number;
  weight?: number;
  /** Saira condensed, for numbers and labels. */
  narrow?: boolean;
  color?: Rgb;
  align?: CanvasTextAlign;
  /** Shrinks the text to fit this width, down to `shrink` of `size`, then cuts it with an ellipsis. */
  max?: number;
  shrink?: number;
  /** Letter spacing in px, for the small caps labels. */
  spacing?: number;
  /** Colours of a gradient across the text, in place of `color`. */
  fill?: Rgb[];
}

/** Draws one line and returns its width. */
function text(ctx: CanvasRenderingContext2D, value: string | number, x: number, y: number, o: TextOptions): number {
  const { size, weight = 400, narrow = false, color = c.fg, align = "left", max, shrink = 0.45, spacing = 0, fill } = o;
  let s = String(value);
  let px = size;
  font(ctx, px, weight, narrow);
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
  if (max) {
    while (px > size * shrink && ctx.measureText(s).width > max) font(ctx, (px -= 2), weight, narrow);
    if (ctx.measureText(s).width > max) {
      while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
      s = `${s.trimEnd()}…`;
    }
  }
  const width = ctx.measureText(s).width;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  if (fill) {
    const left = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
    const g = ctx.createLinearGradient(left, y - px, left + width, y);
    fill.forEach((stop, i) => g.addColorStop(i / (fill.length - 1), rgba(stop)));
    ctx.fillStyle = g;
  } else ctx.fillStyle = rgba(color);
  ctx.fillText(s, x, y);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  return width;
}

/** The brand's label: small, uppercase, condensed, wide tracking. */
const caps = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: Rgb, align: CanvasTextAlign = "left") =>
  text(ctx, s.toUpperCase(), x, y, { size, weight: 700, narrow: true, color, align, spacing: size * 0.16 });

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A tier chip, like the site's: the tier's colour, its label on it. `align`: where `x` is. */
function chip(ctx: CanvasRenderingContext2D, tier: Tier, x: number, y: number, size: number, align: CanvasTextAlign = "left"): void {
  font(ctx, size, 650, true);
  const w = ctx.measureText(tier.label).width + size * 1.1;
  const h = size * 1.55;
  const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  box(ctx, left, y, w, h, size * 0.25);
  ctx.fillStyle = rgba(tier.color);
  ctx.fill();
  text(ctx, tier.label, left + w / 2, y + h * 0.72, { size, weight: 650, narrow: true, color: onColor(tier.color), align: "center" });
}

/** The site's mark: a ball with a slice through it (favicon.svg). */
function logo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(c.green);
  ctx.fill();
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(cx - 0.92 * r, cy + 0.65 * r);
  ctx.lineTo(cx + 0.92 * r, cy - 0.65 * r);
  ctx.strokeStyle = rgba(c.bg);
  ctx.lineWidth = 0.27 * r;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

/** The library's tourney icon (a cup), drawn from its own paths. */
const cupPaths = (["fill", "outline"] as const).map((part) => new Path2D(/d="([^"]+)"/.exec(icons.tourney[part])?.[1]));
function cup(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: Rgb): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = rgba(color, 0.22);
  ctx.fill(cupPaths[0] as Path2D);
  ctx.strokeStyle = rgba(color);
  ctx.lineWidth = 1.75;
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.stroke(cupPaths[1] as Path2D);
  ctx.restore();
}

/** The card's ground: dark, a glow in the title's or tier's light, faint slices across it at the logo's angle, the brand's green strip on top. */
function ground(ctx: CanvasRenderingContext2D, W: number, H: number, glow: Rgb | null): void {
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, W, H);
  if (glow) {
    const reach = Math.max(W, H) * 0.75;
    const g = ctx.createRadialGradient(W * 0.88, H * 0.08, 0, W * 0.88, H * 0.08, reach);
    g.addColorStop(0, rgba(glow, 0.2));
    g.addColorStop(1, rgba(glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.save();
  ctx.strokeStyle = rgba(c.fg, 0.028);
  ctx.lineWidth = 2;
  for (let x = -H * 1.4; x < W; x += 54) {
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x + H * 1.43, 0);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = rgba(c.green);
  ctx.fillRect(0, 0, W, 10);
}

function header(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, region: string, align: CanvasTextAlign = "left"): void {
  const r = size * 0.72;
  const name = "GENJI BALL RANKED";
  font(ctx, size, 700, true);
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${size * 0.06}px`;
  const nameW = ctx.measureText(name).width;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  font(ctx, size * 0.85, 700, true);
  const regionW = region ? ctx.measureText(region.toUpperCase()).width + size * 0.14 * region.length + size * 1.2 : 0;
  const total = r * 2 + size * 0.6 + nameW + regionW;
  let left = align === "center" ? x - total / 2 : x;
  logo(ctx, left + r, y - size * 0.36, r);
  left += r * 2 + size * 0.6;
  text(ctx, name, left, y, { size, weight: 700, narrow: true, spacing: size * 0.06 });
  if (region) caps(ctx, region, left + nameW + size * 1.2, y - size * 0.04, size * 0.85, c.muted);
}

function footer(ctx: CanvasRenderingContext2D, W: number, y: number, size: number, align: CanvasTextAlign = "left", x = 0): void {
  text(ctx, "genjiball.us", align === "center" ? W / 2 : x, y, { size, weight: 600, color: c.muted, align, spacing: size * 0.05 });
}

interface Series {
  points: { rating: number; t: number }[];
  color: Rgb;
  /** Line dashes, in line widths: dashed or dotted, so lines differ by more than shade. */
  dash?: "dashed" | "dotted";
}

/**
 * A rating line. Several are on one time axis. The area under a single line fades out; its peak gets
 * a dot, its last point a glow.
 */
function lines(ctx: CanvasRenderingContext2D, series: Series[], x: number, y: number, w: number, h: number, area = true): void {
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return;
  const byTime = series.length > 1;
  const lo = Math.min(...all.map((p) => p.rating));
  const hi = Math.max(...all.map((p) => p.rating));
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const py = (r: number) => y + h - ((r - lo) / (hi - lo || 1)) * h;
  const width = Math.max(3, h / 40);
  for (const s of series) {
    if (!s.points.length) continue;
    const px = (p: { t: number }, i: number) => x + (byTime ? (p.t - t0) / (t1 - t0 || 1) : i / Math.max(1, s.points.length - 1)) * w;
    const pts = s.points.map((p, i): [number, number] => [px(p, i), py(p.rating)]);
    const path = () => {
      ctx.beginPath();
      pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)));
    };
    path();
    if (area && !byTime) {
      ctx.save();
      ctx.lineTo(pts.at(-1)?.[0] ?? x, y + h);
      ctx.lineTo(pts[0]?.[0] ?? x, y + h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, rgba(s.color, 0.3));
      g.addColorStop(1, rgba(s.color, 0));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
      path();
    }
    ctx.strokeStyle = rgba(s.color);
    ctx.lineWidth = width;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.setLineDash(s.dash === "dashed" ? [width * 4, width * 3] : s.dash === "dotted" ? [0, width * 2.4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    const [lx = x, ly = y] = pts.at(-1) ?? [];
    ctx.save();
    ctx.shadowColor = rgba(s.color);
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(lx, ly, width * 1.6, 0, Math.PI * 2);
    ctx.fillStyle = rgba(s.color);
    ctx.fill();
    ctx.restore();
    if (!byTime) {
      const top = s.points.reduce((best, p, i) => (p.rating > (s.points[best]?.rating ?? 0) ? i : best), 0);
      const [tx = x, ty = y] = pts[top] ?? [];
      if (top !== pts.length - 1) {
        ctx.beginPath();
        ctx.arc(tx, ty, width * 1.4, 0, Math.PI * 2);
        ctx.fillStyle = rgba(c.fg);
        ctx.fill();
      }
      const size = Math.max(16, h / 7);
      caps(ctx, `Peak ${s.points[top]?.rating ?? ""}`, Math.min(Math.max(tx, x + size * 3), x + w - size * 3), ty - size * 0.9, size, c.soft, "center");
    }
  }
}

/** Figures in a row: a small caps label over a big number, a line between them. */
function figures(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, y: number, w: number, size: number): void {
  const cell = w / list.length;
  list.forEach(([label, value], i) => {
    const left = x + i * cell;
    if (i) {
      ctx.fillStyle = rgba(c.line);
      ctx.fillRect(left - size * 0.6, y - size * 1.2, 2, size * 2.1);
    }
    caps(ctx, label, left, y - size * 0.62, size * 0.36, c.muted);
    text(ctx, value, left, y + size * 0.52, { size, weight: 700, narrow: true, max: cell - size * 0.9 });
  });
}

/** Recent form: the last rated rounds, oldest first, each its place; a win filled with `up`. */
function form(ctx: CanvasRenderingContext2D, results: number[], x: number, y: number, size: number, align: CanvasTextAlign = "left"): void {
  const gap = size * 0.18;
  const total = results.length * (size + gap) - gap;
  let left = align === "center" ? x - total / 2 : x;
  for (const place of results) {
    box(ctx, left, y, size, size, size * 0.18);
    ctx.fillStyle = rgba(place === 1 ? c.up : c.raised);
    ctx.fill();
    text(ctx, place, left + size / 2, y + size * 0.7, { size: size * 0.5, weight: 700, narrow: true, color: place === 1 ? c.bg : c.soft, align: "center" });
    left += size + gap;
  }
}

// The cards

/** The rating line is `up` if the shown range ended higher than it began, else `down` (brand.md, Charts). */
const trend = (ratings: number[]): Rgb => ((ratings.at(-1) ?? 0) >= (ratings[0] ?? 0) ? c.up : c.down);

function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean): void {
  const look = d.crown ? titleLooks[d.crown]() : null;
  const seal = d.crown ? titleSeals[d.crown] : null;
  const sealText = seal && `${seal[0]} · ${d.region} ${seal[1]}`;
  ground(ctx, W, H, look?.glow ?? d.tier?.color ?? null);
  const graph: Series[] = d.points.length > 1 ? [{ points: d.points.map((rating, t) => ({ rating, t })), color: trend(d.points) }] : [];
  const stats: [string, string | number][] = [
    ["Rated rounds", d.rounds ?? "–"],
    ["Rounds won", d.winRate ?? "–"],
    ["Peak", d.peak ?? "–"],
    ["Best streak", d.bestStreak ?? "–"],
  ];
  const rank = d.rank ? `#${d.rank} in ${d.region}` : d.rating ? "Not ranked yet" : `Not rated in ${d.region}`;
  const rating = d.rating ?? "–";
  const sealColor = look?.seal ?? c.fg;
  if (!tall) {
    const pad = 64;
    header(ctx, pad, 74, 26, d.region);
    let y = 214;
    if (sealText) {
      caps(ctx, sealText, pad, 136, 20, sealColor);
      y = 222;
    }
    text(ctx, d.name, pad, y, { size: 112, weight: 700, narrow: true, max: W - pad * 2 - 380, fill: look?.name });
    if (d.tier) chip(ctx, d.tier, pad, y + 26, 26);
    caps(ctx, "Rating", W - pad, 128, 20, c.muted, "right");
    text(ctx, rating, W - pad, 252, { size: 140, weight: 700, narrow: true, align: "right", color: look?.light ?? c.fg });
    text(ctx, rank, W - pad, 296, { size: 28, weight: 500, color: c.soft, align: "right" });
    figures(ctx, stats, pad, 392, W - pad * 2, 54);
    lines(ctx, graph, pad, 470, W - pad * 2, 90);
    footer(ctx, W, 600, 20, "left", pad);
    if (d.form.length) {
      const size = 30;
      const n = Math.min(d.form.length, 10);
      form(ctx, d.form.slice(-n), W - pad - n * (size * 1.18) + size * 0.18, 578, size);
    }
    return;
  }
  const pad = 80;
  header(ctx, W / 2, 140, 34, d.region, "center");
  if (sealText) caps(ctx, sealText, W / 2, 330, 28, sealColor, "center");
  text(ctx, d.name, W / 2, 520, { size: 210, weight: 700, narrow: true, align: "center", max: W - pad * 2, fill: look?.name });
  if (d.tier) chip(ctx, d.tier, W / 2, 576, 46, "center");
  caps(ctx, "Rating", W / 2, 780, 32, c.muted, "center");
  text(ctx, rating, W / 2, 1040, { size: 300, weight: 700, narrow: true, align: "center", color: look?.light ?? c.fg });
  text(ctx, rank, W / 2, 1116, { size: 48, weight: 500, color: c.soft, align: "center" });
  figures(ctx, stats.slice(0, 2), pad + 40, 1270, W - pad * 2 - 40, 84);
  figures(ctx, stats.slice(2), pad + 40, 1430, W - pad * 2 - 40, 84);
  if (d.form.length) form(ctx, d.form.slice(-10), W / 2, 1530, 72, "center");
  lines(ctx, graph, pad, 1680, W - pad * 2, 130);
  footer(ctx, W, 1860, 30, "center");
}

function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean): void {
  ground(ctx, W, H, d.winners.length && d.tourney ? c.gold : null);
  const facts = [d.date, d.map, d.rounds, d.playerCount].filter(Boolean).join("  ·  ");
  const winner = d.winners.join(" & ");
  // A win is `up`; a tourney's winner has earned gold.
  const prize = d.tourney ? c.gold : c.up;
  const nameFill = [c.fg, d.tourney ? c.gold : c["god-cream"]];
  const pad = tall ? 80 : 64;
  const table = (x: number, y: number, w: number, rowH: number, size: number, max: number) => {
    const rating = x + w - size * 0.6;
    const kills = rating - size * 5.2;
    const cols = { place: x + size * 0.9, name: x + size * 2.2, won: kills - size * 3.4, kills, rating };
    caps(ctx, "#", cols.place, y, size * 0.6, c.muted, "center");
    caps(ctx, "Player", cols.name, y, size * 0.6, c.muted);
    caps(ctx, "Won", cols.won, y, size * 0.6, c.muted, "right");
    caps(ctx, "Kills", cols.kills, y, size * 0.6, c.muted, "right");
    caps(ctx, "Rating", cols.rating, y, size * 0.6, c.muted, "right");
    d.rows.slice(0, max).forEach((p, i) => {
      const top = y + size * 0.7 + i * rowH;
      const base = top + rowH * 0.66;
      box(ctx, x, top, w, rowH - 8, 10);
      ctx.fillStyle = p.place === 1 ? rgba(prize, 0.1) : rgba(c.fg, i % 2 ? 0.02 : 0.045);
      ctx.fill();
      text(ctx, p.place, cols.place, base, { size, weight: 700, narrow: true, align: "center", color: p.place === 1 ? prize : c.soft });
      text(ctx, p.name, cols.name, base, { size, weight: 600, narrow: true, max: cols.won - cols.name - size * 1.6, shrink: 0.7 });
      text(ctx, p.won, cols.won, base, { size, weight: 600, narrow: true, align: "right", color: c.soft });
      text(ctx, p.kills, cols.kills, base, { size, weight: 600, narrow: true, align: "right", color: c.soft });
      const delta = p.after != null && p.before != null ? p.after - p.before : 0;
      let right = cols.rating;
      // The arrow says it too, so the colour isn't the only cue.
      if (delta) right -= text(ctx, `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}`, right, base, { size: size * 0.8, weight: 700, narrow: true, align: "right", color: delta > 0 ? c.up : c.down }) + size * 0.4;
      text(ctx, p.after ? p.after : "–", right, base, { size, weight: 700, narrow: true, align: "right", color: p.after ? c.fg : c["control-border"] });
    });
  };
  const label = d.winners.length > 1 ? "Shared win" : "Winner";
  if (!tall) {
    header(ctx, pad, 74, 26, d.region);
    caps(ctx, `Match #${d.id}${d.tourney ? ` · ${d.tourney}` : ""}`, pad, 150, 22, c.muted);
    text(ctx, facts, pad, 190, { size: 24, color: c.soft, max: 520 });
    if (winner) {
      cup(ctx, pad, 252, 40, prize);
      caps(ctx, label, pad + 56, 284, 22, prize);
      text(ctx, winner, pad, 400, { size: 104, weight: 700, narrow: true, max: 520, fill: nameFill });
      text(ctx, d.winnerLine, pad, 452, { size: 28, color: c.soft, max: 520 });
    }
    table(620, 150, W - 620 - pad, 76, 30, 5);
    footer(ctx, W, 600, 20, "left", pad);
    return;
  }
  header(ctx, W / 2, 140, 34, d.region, "center");
  caps(ctx, `Match #${d.id}`, W / 2, 300, 34, c.muted, "center");
  if (d.tourney) text(ctx, d.tourney, W / 2, 354, { size: 36, weight: 600, align: "center", max: W - pad * 2 });
  text(ctx, facts, W / 2, d.tourney ? 408 : 360, { size: 32, color: c.soft, align: "center", max: W - pad * 2 });
  if (winner) {
    cup(ctx, W / 2 - 50, 500, 100, prize);
    caps(ctx, label, W / 2, 680, 32, prize, "center");
    text(ctx, winner, W / 2, 840, { size: 150, weight: 700, narrow: true, align: "center", max: W - pad * 2, fill: nameFill });
    text(ctx, d.winnerLine, W / 2, 910, { size: 40, color: c.soft, align: "center", max: W - pad * 2 });
  }
  table(pad, 1030, W - pad * 2, 88, 40, 8);
  footer(ctx, W, 1860, 30, "center");
}

function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean): void {
  ground(ctx, W, H, null);
  // One line a player, told apart by stroke as well as shade: solid, dashed, dotted.
  const strokes: Pick<Series, "color" | "dash">[] = [{ color: c.fg }, { color: c.soft, dash: "dashed" }, { color: c.muted, dash: "dotted" }];
  const stroke = (i: number) => strokes[i] ?? { color: c.muted };
  const pad = tall ? 80 : 64;
  const n = d.players.length;
  const s = tall ? 1.45 : 1;
  const top = tall ? 400 : 160;
  const step = tall ? 54 : 38;
  const gap = 32 * s;
  const colW = (W - pad * 2 - gap * (n - 1)) / n;
  header(ctx, tall ? W / 2 : pad, tall ? 140 : 74, tall ? 34 : 26, d.region, tall ? "center" : "left");
  caps(ctx, n === 2 ? "Head to head" : n > 2 ? "Compare" : "Player", tall ? W / 2 : pad, top - 30 * s, 20 * s, c.muted, tall ? "center" : "left");
  const rows: [string, (p: ComparedPlayer) => string, (p: ComparedPlayer) => number | null, 1 | -1][] = [
    ["Rank", (p) => (p.rank ? `#${p.rank}` : "–"), (p) => p.rank, -1],
    ["Rounds won", (p) => p.winRate ?? "–", (p) => p.winShare, 1],
    ["Kills a round", (p) => p.killsPerRound?.toFixed(2) ?? "–", (p) => p.killsPerRound, 1],
    ["Peak", (p) => String(p.peak ?? "–"), (p) => p.peak, 1],
  ];
  d.players.forEach((p, i) => {
    const x = pad + i * (colW + gap);
    const { color, dash } = stroke(i);
    // The key: a sample of the player's line.
    ctx.save();
    ctx.strokeStyle = rgba(color);
    ctx.lineWidth = 8 * s;
    ctx.lineCap = dash === "dotted" ? "round" : "butt";
    ctx.setLineDash(dash === "dashed" ? [32 * s, 20 * s] : dash === "dotted" ? [0, 18 * s] : []);
    ctx.beginPath();
    ctx.moveTo(x + (dash === "dotted" ? 4 * s : 0), top + 4 * s);
    ctx.lineTo(x + colW, top + 4 * s);
    ctx.stroke();
    ctx.restore();
    text(ctx, p.name, x, top + 72 * s, { size: 54 * s, weight: 700, narrow: true, max: colW });
    if (p.tier) chip(ctx, p.tier, x, top + 92 * s, 22 * s);
    text(ctx, p.rating ?? "–", x, top + 220 * s, { size: 96 * s, weight: 700, narrow: true, color: p.rating ? c.fg : c["control-border"] });
    rows.forEach(([label, show, value, better], j) => {
      const y = top + (262 + j * step) * s;
      const known = d.players.map(value).filter((v): v is number => v != null);
      const mine = value(p);
      const best = n > 1 && known.length > 1 && mine != null && mine === (better > 0 ? Math.max(...known) : Math.min(...known));
      text(ctx, label, x, y, { size: 22 * s, color: c.muted, max: colW * 0.6 });
      // The leader in each row is brighter and bolder.
      text(ctx, show(p), x + colW, y, { size: 24 * s, weight: best ? 800 : 600, narrow: true, align: "right", color: best ? c.fg : c.muted });
    });
  });
  const series = d.players.flatMap((p, i) => (p.points.length > 1 ? [{ points: p.points, ...stroke(i) }] : []));
  if (tall) {
    if (series.length) {
      caps(ctx, "Rating over time", pad, 1200, 28, c.muted);
      lines(ctx, series, pad, 1250, W - pad * 2, 500, series.length === 1);
    }
    footer(ctx, W, 1860, 30, "center");
  } else footer(ctx, W, 600, 20, "left", pad);
}

/** Every name on the card, so the font's other subset (latin-ext) loads for names that need it. */
function words(card: ShareCard): string {
  const names =
    card.kind === "player" ? [card.name] : card.kind === "match" ? [...card.winners, ...card.rows.map((r) => r.name)] : card.players.map((p) => p.name);
  return [card.region, ...names].join(" ");
}

async function draw(card: ShareCard, format: Format): Promise<Blob> {
  const { w, h } = formats[format];
  await Promise.all([400, 600, 700].map((weight) => document.fonts.load(`${weight} 40px Saira`, words(card)))).catch(() => undefined);
  // Read now, so the card has the colours the page has.
  c = readPalette();
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  const tall = format === "story";
  if (card.kind === "player") playerCard(ctx, w, h, card, tall);
  else if (card.kind === "match") matchCard(ctx, w, h, card, tall);
  else compareCard(ctx, w, h, card, tall);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));
}

// The sheet

let current: ShareCard | null = null;
/** The size picked last time. Browser storage can throw (private windows, blocked cookies). */
let format: Format = (() => {
  try {
    const kept = localStorage.getItem(formatKey);
    return isFormat(kept) ? kept : "wide";
  } catch {
    return "wide";
  }
})();
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
    try {
      localStorage.setItem(formatKey, format);
    } catch {
      // not kept
    }
    void redraw();
  });
  dialog.addEventListener("click", (event) => {
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
    const made = await draw(card, format);
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
  current = card;
  button.hidden = !card;
  if (card && sheet?.open) void redraw();
}
