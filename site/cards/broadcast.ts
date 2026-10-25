// Broadcast: a TV graphic. A panel cut by the blade (the logo's slice), the tier as a bar down the
// edge, the rank huge and faint behind, the rating as the one big number.
import { blade, c, caps, change, chip, crownOf, cup, footer, ghost, header, inline, rankLine, rgba, rowDelta, shape, text, type Rgb } from "./kit";
import type { ComparedPlayer, CompareCard, MatchCard, PlayerCard } from "./types";

/** The ground: dark, `behind` drawn on it, then a lighter panel with the blade along its `edge`. */
function panel(ctx: CanvasRenderingContext2D, W: number, H: number, pts: [number, number][], edge: [number, number, number, number], width: number, behind?: () => void): void {
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, W, H);
  behind?.();
  shape(ctx, pts, rgba(c.panel));
  blade(ctx, ...edge, width);
}

function bar(ctx: CanvasRenderingContext2D, H: number, color: Rgb | null | undefined, width: number): void {
  if (!color) return;
  ctx.fillStyle = rgba(color);
  ctx.fillRect(0, 0, width, H);
}

/** "▲ 120 last 14 matches" under the rating. */
function changeLine(ctx: CanvasRenderingContext2D, points: number[], x: number, y: number, size: number): void {
  const moved = change(points);
  if (!moved) return;
  const note = `last ${points.length} matches`;
  const noteW = text(ctx, note, x, y, { size: size * 0.8, weight: 500, narrow: true, color: c.muted, align: "right" });
  text(ctx, moved.label, x - noteW - size * 0.4, y, { size, weight: 700, narrow: true, color: moved.color, align: "right" });
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean): void {
  const { look, seal } = crownOf(d);
  const stats: [string, string | number][] = [
    ["Rounds won", d.winRate ?? "–"],
    ["Peak", d.peak ?? "–"],
    ["Best streak", d.bestStreak ?? "–"],
  ];
  const rating = d.rating ?? "–";
  if (!tall) {
    const pad = 64;
    panel(ctx, W, H, [[0, 0], [790, 0], [650, H], [0, H]], [650, H, 790, 0], 4, () => d.rank && ghost(ctx, `#${d.rank}`, W + 30, H + 110, 520));
    bar(ctx, H, look?.light ?? d.tier?.color, 12);
    header(ctx, pad, 74, 22, d.region);
    if (seal) caps(ctx, seal, pad, 138, 18, look?.seal ?? c.fg);
    text(ctx, d.name, pad, 272, { size: 128, weight: 800, narrow: true, max: 560, fill: look?.name });
    if (d.tier) chip(ctx, d.tier, pad, 302, 22);
    inline(ctx, stats, pad, 500, 56, 48);
    caps(ctx, "Rating", W - pad, 150, 20, c.muted, "right");
    text(ctx, rating, W - pad, 318, { size: 210, weight: 700, narrow: true, align: "right", color: look?.light ?? c.fg });
    text(ctx, rankLine(d), W - pad, 372, { size: 34, weight: 600, narrow: true, color: c.soft, align: "right" });
    changeLine(ctx, d.points, W - pad, 418, 30);
    footer(ctx, W, 592, 22, "right", W - pad);
    return;
  }
  const pad = 80;
  panel(ctx, W, H, [[0, 0], [W, 0], [W, 1020], [0, 1200]], [0, 1200, W, 1020], 6, () => d.rank && ghost(ctx, `#${d.rank}`, W + 40, H + 200, 900));
  bar(ctx, H, look?.light ?? d.tier?.color, 16);
  header(ctx, pad, 150, 34, d.region);
  if (seal) caps(ctx, seal, pad, 280, 28, look?.seal ?? c.fg);
  text(ctx, d.name, pad, 500, { size: 200, weight: 800, narrow: true, max: W - pad * 2, fill: look?.name });
  if (d.tier) chip(ctx, d.tier, pad, 548, 40);
  inline(ctx, stats, pad, 900, 84, 64);
  caps(ctx, "Rating", W - pad, 1330, 32, c.muted, "right");
  text(ctx, rating, W - pad, 1610, { size: 330, weight: 700, narrow: true, align: "right", color: look?.light ?? c.fg });
  text(ctx, rankLine(d), W - pad, 1690, { size: 52, weight: 600, narrow: true, color: c.soft, align: "right" });
  changeLine(ctx, d.points, W - pad, 1760, 44);
  footer(ctx, W, 1860, 30, "left", pad);
}

