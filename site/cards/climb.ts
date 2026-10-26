// Climb: the rating line is the card. It fills the bottom edge to edge, shaded under, in one colour
// from the net change (up or down), with the tier's threshold as a dashed line. A match shows each
// player's swing as a bar; a compare card shows everyone's lines.
import { c, caps, change, chip, crownOf, figures, font, footer, header, lines, rankLine, rgba, rowDelta, text, trend, type Rgb, type Series } from "./kit";
import type { CompareCard, MatchCard, PlayerCard } from "./types";

/** The ground, with a glow in `color` low on the right, where the line ends. */
function ground(ctx: CanvasRenderingContext2D, W: number, H: number, color: Rgb | null): void {
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, W, H);
  if (!color) return;
  const g = ctx.createRadialGradient(W * 0.85, H, 0, W * 0.85, H, Math.max(W, H) * 0.75);
  g.addColorStop(0, rgba(color, 0.16));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** The line, from the left edge to `end`, shaded down to the card's bottom; `threshold` a dashed line across. */
function climb(ctx: CanvasRenderingContext2D, points: number[], top: number, bottom: number, end: number, W: number, threshold: number | null): void {
  const color = trend(points);
  const lo = Math.min(...points, threshold ?? Infinity) - 80;
  const hi = Math.max(...points, threshold ?? -Infinity) + 40;
  const h = bottom - top;
  const px = (i: number) => (i / (points.length - 1)) * end;
  const py = (v: number) => bottom - ((v - lo) / (hi - lo)) * h;
  const width = Math.max(5, h / 58);
  if (threshold != null) {
    ctx.save();
    ctx.strokeStyle = rgba(c.muted, 0.6);
    ctx.lineWidth = width * 0.4;
    ctx.setLineDash([width * 2, width * 1.6]);
    ctx.beginPath();
    ctx.moveTo(0, py(threshold));
    ctx.lineTo(W, py(threshold));
    ctx.stroke();
    ctx.restore();
  }
  const path = () => {
    ctx.beginPath();
    points.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  };
  path();
  ctx.lineTo(end, bottom + h);
  ctx.lineTo(0, bottom + h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, top, 0, bottom + h * 0.2);
  g.addColorStop(0, rgba(color, 0.28));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fill();
  path();
  ctx.strokeStyle = rgba(color);
  ctx.lineWidth = width;
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.stroke();
  const x = end;
  const y = py(points.at(-1) ?? 0);
  ctx.beginPath();
  ctx.arc(x, y, width * 4.4, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 0.2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, width * 2, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color);
  ctx.fill();
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean): void {
  const { look, seal } = crownOf(d);
  const moved = change(d.points);
  const hasLine = d.points.length > 1;
  ground(ctx, W, H, moved?.color ?? null);
  const stats: [string, string | number][] = [
    ["Rated rounds", d.rounds ?? "–"],
    ["Rounds won", d.winRate ?? "–"],
    ["Peak", d.peak ?? "–"],
    ["Best streak", d.bestStreak ?? "–"],
  ];
  const rating = d.rating ?? "–";
  if (!tall) {
    const pad = 64;
    if (hasLine) climb(ctx, d.points, 350, H, W - pad, W, d.tier?.threshold ?? null);
    header(ctx, pad, 74, 22, d.region);
    if (seal) caps(ctx, seal, pad, 122, 18, look?.seal ?? c.fg);
    text(ctx, d.name, pad, 226, { size: 112, weight: 800, narrow: true, max: W - pad * 2 - 380, fill: look?.name });
    let x = pad;
    if (d.tier) {
      chip(ctx, d.tier, pad, 252, 22);
      font(ctx, 22, 650, true);
      x += ctx.measureText(d.tier.label).width + 22 * 1.1 + 16;
    }
    text(ctx, rankLine(d), x, 280, { size: 30, weight: 600, narrow: true, color: c.soft });
    caps(ctx, "Rating", W - pad, 92, 20, c.muted, "right");
    text(ctx, rating, W - pad, 216, { size: 150, weight: 700, narrow: true, align: "right", color: look?.light ?? c.fg });
    if (moved) text(ctx, moved.label, W - pad, 262, { size: 32, weight: 700, narrow: true, align: "right", color: moved.color });
    footer(ctx, W, 304, 22, "right", W - pad);
    if (!hasLine) figures(ctx, stats, pad, 480, W - pad * 2, 60);
    return;
  }
  const pad = 80;
  if (hasLine) climb(ctx, d.points, 1080, H, W - pad, W, d.tier?.threshold ?? null);
  header(ctx, pad, 150, 34, d.region);
  if (seal) caps(ctx, seal, pad, 270, 28, look?.seal ?? c.fg);
  text(ctx, d.name, pad, 440, { size: 190, weight: 800, narrow: true, max: W - pad * 2, fill: look?.name });
  if (d.tier) chip(ctx, d.tier, pad, 486, 40);
  text(ctx, rankLine(d), d.tier ? W - pad : pad, d.tier ? 534 : 540, { size: 48, weight: 600, narrow: true, color: c.soft, align: d.tier ? "right" : "left" });
  caps(ctx, "Rating", pad, 680, 32, c.muted);
  text(ctx, rating, pad, 920, { size: 280, weight: 700, narrow: true, color: look?.light ?? c.fg });
  if (moved) {
    const w = text(ctx, moved.label, pad, 1000, { size: 56, weight: 700, narrow: true, color: moved.color });
    text(ctx, `last ${d.points.length} matches`, pad + w + 24, 1000, { size: 40, weight: 500, narrow: true, color: c.muted });
  }
  footer(ctx, W, 920, 30, "right", W - pad);
  if (!hasLine) {
    figures(ctx, stats.slice(0, 2), pad + 40, 1300, W - pad * 2 - 40, 84);
    figures(ctx, stats.slice(2), pad + 40, 1460, W - pad * 2 - 40, 84);
  }
}

