// What every card style draws with: the brand's colours, Saira, and the marks and parts the styles
// share (the logo, a tier chip, a rating line, recent form).
import { contrastRatio, oklchToRgb, type Rgb as Unit } from "@genji-ball-team/ui/color.js";
import { icons } from "@genji-ball-team/ui/icons.js";
import { tokens, type TokenName } from "@genji-ball-team/ui/tokens.js";
import type { Tier, TitleName } from "../lib/types";
import { titleSeals } from "../titles";
import type { PlayerCard } from "./types";

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