/** A standings list: place, name, the rating change. */
function standings(ctx: CanvasRenderingContext2D, d: MatchCard, x: number, y: number, w: number, step: number, size: number, max: number, prize: Rgb): void {
  d.rows.slice(0, max).forEach((p, i) => {
    const base = y + i * step;
    const first = p.place === 1;
    text(ctx, p.place, x + size * 0.5, base, { size: size * 1.1, weight: 800, narrow: true, align: "center", color: first ? prize : c.muted });
    const delta = rowDelta(p);
    let right = x + w;
    if (delta) right -= text(ctx, `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}`, right, base, { size: size * 0.8, weight: 700, narrow: true, align: "right", color: delta > 0 ? c.up : c.down }) + size * 0.5;
    text(ctx, p.name, x + size * 1.5, base, { size, weight: first ? 700 : 600, narrow: true, color: first ? c.fg : c.soft, max: right - x - size * 1.5, shrink: 0.7 });
  });
  if (d.rows.length > max) caps(ctx, `+ ${d.rows.length - max} more`, x + size * 1.5, y + max * step - size * 0.1, size * 0.5, c.muted);
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean): void {
  const prize = d.tourney ? c.gold : c.up;
  const winner = d.winners.join(" & ");
  const label = d.winners.length > 1 ? "Shared win" : "Winner";
  const facts = [d.date, d.map, d.rounds, d.playerCount].filter(Boolean).join("  ·  ");
  const id = `Match #${d.id}${d.tourney ? ` · ${d.tourney}` : ""}`;
  const nameFill = [c.fg, d.tourney ? c.gold : c["god-cream"]];
  if (!tall) {
    const pad = 64;
    panel(ctx, W, H, [[0, 0], [790, 0], [650, H], [0, H]], [650, H, 790, 0], 4);
    bar(ctx, H, prize, 12);
    header(ctx, pad, 74, 22, d.region);
    if (winner) {
      cup(ctx, pad, 172, 36, prize);
      caps(ctx, label, pad + 50, 200, 22, prize);
      text(ctx, winner, pad, 320, { size: 112, weight: 800, narrow: true, max: 540, fill: nameFill });
      text(ctx, d.winnerLine, pad, 372, { size: 30, weight: 500, narrow: true, color: c.soft, max: 540 });
    }
    caps(ctx, id, pad, 500, 20, c.muted);
    text(ctx, facts, pad, 540, { size: 26, weight: 500, narrow: true, color: c.soft, max: 540 });
    standings(ctx, d, 832, 136, W - 832 - pad, 66, 34, 6, prize);
    footer(ctx, W, 592, 22, "right", W - pad);
    return;
  }
  const pad = 80;
  panel(ctx, W, H, [[0, 0], [W, 0], [W, 900], [0, 1080]], [0, 1080, W, 900], 6);
  bar(ctx, H, prize, 16);
  header(ctx, pad, 150, 34, d.region);
  caps(ctx, id, pad, 290, 30, c.muted);
  text(ctx, facts, pad, 346, { size: 38, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 });
  if (winner) {
    cup(ctx, pad, 470, 64, prize);
    caps(ctx, label, pad + 86, 520, 34, prize);
    text(ctx, winner, pad, 720, { size: 180, weight: 800, narrow: true, max: W - pad * 2, fill: nameFill });
    text(ctx, d.winnerLine, pad, 800, { size: 46, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 });
  }
  standings(ctx, d, pad, 1230, W - pad * 2, 82, 50, 7, prize);
  footer(ctx, W, 1860, 30, "left", pad);
}

