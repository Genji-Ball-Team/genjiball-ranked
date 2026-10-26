// What every card style draws with: the brand's colours, Saira, and the marks and parts the styles
// share (the logo, a tier chip, a rating line, recent form).
import { contrastRatio, oklchToRgb, type Rgb as Unit } from "@genji-ball-team/ui/color.js";
import { icons } from "@genji-ball-team/ui/icons.js";
import { tokens, type TokenName } from "@genji-ball-team/ui/tokens.js";
import type { Tier, TitleName } from "../lib/types";
import { titleSeals } from "../titles";
import type { ComparePart, MatchPart, PlayerPart, Show } from "./parts";
import type { ComparedPlayer, MatchCard, PlayerCard } from "./types";

/** A colour as the canvas wants it: red, green and blue, 0–255. */
export type Rgb = [number, number, number];
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
/** The palette the cards are drawn in: read again before each card, so it has the colours the page has. */
export let c = readPalette();
export const refreshPalette = (): void => {
  c = readPalette();
};

export const rgba = ([r, g, b]: Rgb, a = 1): string => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
/** Dark or light text on a colour, whichever reads better. */
export const onColor = (color: Rgb): Rgb =>
  contrastRatio(toUnit(color), toUnit(c.bg)) > contrastRatio(toUnit(color), toUnit(c.fg)) ? c.bg : c.fg;

/** A title's look on the card: God is white light, Demigod dark red. */
export const titleLooks: Record<TitleName, () => { seal: Rgb; light: Rgb; name: Rgb[]; glow: Rgb }> = {
  God: () => ({ seal: c["god-cream"], light: c.god, name: [c.god, c["god-cream"], c["god-rim"]], glow: c.god }),
  Demigod: () => ({ seal: c["demi-hi"], light: c["demi-hi"], name: [c["demi-hi"], c.demi], glow: c.demi }),
};

// Drawing

const fontStack = tokens.font;

export function font(ctx: CanvasRenderingContext2D, size: number, weight = 400, narrow = false): void {
  ctx.font = `${weight} ${size}px ${fontStack}`;
  if ("fontStretch" in ctx) ctx.fontStretch = narrow ? "condensed" : "normal";
}