/** Each player's rating change as a bar up or down from a middle line, the name under it. */
function swings(ctx: CanvasRenderingContext2D, d: MatchCard, x: number, top: number, w: number, h: number, size: number, count: number): void {
  const rows = d.rows.slice(0, count);
  const deltas = rows.map((p) => rowDelta(p) ?? 0);
  const up = Math.max(0, ...deltas);
  const down = Math.max(0, ...deltas.map((v) => -v));
  // The middle line sits where the tallest gain and the deepest loss both fit, so the bars use the whole height.
  const room = size * 1.4;
  const most = Math.max(1, up + down);
  const reach = h - room * 2;
  const mid = top + room + (up + down ? (up / most) * reach : reach / 2);
  const cell = w / rows.length;
  ctx.fillStyle = rgba(c.border);
  ctx.fillRect(x, mid - 1, w, 2);
  rows.forEach((p, i) => {
    const cx = x + cell * (i + 0.5);
    const delta = rowDelta(p);
    const bw = Math.min(cell * 0.5, size * 2.6);
    if (delta) {
      const len = Math.max(4, (Math.abs(delta) / most) * reach);
      const color = delta > 0 ? c.up : c.down;
      const y0 = delta > 0 ? mid - len : mid;
      const g = ctx.createLinearGradient(0, delta > 0 ? y0 : y0 + len, 0, mid);
      g.addColorStop(0, rgba(color, 0.9));
      g.addColorStop(1, rgba(color, 0.25));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(cx - bw / 2, y0, bw, len, delta > 0 ? [6, 6, 0, 0] : [0, 0, 6, 6]);
      ctx.fill();
      text(ctx, `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}`, cx, delta > 0 ? y0 - size * 0.4 : y0 + len + size * 1.1, { size, weight: 700, narrow: true, align: "center", color });
    } else text(ctx, "–", cx, mid - size * 0.4, { size, weight: 700, narrow: true, align: "center", color: c.muted });
    text(ctx, p.name, cx, top + h + size * 1.3, { size: size * 0.9, weight: p.place === 1 ? 700 : 500, narrow: true, align: "center", color: p.place === 1 ? c.fg : c.soft, max: cell - 8, shrink: 0.6 });
  });
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean): void {
  ground(ctx, W, H, d.tourney ? c.gold : null);
  const prize = d.tourney ? c.gold : c.up;
  const winner = d.winners.join(" & ");
  const label = d.winners.length > 1 ? "Shared win" : "Winner";
  const facts = [d.date, d.map, d.rounds, d.playerCount].filter(Boolean).join("  ·  ");
  const nameFill = [c.fg, d.tourney ? c.gold : c["god-cream"]];
  if (!tall) {
    const pad = 64;
    header(ctx, pad, 74, 22, d.region);
    if (winner) {
      caps(ctx, label, pad, 132, 20, prize);
      text(ctx, winner, pad, 222, { size: 92, weight: 800, narrow: true, max: 640, fill: nameFill });
    }
    caps(ctx, `Match #${d.id}`, W - pad, 92, 20, c.muted, "right");
    text(ctx, d.tourney ?? facts, W - pad, 140, { size: 26, weight: 500, narrow: true, color: c.soft, align: "right", max: 420 });
    if (d.tourney) text(ctx, facts, W - pad, 178, { size: 22, weight: 500, narrow: true, color: c.muted, align: "right", max: 420 });
    caps(ctx, "Rating change", pad, 290, 18, c.muted);
    swings(ctx, d, pad, 300, W - pad * 2, 250, 26, 8);
    footer(ctx, W, 222, 22, "right", W - pad);
    return;
  }
  const pad = 80;
  header(ctx, pad, 150, 34, d.region);
  caps(ctx, `Match #${d.id}`, pad, 290, 30, c.muted);
  if (d.tourney) text(ctx, d.tourney, pad, 346, { size: 40, weight: 600, narrow: true, max: W - pad * 2 });
  text(ctx, facts, pad, d.tourney ? 400 : 346, { size: 36, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 });
  if (winner) {
    caps(ctx, label, pad, 560, 32, prize);
    text(ctx, winner, pad, 740, { size: 170, weight: 800, narrow: true, max: W - pad * 2, fill: nameFill });
    text(ctx, d.winnerLine, pad, 820, { size: 44, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 });
  }
  caps(ctx, "Rating change", pad, 1000, 28, c.muted);
  swings(ctx, d, pad, 1030, W - pad * 2, 640, 40, 6);
  footer(ctx, W, 1860, 30, "left", pad);
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean): void {
  ground(ctx, W, H, null);
  const strokes: Pick<Series, "color" | "dash">[] = [{ color: c.fg }, { color: c.soft, dash: "dashed" }, { color: c.muted, dash: "dotted" }];
  const stroke = (i: number) => strokes[i] ?? { color: c.muted };
  const n = Math.max(1, d.players.length);
  const pad = tall ? 80 : 64;
  const series = d.players.flatMap((p, i) => (p.points.length > 1 ? [{ points: p.points, ...stroke(i) }] : []));
  const key = (i: number, x: number, y: number, w: number, s: number) => {
    const { color, dash } = stroke(i);
    ctx.save();
    ctx.strokeStyle = rgba(color);
    ctx.lineWidth = 7 * s;
    ctx.lineCap = dash === "dotted" ? "round" : "butt";
    ctx.setLineDash(dash === "dashed" ? [28 * s, 18 * s] : dash === "dotted" ? [0, 16 * s] : []);
    ctx.beginPath();
    ctx.moveTo(x + (dash === "dotted" ? 4 * s : 0), y);
    ctx.lineTo(x + w, y);
    ctx.stroke();
    ctx.restore();
  };
  if (!tall) {
    header(ctx, pad, 74, 22, d.region);
    footer(ctx, W, 74, 22, "right", W - pad);
    const gap = 40;
    const colW = (W - pad * 2 - gap * (n - 1)) / n;
    d.players.forEach((p, i) => {
      const x = pad + i * (colW + gap);
      key(i, x, 140, Math.min(colW, 160), 1);
      text(ctx, p.name, x, 214, { size: 60, weight: 800, narrow: true, max: colW });
      const w = text(ctx, p.rating ?? "–", x, 276, { size: 50, weight: 700, narrow: true, color: p.rating ? c.fg : c["control-border"] });
      if (p.tier) chip(ctx, p.tier, x + w + 16, 248, 18);
    });
    lines(ctx, series, pad, 330, W - pad * 2, 250, series.length === 1);
    return;
  }
  header(ctx, pad, 150, 34, d.region);
  d.players.forEach((p, i) => {
    const y = 300 + i * 200;
    key(i, pad, y, 120, 1.4);
    text(ctx, p.name, pad + 160, y + 26, { size: 84, weight: 800, narrow: true, max: W - pad * 2 - 460 });
    text(ctx, p.rating ?? "–", W - pad, y + 26, { size: 84, weight: 700, narrow: true, align: "right", color: p.rating ? c.fg : c["control-border"] });
    if (p.tier) chip(ctx, p.tier, pad + 160, y + 52, 26);
  });
  if (series.length) {
    caps(ctx, "Rating over time", pad, 300 + n * 200 + 40, 28, c.muted);
    lines(ctx, series, pad, 300 + n * 200 + 100, W - pad * 2, 1760 - (300 + n * 200 + 100), series.length === 1);
  }
  footer(ctx, W, 1860, 30, "left", pad);
}