/** One player's side of a compare card. */
function side(ctx: CanvasRenderingContext2D, p: ComparedPlayer, all: ComparedPlayer[], x: number, y: number, w: number, s: number): void {
  text(ctx, p.name, x, y, { size: 84 * s, weight: 800, narrow: true, max: w });
  if (p.tier) chip(ctx, p.tier, x, y + 22 * s, 20 * s);
  text(ctx, p.rating ?? "–", x, y + 170 * s, { size: 110 * s, weight: 700, narrow: true, color: p.rating ? c.fg : c["control-border"] });
  text(ctx, p.rank ? `#${p.rank}` : "Not ranked", x, y + 214 * s, { size: 30 * s, weight: 600, narrow: true, color: c.soft });
  const rows: [string, (q: ComparedPlayer) => number | null, string][] = [
    ["Rounds won", (q) => q.winShare, p.winRate ?? "–"],
    ["Kills a round", (q) => q.killsPerRound, p.killsPerRound?.toFixed(2) ?? "–"],
    ["Peak", (q) => q.peak, String(p.peak ?? "–")],
  ];
  rows.forEach(([label, value, shown], i) => {
    const ry = y + (270 + i * 40) * s;
    const known = all.map(value).filter((v): v is number => v != null);
    const mine = value(p);
    const best = all.length > 1 && known.length > 1 && mine != null && mine === Math.max(...known);
    text(ctx, label, x, ry, { size: 22 * s, color: c.muted, max: w * 0.6 });
    text(ctx, shown, x + w, ry, { size: 26 * s, weight: best ? 800 : 600, narrow: true, align: "right", color: best ? c.fg : c.muted });
  });
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean): void {
  const n = Math.max(1, d.players.length);
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, W, H);
  if (!tall) {
    const pad = 64;
    const slant = 70;
    const zone = W / n;
    // Every other side on the lighter panel, the blade between sides.
    for (let i = 0; i < n; i += 2) {
      const l = i * zone;
      const r = (i + 1) * zone;
      shape(ctx, [[i ? l + slant : 0, 0], [i < n - 1 ? r + slant : W, 0], [i < n - 1 ? r - slant : W, H], [i ? l - slant : 0, H]], rgba(c.panel));
    }
    for (let i = 1; i < n; i++) blade(ctx, i * zone - slant, H, i * zone + slant, 0, 4);
    header(ctx, pad, 74, 22, d.region);
    const s = n > 2 ? 0.72 : 1;
    d.players.forEach((p, i) => {
      const left = i * zone + (i ? slant + 40 : pad);
      const right = (i + 1) * zone - (i < n - 1 ? slant + 40 : pad);
      side(ctx, p, d.players, left, 210, right - left, s);
    });
    if (n === 2) vs(ctx, W / 2, H / 2 + 20, 34);
    footer(ctx, W, 592, 22, "right", W - pad);
    return;
  }
  const pad = 80;
  const top = 240;
  const zone = (H - top - 120) / n;
  const slant = 60;
  for (let i = 0; i < n; i += 2) {
    const t = top + i * zone;
    const b = top + (i + 1) * zone;
    shape(ctx, [[0, i ? t + slant : 0], [W, i ? t - slant : 0], [W, i < n - 1 ? b - slant : H], [0, i < n - 1 ? b + slant : H]], rgba(c.panel));
  }
  for (let i = 1; i < n; i++) blade(ctx, 0, top + i * zone + slant, W, top + i * zone - slant, 6);
  header(ctx, pad, 150, 34, d.region);
  const s = n > 2 ? 1.05 : 1.45;
  d.players.forEach((p, i) => side(ctx, p, d.players, pad, top + i * zone + (n > 2 ? 140 : 200), W - pad * 2, s));
  if (n === 2) vs(ctx, W - pad - 50, top + zone, 46);
  footer(ctx, W, 1860, 30, "left", pad);
}

/** "VS" on a disc where the sides meet. */
function vs(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.beginPath();
  ctx.arc(x, y, size * 1.4, 0, Math.PI * 2);
  ctx.fillStyle = rgba(c.bg);
  ctx.fill();
  ctx.strokeStyle = rgba(c.green);
  ctx.lineWidth = 3;
  ctx.stroke();
  text(ctx, "VS", x, y + size * 0.36, { size, weight: 800, narrow: true, align: "center" });
}