export interface TextOptions {
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
export function text(ctx: CanvasRenderingContext2D, value: string | number, x: number, y: number, o: TextOptions): number {
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
export const caps = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: Rgb, align: CanvasTextAlign = "left") =>
  text(ctx, s.toUpperCase(), x, y, { size, weight: 700, narrow: true, color, align, spacing: size * 0.16 });

export function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A tier chip, like the site's: the tier's colour, its label on it. `align`: where `x` is. */
export function chip(ctx: CanvasRenderingContext2D, tier: Tier, x: number, y: number, size: number, align: CanvasTextAlign = "left"): void {
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
export function logo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
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
export function cup(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: Rgb): void {
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
export function ground(ctx: CanvasRenderingContext2D, W: number, H: number, glow: Rgb | null): void {
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

export function header(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, region: string, align: CanvasTextAlign = "left"): void {
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

export function footer(ctx: CanvasRenderingContext2D, W: number, y: number, size: number, align: CanvasTextAlign = "left", x = 0): void {
  text(ctx, "genjiball.us", align === "center" ? W / 2 : x, y, { size, weight: 600, color: c.muted, align, spacing: size * 0.05 });
}

export interface Series {
  points: { rating: number; t: number }[];
  color: Rgb;
  /** Line dashes, in line widths: dashed or dotted, so lines differ by more than shade. */
  dash?: "dashed" | "dotted";
}

/**
 * A rating line. Several are on one time axis. The area under a single line fades out; its peak gets
 * a dot, its last point a glow.
 */
export function lines(ctx: CanvasRenderingContext2D, series: Series[], x: number, y: number, w: number, h: number, area = true): void {
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
export function figures(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, y: number, w: number, size: number): void {
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
export function form(ctx: CanvasRenderingContext2D, results: number[], x: number, y: number, size: number, align: CanvasTextAlign = "left"): void {
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

/** The rating line is `up` if the shown range ended higher than it began, else `down` (brand.md, Charts). */
export const trend = (ratings: number[]): Rgb => ((ratings.at(-1) ?? 0) >= (ratings[0] ?? 0) ? c.up : c.down);

/** A crowned player's look and seal line ("Reigning God · Europe 1v1 champion"), or nulls. */
export function crownOf(d: PlayerCard): { look: ReturnType<(typeof titleLooks)[TitleName]> | null; seal: string | null } {
  if (!d.crown) return { look: null, seal: null };
  const [name, what] = titleSeals[d.crown];
  return { look: titleLooks[d.crown](), seal: `${name} · ${d.region} ${what}` };
}

/** "#3 in Europe", or why there's no rank. */
export const rankLine = (d: PlayerCard): string =>
  d.rank ? `#${d.rank} in ${d.region}` : d.rating ? "Not ranked yet" : `Not rated in ${d.region}`;

/** The change over the rating line: "▲ 120", with its colour; null without a line. */
export function change(points: number[]): { label: string; color: Rgb; value: number } | null {
  if (points.length < 2) return null;
  const value = (points.at(-1) ?? 0) - (points[0] ?? 0);
  return { label: `${value >= 0 ? "▲" : "▼"} ${Math.abs(value)}`, color: trend(points), value };
}

/** A match row's rating change, or null when it wasn't rated. */
export const rowDelta = (p: { before: number | null; after: number | null }): number | null =>
  p.after != null && p.before != null ? p.after - p.before : null;

/** Draws a closed shape from points and fills it. */
export function shape(ctx: CanvasRenderingContext2D, pts: [number, number][], fill: string | CanvasGradient): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** The blade: a straight line in the brand's green with a soft glow, the logo's slice at card size. */
export function blade(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number): void {
  ctx.save();
  ctx.strokeStyle = rgba(c.green);
  ctx.shadowColor = rgba(c.green, 0.6);
  ctx.shadowBlur = width * 4.5;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/** Text drawn as an outline only, for the big faint numbers behind a card. */
export function ghost(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, align: CanvasTextAlign = "right"): void {
  ctx.save();
  font(ctx, size, 800, true);
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.strokeStyle = rgba(c.line);
  ctx.lineWidth = 2;
  ctx.strokeText(value, x, y);
  ctx.restore();
}

// Layout: the styles lay a card out from the parts it shows (parts.ts), so it looks planned with any of
// them hidden. A column of blocks fills its room: when there's space to spare, the blocks that may
// grow get bigger, then the gaps between them open up; when there's too little, the gaps close and
// then everything shrinks a little.

/** One part of a card in a `stack`: `h` tall at scale 1, drawn from its top. */
export interface Block {
  h: number;
  /** Space above it, after the block before (none above the first). */
  gap?: number;
  /** How much bigger it may get when there's room: 0.4 is up to 40%. */
  grow?: number;
  draw: (top: number, scale: number) => void;
}
type Maybe<T> = T | false | null | undefined | 0 | "";

const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

/**
 * Lays `blocks` out from `top` to `bottom`. `align`: where the column sits when there's still room
 * left; "spread" puts all of it in the gaps. `stretch`: how far the gaps may open (2 is twice as
 * wide). Returns where the last block ended.
 */
export function stack(blocks: Maybe<Block>[], top: number, bottom: number, align: "start" | "center" | "end" | "spread" = "center", stretch = 2.2): number {
  const list = blocks.filter((b): b is Block => Boolean(b));
  if (!list.length) return top;
  const gaps = list.map((b, i) => (i ? (b.gap ?? 0) : 0));
  const gapSum = sum(gaps);
  const heights = sum(list.map((b) => b.h));
  let scales = list.map(() => 1);
  let g = 1;
  let left = bottom - top - heights - gapSum;
  if (left < 0) {
    g = Math.max(0.45, 1 + left / (gapSum || 1));
    left = bottom - top - heights - gapSum * g;
    if (left < 0) {
      const s = Math.max(0.6, (bottom - top - gapSum * g) / heights);
      scales = scales.map(() => s);
      left = bottom - top - heights * s - gapSum * g;
    }
  } else {
    // Half the room to the blocks that grow, then the gaps.
    const growable = sum(list.map((b) => b.h * (b.grow ?? 0)));
    if (growable > 0) {
      const t = Math.min(1, (left * 0.5) / growable);
      scales = list.map((b) => 1 + (b.grow ?? 0) * t);
      left -= growable * t;
    }
    if (gapSum > 0) {
      const extra = align === "spread" ? left : Math.min(left, gapSum * (stretch - 1));
      g += extra / gapSum;
      left -= extra;
    }
  }
  let y = top + (align === "end" ? left : align === "start" ? 0 : left / 2);
  list.forEach((b, i) => {
    const scale = scales[i] ?? 1;
    y += (gaps[i] ?? 0) * g;
    b.draw(y, scale);
    y += b.h * scale;
  });
  return y;
}

/** How tall `blocks` are at scale 1, gaps included: what a `stack` of them needs. */
export function natural(blocks: Maybe<Block>[]): number {
  const list = blocks.filter((b): b is Block => Boolean(b));
  return sum(list.map((b, i) => b.h + (i ? (b.gap ?? 0) : 0)));
}

/** The size `value` is drawn at with `o.max` (text shrinks to fit before it's cut). */
export function fitted(ctx: CanvasRenderingContext2D, value: string | number, o: TextOptions): number {
  const { size, weight = 400, narrow = false, max, shrink = 0.45, spacing = 0 } = o;
  if (!max) return size;
  let px = size;
  font(ctx, px, weight, narrow);
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
  while (px > size * shrink && ctx.measureText(String(value)).width > max) font(ctx, (px -= 2), weight, narrow);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  return px;
}

/** A line of text as a block, as tall as its capitals; its descenders hang into the gap below. */
export function line(ctx: CanvasRenderingContext2D, value: string | number, x: number, o: TextOptions, gap = 0, grow = 0): Block {
  const size = fitted(ctx, value, o);
  return { h: size * 0.72, gap, grow, draw: (top, k) => void text(ctx, value, x, top + size * k * 0.72, { ...o, size: size * k }) };
}

/** A small caps label as a block. */
export function label(ctx: CanvasRenderingContext2D, value: string, x: number, size: number, color: Rgb, align: CanvasTextAlign = "left", gap = 0): Block {
  return { h: size * 0.72, gap, draw: (top, k) => void caps(ctx, value, x, top + size * k * 0.72, size * k, color, align) };
}

/** A tier chip as a block. */
export function chipBlock(ctx: CanvasRenderingContext2D, tier: Tier, x: number, size: number, align: CanvasTextAlign = "left", gap = 0): Block {
  return { h: size * 1.55, gap, draw: (top, k) => chip(ctx, tier, x, top, size * k, align) };
}

/** Anything drawn in a fixed height (a chart, a row of figures) as a block. */
export const block = (h: number, gap: number, draw: (top: number, scale: number) => void, grow = 0): Block => ({ h, gap, grow, draw });

/** The width a tier chip takes. */
export function chipWidth(ctx: CanvasRenderingContext2D, tier: Tier, size: number): number {
  font(ctx, size, 650, true);
  return ctx.measureText(tier.label).width + size * 1.1;
}

// What the parts say, shared by the styles

const dash = "–";

/** A player's picked figures, labelled. */
export function playerStats(d: PlayerCard, on: Show<PlayerPart>): [string, string | number][] {
  const list: [PlayerPart, string, string | number][] = [
    ["rounds", "Rated rounds", d.rounds ?? dash],
    ["winRate", "Rounds won", d.winRate ?? dash],
    ["peak", "Peak", d.peak ?? dash],
    ["streak", "Best streak", d.bestStreak ?? dash],
  ];
  return list.filter(([part]) => on.has(part)).map(([, l, v]) => [l, v]);
}

/** A compared figure: its label, how it's shown, its value to find the leader by, and whether more is better. */
export type CompareRow = [string, (p: ComparedPlayer) => string, (p: ComparedPlayer) => number | null, 1 | -1];

/** The picked compare figures (the rating is drawn on its own). */
export function compareRows(on: Show<ComparePart>, withRating = false): CompareRow[] {
  const rows: [ComparePart, CompareRow][] = [
    ["rating", ["Rating", (p) => String(p.rating ?? dash), (p) => p.rating, 1]],
    ["rank", ["Rank", (p) => (p.rank ? `#${p.rank}` : dash), (p) => p.rank, -1]],
    ["winRate", ["Rounds won", (p) => p.winRate ?? dash, (p) => p.winShare, 1]],
    ["kills", ["Kills a round", (p) => p.killsPerRound?.toFixed(2) ?? dash, (p) => p.killsPerRound, 1]],
    ["peak", ["Peak", (p) => String(p.peak ?? dash), (p) => p.peak, 1]],
  ];
  return rows.filter(([part]) => on.has(part) && (withRating || part !== "rating")).map(([, row]) => row);
}

/** Whether `p` leads the row among `all` (only when there's someone to lead). */
export function leads(all: ComparedPlayer[], p: ComparedPlayer, row: CompareRow): boolean {
  const [, , value, better] = row;
  const known = all.map(value).filter((v): v is number => v != null);
  const mine = value(p);
  return all.length > 1 && known.length > 1 && mine != null && mine === (better > 0 ? Math.max(...known) : Math.min(...known));
}

/** A match's picked facts: "12 Oct  ·  Busan  ·  4 rounds". */
export function matchFacts(d: MatchCard, on: Show<MatchPart>): string {
  const list: [MatchPart, string][] = [
    ["date", d.date],
    ["map", d.map],
    ["length", d.rounds],
    ["playerCount", d.playerCount],
  ];
  return list
    .filter(([part, v]) => on.has(part) && v)
    .map(([, v]) => v)
    .join("  ·  ");
}

/** "Match #12 · Tourney, lobby A", as far as it's picked; "" when neither is. */
export const matchId = (d: MatchCard, on: Show<MatchPart>): string =>
  [on.has("id") && `Match #${d.id}`, on.has("tourney") && d.tourney].filter(Boolean).join(" · ");

/** "▲ 12", "▼ 3", or null for no change. */
export const deltaLabel = (delta: number | null): string | null => (delta ? `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}` : null);

/** The size labelled figures fit `width` at (`inline`), up to `size`. */
export function inlineSize(ctx: CanvasRenderingContext2D, list: [string, string | number][], width: number, size: number, gap: number): number {
  let total = 0;
  for (const [l, value] of list) {
    font(ctx, size * 0.36, 700, true);
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${size * 0.36 * 0.16}px`;
    const labelW = ctx.measureText(l.toUpperCase()).width;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    font(ctx, size, 700, true);
    total += Math.max(labelW, ctx.measureText(String(value)).width);
  }
  total += gap * Math.max(0, list.length - 1);
  return total > width ? size * (width / total) : size;
}

/** Labelled figures in a row (`inline`) as a block, sized to fit `width`. */
export function inlineBlock(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, width: number, size: number, gapX: number, gap = 0, grow = 0): Block | null {
  if (!list.length) return null;
  const s = inlineSize(ctx, list, width, size, gapX);
  const fit = s / size;
  return block(s * 1.28, gap, (top, k) => void inline(ctx, list, x, top + s * k * 1.28, s * k, gapX * fit * k), grow);
}

/** Figures across `w` (`figures`) as a block. */
export function figuresBlock(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, w: number, size: number, gap = 0): Block | null {
  if (!list.length) return null;
  return block(size * 1.62, gap, (top, k) => figures(ctx, list, x, top + size * k * 1.1, w, size * k));
}

/** Recent form as a block: the last rounds that fit `width` at `size` or a little smaller (up to 20), each its place. */
export function formBlock(ctx: CanvasRenderingContext2D, results: number[], x: number, width: number, size: number, align: CanvasTextAlign = "left", gap = 0, most = 20): Block | null {
  if (!results.length) return null;
  // n squares at size s are s × (1.18n − 0.18) wide.
  const fits = Math.floor((width / (size * 0.65) + 0.18) / 1.18);
  const n = Math.max(1, Math.min(results.length, most, fits));
  const s = Math.min(size, width / (1.18 * n - 0.18));
  const list = results.slice(-n);
  return block(s, gap, (top) => form(ctx, list, x, top, s, align));
}

/** A rating line (`lines`) as a block, which grows into spare room. */
export function chartBlock(ctx: CanvasRenderingContext2D, series: Series[], x: number, w: number, h: number, gap = 0, grow = 1.2, area = series.length === 1): Block | null {
  if (!series.length) return null;
  // The peak's label sits above the line.
  const head = series.length === 1 ? Math.max(16, h / 7) * 1.4 : 0;
  return block(h, gap, (top, k) => lines(ctx, series, x, top + head * k, w, h * k - head * k, area), grow);
}

/** A player's rating line as one series, in the colour of its change. */
export const playerSeries = (d: PlayerCard): Series[] => (d.points.length > 1 ? [{ points: d.points.map((rating, t) => ({ rating, t })), color: trend(d.points) }] : []);

export interface TableOptions {
  x: number;
  w: number;
  /** Text size; a row is `rowH` tall. */
  size: number;
  rowH: number;
  /** Most rows shown; the rest are counted under the table. */
  max: number;
  prize: Rgb;
  /** Column labels over it; "auto" when there's a column of plain numbers to tell apart. */
  head?: boolean | "auto";
  /** "rules": a line between rows; "bands": rows on light bands; "plain": neither. */
  look?: "rules" | "bands" | "plain";
}

/** How wide a match's standings want to be at `size` for the picked columns (`table`). */
export function tableWidth(on: Show<MatchPart>, size: number): number {
  const widths: [MatchPart, number][] = [["won", 2.6], ["kills", 2.8], ["ratings", 3.2], ["changes", 3.4]];
  return size * (2.2 + 5 + widths.reduce((a, [part, w]) => a + (on.has(part) ? w : 0), 0));
}

/**
 * A match's standings: place and name, then the picked columns (rounds won, kills, rating, change).
 * The columns fit the width; with too many for it the text gets smaller. A block, or null when the
 * standings aren't picked.
 */
export function table(ctx: CanvasRenderingContext2D, d: MatchCard, on: Show<MatchPart>, o: TableOptions, gap = 0): Block | null {
  if (!on.has("standings") || !d.rows.length) return null;
  const { x, w, prize, look = "plain" } = o;
  const cols: { part: MatchPart; label: string; width: number; value: (p: MatchCard["rows"][number]) => { s: string | number; color: Rgb; weight: number } }[] = [
    { part: "won", label: "Won", width: 2.6, value: (p) => ({ s: p.won, color: c.soft, weight: 600 }) },
    { part: "kills", label: "Kills", width: 2.8, value: (p) => ({ s: p.kills, color: c.soft, weight: 600 }) },
    { part: "ratings", label: "Rating", width: 3.2, value: (p) => ({ s: p.after ?? dash, color: p.after ? c.fg : c["control-border"], weight: 700 }) },
    {
      part: "changes",
      label: "Change",
      width: 3.4,
      value: (p) => {
        const delta = rowDelta(p);
        return { s: deltaLabel(delta) ?? dash, color: delta ? (delta > 0 ? c.up : c.down) : c.muted, weight: 700 };
      },
    },
  ];
  const shown = cols.filter((col) => on.has(col.part));
  const head = o.head === "auto" || o.head === undefined ? shown.some((col) => col.part !== "changes") : o.head;
  // Room for a name of about eight letters, or smaller text.
  const need = (s: number) => s * 2.2 + shown.reduce((a, col) => a + col.width * s, 0) + s * 5;
  const size = Math.min(o.size, o.size * (w / need(o.size)));
  const rowH = o.rowH * (size / o.size);
  const rows = d.rows.slice(0, o.max);
  const more = d.rows.length - rows.length;
  const headH = head ? size * 1.1 : 0;
  const h = headH + rows.length * rowH + (more > 0 ? size * 0.9 : 0);
  return block(h, gap, (top) => {
    let right = x + w;
    const at = shown
      .slice()
      .reverse()
      .map((col) => {
        const pos = right;
        right -= col.width * size;
        return { ...col, pos };
      })
      .reverse();
    const place = x + size * 0.6;
    const name = x + size * 1.6;
    if (head) {
      const y = top + size * 0.45;
      caps(ctx, "#", place, y, size * 0.5, c.muted, "center");
      caps(ctx, "Player", name, y, size * 0.5, c.muted);
      for (const col of at) caps(ctx, col.label, col.pos, y, size * 0.5, c.muted, "right");
    }
    rows.forEach((p, i) => {
      const rowTop = top + headH + i * rowH;
      const base = rowTop + rowH / 2 + size * 0.36;
      const first = p.place === 1;
      if (look === "bands") {
        box(ctx, x, rowTop + rowH * 0.06, w, rowH * 0.88, Math.min(10, rowH * 0.15));
        ctx.fillStyle = first ? rgba(prize, 0.1) : rgba(c.fg, i % 2 ? 0.02 : 0.045);
        ctx.fill();
      } else if (look === "rules") {
        ctx.fillStyle = rgba(i ? c.line : c.border);
        ctx.fillRect(x, rowTop, w, 1.5);
      }
      text(ctx, p.place, place, base, { size: size * 1.05, weight: 800, narrow: true, align: "center", color: first ? prize : c.muted });
      text(ctx, p.name, name, base, { size, weight: first ? 700 : 600, narrow: true, color: first ? c.fg : c.soft, max: right - name - size * 0.6, shrink: 0.7 });
      for (const col of at) {
        const v = col.value(p);
        text(ctx, v.s, col.pos, base, { size: col.part === "changes" ? size * 0.85 : size, weight: v.weight, narrow: true, align: "right", color: v.color });
      }
    });
    const end = top + headH + rows.length * rowH;
    if (look === "rules") {
      ctx.fillStyle = rgba(c.border);
      ctx.fillRect(x, end, w, 1.5);
    }
    if (more > 0) caps(ctx, `+ ${more} more`, name, end + size * 0.75, size * 0.48, c.muted);
  });
}

/**
 * The standings (`table`) with as many rows as fit `room`: the text gets a little smaller first, then
 * the last rows are counted instead. Without columns the names don't take the whole width.
 */
export function fitTable(ctx: CanvasRenderingContext2D, d: MatchCard, on: Show<MatchPart>, o: Omit<TableOptions, "rowH" | "max">, room: number, gap = 0): Block | null {
  if (!on.has("standings") || !d.rows.length) return null;
  const head = o.head === "auto" || o.head === undefined ? on.count("won", "kills", "ratings") > 0 : o.head;
  const tall = (s: number, rows: number) => (head ? s * 1.1 : 0) + rows * s * 1.7 + (rows < d.rows.length ? s * 0.9 : 0);
  const size = Math.max(o.size * 0.75, Math.min(o.size, room / tall(1, d.rows.length)));
  let max = d.rows.length;
  while (max > 1 && tall(size, max) > room) max--;
  const w = on.count("won", "kills", "ratings", "changes") ? o.w : Math.min(o.w, Math.max(o.w * 0.55, size * 14));
  return table(ctx, d, on, { ...o, w, head, size, rowH: size * 1.7, max }, gap);
}

/** Labelled figures in a row, each as wide as it needs, `gap` apart. Returns where the row ended. */
export function inline(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, y: number, size: number, gap: number): number {
  let left = x;
  for (const [label, value] of list) {
    font(ctx, size * 0.36, 700, true);
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${size * 0.36 * 0.16}px`;
    const labelW = ctx.measureText(label.toUpperCase()).width;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    caps(ctx, label, left, y - size * 1.02, size * 0.36, c.muted);
    const valueW = text(ctx, value, left, y, { size, weight: 700, narrow: true });
    left += Math.max(labelW, valueW) + gap;
  }
  return left - gap;
}
