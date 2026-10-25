// Spotlight: everything centred under one light from above. A player stands in it; a match is a
// podium; a head to head is a fight card, the two names either side of "VS".
import { c, caps, change, chip, crownOf, cup, font, footer, form, header, logo, rankLine, rgba, rowDelta, text, type Rgb } from "./kit";
import type { ComparedPlayer, CompareCard, MatchCard, PlayerCard } from "./types";

/** The ground: dark, a cone of light from the top centre in `color`. */
function ground(ctx: CanvasRenderingContext2D, W: number, H: number, color: Rgb | null): void {
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, W, H);
  const light = color ?? c.soft;
  const g = ctx.createRadialGradient(W / 2, -H * 0.1, 0, W / 2, -H * 0.1, H * 1.05);
  g.addColorStop(0, rgba(light, color ? 0.26 : 0.12));
  g.addColorStop(0.55, rgba(light, color ? 0.06 : 0.03));
  g.addColorStop(1, rgba(light, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** Labelled figures centred on `x`, with a dot between them. */
function row(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, y: number, size: number, gap: number): void {
  const widths = list.map(([label, value]) => {
    const vw = measure(ctx, String(value), size, 700);
    const lw = measure(ctx, label.toUpperCase(), size * 0.36, 700, size * 0.36 * 0.16);
    return Math.max(vw, lw);
  });
  const total = widths.reduce((a, b) => a + b, 0) + gap * (list.length - 1);
  let left = x - total / 2;
  list.forEach(([label, value], i) => {
    const w = widths[i] ?? 0;
    caps(ctx, label, left + w / 2, y - size * 1.02, size * 0.36, c.muted, "center");
    text(ctx, value, left + w / 2, y, { size, weight: 700, narrow: true, align: "center" });
    left += w + gap;
  });
}

function measure(ctx: CanvasRenderingContext2D, s: string, size: number, weight: number, spacing = 0): number {
  font(ctx, size, weight, true);
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
  const w = ctx.measureText(s).width;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  return w;
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean): void {
  const { look, seal } = crownOf(d);
  ground(ctx, W, H, look?.glow ?? d.tier?.color ?? null);
  const moved = change(d.points);
  const stats: [string, string | number][] = [
    ["Rounds won", d.winRate ?? "–"],
    ["Peak", d.peak ?? "–"],
    ["Best streak", d.bestStreak ?? "–"],
  ];
  const rating = String(d.rating ?? "–");
  const cx = W / 2;
  if (!tall) {
    header(ctx, cx, 70, 20, d.region, "center");
    if (seal) caps(ctx, seal, cx, 118, 18, look?.seal ?? c.fg, "center");
    text(ctx, d.name, cx, 230, { size: 120, weight: 800, narrow: true, align: "center", max: W - 160, fill: look?.name });
    if (d.tier) chip(ctx, d.tier, cx, 254, 22, "center");
    text(ctx, rating, cx, 438, { size: 150, weight: 700, narrow: true, align: "center", color: look?.light ?? c.fg });
    // The rank, and the change after it when there is one.
    const rank = rankLine(d);
    if (moved) {
      const rw = measure(ctx, rank, 30, 600);
      const mw = measure(ctx, moved.label, 30, 700);
      const left = cx - (rw + 24 + mw) / 2;
      text(ctx, rank, left, 488, { size: 30, weight: 600, narrow: true, color: c.soft });
      text(ctx, moved.label, left + rw + 24, 488, { size: 30, weight: 700, narrow: true, color: moved.color });
    } else text(ctx, rank, cx, 488, { size: 30, weight: 600, narrow: true, color: c.soft, align: "center" });
    row(ctx, stats, cx, 584, 40, 72);
    footer(ctx, W, 600, 18, "right", W - 48);
    return;
  }
  header(ctx, cx, 150, 34, d.region, "center");
  if (seal) caps(ctx, seal, cx, 290, 28, look?.seal ?? c.fg, "center");
  text(ctx, d.name, cx, 500, { size: 200, weight: 800, narrow: true, align: "center", max: W - 160, fill: look?.name });
  if (d.tier) chip(ctx, d.tier, cx, 548, 42, "center");
  caps(ctx, "Rating", cx, 790, 32, c.muted, "center");
  text(ctx, rating, cx, 1060, { size: 320, weight: 700, narrow: true, align: "center", color: look?.light ?? c.fg });
  text(ctx, rankLine(d), cx, 1140, { size: 52, weight: 600, narrow: true, color: c.soft, align: "center" });
  if (moved) text(ctx, `${moved.label}  last ${d.points.length} matches`, cx, 1210, { size: 42, weight: 700, narrow: true, color: moved.color, align: "center" });
  row(ctx, stats, cx, 1480, 84, 90);
  if (d.form.length) form(ctx, d.form.slice(-10), cx, 1640, 72, "center");
  footer(ctx, W, 1860, 30, "center");
}

/** The podium: the top three on steps, first in the middle, their names and rating change above. */
function podium(ctx: CanvasRenderingContext2D, d: MatchCard, cx: number, floor: number, stepW: number, heights: [number, number, number], size: number, prize: Rgb): void {
  // Left to right: second, first, third.
  const order = [1, 0, 2];
  const gap = stepW * 0.06;
  order.forEach((rank, slot) => {
    const p = d.rows[rank];
    if (!p) return;
    const h = heights[rank] ?? 0;
    const x = cx + (slot - 1) * (stepW + gap) - stepW / 2;
    const y = floor - h;
    const first = p.place === 1;
    const g = ctx.createLinearGradient(0, y, 0, floor);
    g.addColorStop(0, rgba(first ? prize : c.raised, first ? 0.32 : 1));
    g.addColorStop(1, rgba(first ? prize : c.raised, first ? 0.04 : 0.2));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x, y, stepW, h, [10, 10, 0, 0]);
    ctx.fill();
    ctx.fillStyle = rgba(first ? prize : c.border);
    ctx.fillRect(x, y, stepW, 3);
    text(ctx, p.place, x + stepW / 2, y + size * 2.1, { size: size * 1.9, weight: 800, narrow: true, align: "center", color: first ? prize : c.soft });
    const delta = rowDelta(p);
    if (delta) text(ctx, `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}`, x + stepW / 2, y - size * 0.5, { size: size * 0.75, weight: 700, narrow: true, align: "center", color: delta > 0 ? c.up : c.down });
    text(ctx, p.name, x + stepW / 2, y - size * (delta ? 1.5 : 0.5), { size, weight: 800, narrow: true, align: "center", max: stepW + gap, shrink: 0.6, fill: first ? [c.fg, prize === c.gold ? c.gold : c["god-cream"]] : undefined });
    if (first && rank === 0) cup(ctx, x + stepW / 2 - size * 0.6, y - size * (delta ? 3.1 : 2.1), size * 1.2, prize);
  });
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean): void {
  const prize = d.tourney ? c.gold : c.up;
  ground(ctx, W, H, d.tourney ? c.gold : null);
  const cx = W / 2;
  const facts = [d.date, d.map, d.rounds, d.playerCount].filter(Boolean).join("  ·  ");
  const id = `Match #${d.id}${d.tourney ? ` · ${d.tourney}` : ""}`;
  if (!tall) {
    header(ctx, cx, 64, 20, d.region, "center");
    caps(ctx, id, cx, 108, 18, c.muted, "center");
    text(ctx, facts, cx, 142, { size: 24, weight: 500, narrow: true, color: c.soft, align: "center", max: W - 160 });
    podium(ctx, d, cx, H, 280, [250, 180, 130], 40, prize);
    footer(ctx, W, 600, 18, "right", W - 40);
    return;
  }
  header(ctx, cx, 150, 34, d.region, "center");
  caps(ctx, id, cx, 270, 30, c.muted, "center");
  text(ctx, facts, cx, 330, { size: 38, weight: 500, narrow: true, color: c.soft, align: "center", max: W - 160 });
  podium(ctx, d, cx, 1180, 320, [420, 300, 220], 60, prize);
  // The rest, below the podium.
  d.rows.slice(3, 10).forEach((p, i) => {
    const y = 1290 + i * 78;
    text(ctx, p.place, 200, y, { size: 44, weight: 700, narrow: true, align: "center", color: c.muted });
    text(ctx, p.name, 260, y, { size: 44, weight: 600, narrow: true, color: c.soft, max: 480 });
    const delta = rowDelta(p);
    text(ctx, delta ? `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}` : "–", W - 200, y, { size: 40, weight: 700, narrow: true, align: "right", color: delta ? (delta > 0 ? c.up : c.down) : c.muted });
  });
  footer(ctx, W, 1860, 30, "center");
}

const statRows: [string, (p: ComparedPlayer) => string, (p: ComparedPlayer) => number | null, 1 | -1][] = [
  ["Rank", (p) => (p.rank ? `#${p.rank}` : "–"), (p) => p.rank, -1],
  ["Rounds won", (p) => p.winRate ?? "–", (p) => p.winShare, 1],
  ["Kills a round", (p) => p.killsPerRound?.toFixed(2) ?? "–", (p) => p.killsPerRound, 1],
  ["Peak", (p) => String(p.peak ?? "–"), (p) => p.peak, 1],
];
const leads = (all: ComparedPlayer[], p: ComparedPlayer, value: (q: ComparedPlayer) => number | null, better: 1 | -1) => {
  const known = all.map(value).filter((v): v is number => v != null);
  const mine = value(p);
  return all.length > 1 && known.length > 1 && mine != null && mine === (better > 0 ? Math.max(...known) : Math.min(...known));
};

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean): void {
  ground(ctx, W, H, null);
  const cx = W / 2;
  const s = tall ? 1.5 : 1;
  const [a, b] = d.players;
  header(ctx, cx, tall ? 150 : 64, (tall ? 34 : 20), d.region, "center");
  if (d.players.length === 2 && a && b) {
    // The fight card: names either side, "VS" between, each row's figures either side of its label.
    const nameY = tall ? 520 : 200;
    const side = tall ? 300 : 300;
    const max = tall ? 440 : 420;
    for (const [p, x] of [[a, cx - side], [b, cx + side]] as const) {
      text(ctx, p.name, x, nameY, { size: 84 * s, weight: 800, narrow: true, align: "center", max });
      if (p.tier) chip(ctx, p.tier, x, nameY + 20 * s, 20 * s, "center");
      text(ctx, p.rating ?? "–", x, nameY + 150 * s, { size: 90 * s, weight: 700, narrow: true, align: "center", color: p.rating ? c.fg : c["control-border"] });
    }
    logo(ctx, cx, nameY - 70 * s, 22 * s);
    text(ctx, "VS", cx, nameY + 20 * s, { size: 64 * s, weight: 800, narrow: true, align: "center", color: c.muted });
    const top = nameY + (tall ? 380 : 220);
    const step = tall ? 120 : 44;
    statRows.forEach(([label, show, value, better], j) => {
      const y = top + j * step;
      caps(ctx, label, cx, y, 16 * s, c.muted, "center");
      for (const [p, x] of [[a, cx - side], [b, cx + side]] as const) {
        const best = leads(d.players, p, value, better);
        text(ctx, show(p), x, y + 4 * s, { size: 34 * s, weight: best ? 800 : 600, narrow: true, align: "center", color: best ? c.fg : c.muted });
      }
    });
    footer(ctx, W, tall ? 1860 : 600, tall ? 30 : 18, tall ? "center" : "right", tall ? 0 : W - 40);
    return;
  }
  // One or three players: side by side, centred in their columns.
  const n = Math.max(1, d.players.length);
  const pad = tall ? 60 : 64;
  const colW = (W - pad * 2) / n;
  const nameY = tall ? 520 : 200;
  d.players.forEach((p, i) => {
    const x = pad + colW * (i + 0.5);
    text(ctx, p.name, x, nameY, { size: (n > 1 ? 64 : 110) * s * (tall && n > 1 ? 0.8 : 1), weight: 800, narrow: true, align: "center", max: colW - 24 });
    if (p.tier) chip(ctx, p.tier, x, nameY + 18 * s, 18 * s, "center");
    text(ctx, p.rating ?? "–", x, nameY + 130 * s, { size: 72 * s, weight: 700, narrow: true, align: "center", color: p.rating ? c.fg : c["control-border"] });
    statRows.forEach(([label, show, value, better], j) => {
      const y = nameY + (tall ? 400 : 190) + j * (tall ? 170 : 52);
      if (i === 0) caps(ctx, label, cx, y - (tall ? 40 : 18), 14 * s, c.muted, "center");
      const best = leads(d.players, p, value, better);
      text(ctx, show(p), x, y + 12 * s, { size: 30 * s, weight: best ? 800 : 600, narrow: true, align: "center", color: best ? c.fg : c.muted });
    });
  });
  footer(ctx, W, tall ? 1860 : 600, tall ? 30 : 18, tall ? "center" : "right", tall ? 0 : W - 40);
}
