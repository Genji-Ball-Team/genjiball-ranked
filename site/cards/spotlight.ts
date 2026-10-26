// Spotlight: everything centred under one light from above. A player stands in it; a match is a
// podium; a head to head is a fight card, the two names either side of "VS". Only the picked parts
// are drawn, stacked down the middle (kit.ts, `stack`).
import {
  block,
  c,
  caps,
  change,
  chartBlock,
  chip,
  chipBlock,
  compareRows,
  crownOf,
  cup,
  deltaLabel,
  fitTable,
  font,
  footer,
  formBlock,
  header,
  inlineSize,
  label,
  leads,
  line,
  matchFacts,
  matchId,
  playerSeries,
  playerStats,
  rankLine,
  rgba,
  rowDelta,
  stack,
  text,
  type Block,
  type Rgb,
  type Series,
} from "./kit";
import type { ComparePart, MatchPart, PlayerPart, Show } from "./parts";
import type { CompareCard, MatchCard, MatchRow, PlayerCard } from "./types";

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

function measure(ctx: CanvasRenderingContext2D, s: string, size: number, weight: number, spacing = 0): number {
  font(ctx, size, weight, true);
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
  const w = ctx.measureText(s).width;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  return w;
}

/** Labelled figures centred on `x`, `gap` apart. */
function row(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, y: number, size: number, gap: number): void {
  const widths = list.map(([l, value]) => Math.max(measure(ctx, String(value), size, 700), measure(ctx, l.toUpperCase(), size * 0.36, 700, size * 0.36 * 0.16)));
  const total = widths.reduce((a, b) => a + b, 0) + gap * (list.length - 1);
  let left = x - total / 2;
  list.forEach(([l, value], i) => {
    const w = widths[i] ?? 0;
    caps(ctx, l, left + w / 2, y - size * 1.02, size * 0.36, c.muted, "center");
    text(ctx, value, left + w / 2, y, { size, weight: 700, narrow: true, align: "center" });
    left += w + gap;
  });
}

/** `row` as a block, sized to fit `width`. */
function rowBlock(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, width: number, size: number, gapX: number, gap = 0): Block | null {
  if (!list.length) return null;
  const s = inlineSize(ctx, list, width, size, gapX);
  const fit = s / size;
  return block(s * 1.3, gap, (top, k) => row(ctx, list, x, top + s * k * 1.3, s * k, gapX * fit * k));
}

interface Bit {
  s: string;
  color: Rgb;
  weight: number;
}

/** Short texts on one line, centred on `x`: the rank, then the change. */
function bits(ctx: CanvasRenderingContext2D, list: (Bit | false | null | "")[], x: number, size: number, gap = 0): Block | null {
  const shown = list.filter((b): b is Bit => Boolean(b));
  if (!shown.length) return null;
  return block(size * 0.72, gap, (top, k) => {
    const z = size * k;
    const space = z * 0.8;
    const widths = shown.map((b) => measure(ctx, b.s, z, b.weight));
    let left = x - (widths.reduce((a, b) => a + b, 0) + space * (shown.length - 1)) / 2;
    shown.forEach((b, i) => {
      text(ctx, b.s, left, top + z * 0.72, { size: z, weight: b.weight, narrow: true, color: b.color });
      left += (widths[i] ?? 0) + space;
    });
  });
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean, on: Show<PlayerPart>): void {
  const crown = crownOf(d);
  const look = on.has("title") ? crown.look : null;
  const seal = look ? crown.seal : null;
  const tier = on.has("tier") ? d.tier : null;
  ground(ctx, W, H, look?.glow ?? tier?.color ?? null);
  const moved = on.has("change") ? change(d.points) : null;
  const stats = playerStats(d, on);
  const series = on.has("chart") ? playerSeries(d) : [];
  const results = on.has("form") ? d.form : [];
  // The big number: the rating, or the rank when the rating is off.
  const big = on.has("rating") ? String(d.rating ?? "–") : on.has("rank") && d.rank ? `#${d.rank}` : "";
  const rank = on.has("rank") && (on.has("rating") || !d.rank) ? rankLine(d) : "";
  const cx = W / 2;
  const name = (size: number, gap: number) => line(ctx, d.name, cx, { size, weight: 800, narrow: true, align: "center", max: W - 160, fill: look?.name }, gap, 0.2);
  const bigLine = (size: number, gap: number) => big && line(ctx, big, cx, { size, weight: 700, narrow: true, align: "center", color: look?.light ?? c.fg }, gap, 0.15);
  if (!tall) {
    header(ctx, cx, 70, 20, d.region, "center");
    // With the line, the form and figures all on, everything is a little smaller and the line and
    // the form share a row.
    const busy = series.length > 0 && results.length > 0;
    const both = series.length > 0 && stats.length > 0 ? 0.8 : 1;
    const lineAndForm =
      busy &&
      block(80, 40, (top, k) => {
        const size = 30 * k;
        const shown = results.slice(-10);
        const formW = shown.length * size * 1.18 - size * 0.18;
        const chartW = Math.min(560, W - 240 - formW - 50);
        const left = cx - (chartW + 50 + formW) / 2;
        chartBlock(ctx, series, left, chartW, 80 * k, 0, 0)?.draw(top, 1);
        formBlock(ctx, shown, left + chartW + 50, formW, 30 * k, "left", 0, 10)?.draw(top + 50 * k - size / 2, 1);
      });
    stack(
      [
        seal && look && label(ctx, seal, cx, 18, look.seal, "center"),
        name(120 * both, 30),
        tier && chipBlock(ctx, tier, cx, 22, "center", 24),
        bigLine(150 * both, 44),
        bits(ctx, [rank && { s: rank, color: c.soft, weight: 600 }, moved && { s: moved.label, color: moved.color, weight: 700 }], cx, 30, big ? 30 : 28),
        rowBlock(ctx, stats, cx, W - 240, 40, 72, 64),
        lineAndForm || chartBlock(ctx, series, cx - 340, 680, 90, 40),
        !busy && formBlock(ctx, results, cx, W - 320, 36, "center", 36, 16),
      ],
      104,
      570,
      "center",
      1.8,
    );
    footer(ctx, W, 600, 18, "right", W - 48);
    return;
  }
  header(ctx, cx, 150, 34, d.region, "center");
  stack(
    [
      seal && look && label(ctx, seal, cx, 28, look.seal, "center"),
      name(200, 50),
      tier && chipBlock(ctx, tier, cx, 42, "center", 44),
      big && label(ctx, on.has("rating") ? "Rating" : "Rank", cx, 32, c.muted, "center", 150),
      bigLine(320, 70),
      rank && line(ctx, rank, cx, { size: 52, weight: 600, narrow: true, color: c.soft, align: "center" }, big ? 70 : 60),
      moved && line(ctx, `${moved.label}  last ${d.points.length} matches`, cx, { size: 42, weight: 700, narrow: true, color: moved.color, align: "center" }, 40),
      rowBlock(ctx, stats, cx, W - 160, 84, 90, 150),
      chartBlock(ctx, series, 140, W - 280, 280, 120),
      formBlock(ctx, results, cx, W - 240, 72, "center", 110, 10),
    ],
    230,
    1790,
    "center",
    1.8,
  );
  footer(ctx, W, 1860, 30, "center");
}

/**
 * The podium: the top three on steps, first in the middle, each name over its step with the picked
 * figures under it. As tall as fits between `top` and `floor`, up to `most`.
 */
function podium(ctx: CanvasRenderingContext2D, d: MatchCard, on: Show<MatchPart>, cx: number, top: number, floor: number, stepW: number, size: number, most: number, prize: Rgb): void {
  const crowned = on.has("winner");
  const changes = on.has("changes");
  const extras = (p: MatchRow) =>
    [on.has("ratings") && String(p.after ?? "–"), on.has("won") && `${p.won} won`, on.has("kills") && `${p.kills} kills`].filter(Boolean).join("  ·  ");
  const steps = d.rows.slice(0, 3);
  const anyExtras = steps.some((p) => extras(p));
  const above = size * (0.45 + (anyExtras ? 0.95 : 0) + (changes ? 1.05 : 0) + (crowned ? 2.3 : 0.8));
  const tallest = Math.max(size * 4.5, Math.min(most, floor - top - above));
  const heights = [1, 0.72, 0.52].map((f) => tallest * f);
  // Left to right: second, first, third.
  const gap = stepW * 0.06;
  [1, 0, 2].forEach((rank, slot) => {
    const p = steps[rank];
    if (!p) return;
    const h = heights[rank] ?? 0;
    const x = cx + (slot - 1) * (stepW + gap) - stepW / 2;
    const y = floor - h;
    const first = p.place === 1 && crowned;
    const g = ctx.createLinearGradient(0, y, 0, floor);
    g.addColorStop(0, rgba(first ? prize : c.raised, first ? 0.32 : 1));
    g.addColorStop(1, rgba(first ? prize : c.raised, first ? 0.04 : 0.2));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x, y, stepW, h, [10, 10, 0, 0]);
    ctx.fill();
    ctx.fillStyle = rgba(first ? prize : c.border);
    ctx.fillRect(x, y, stepW, 3);
    const mid = x + stepW / 2;
    text(ctx, p.place, mid, y + size * 2.1, { size: size * 1.9, weight: 800, narrow: true, align: "center", color: first ? prize : c.soft });
    // From the step up: the figures, the change, the name, the cup.
    let at = y - size * 0.45;
    const more = extras(p);
    if (more) text(ctx, more, mid, at, { size: size * 0.6, weight: 600, narrow: true, align: "center", color: c.soft, max: stepW + gap });
    if (anyExtras) at -= size * 0.95;
    const delta = rowDelta(p);
    if (changes) text(ctx, deltaLabel(delta) ?? "–", mid, at, { size: size * 0.75, weight: 700, narrow: true, align: "center", color: delta ? (delta > 0 ? c.up : c.down) : c.muted });
    if (changes) at -= size * 1.05;
    text(ctx, p.name, mid, at, { size, weight: 800, narrow: true, align: "center", max: stepW + gap, shrink: 0.6, fill: first ? [c.fg, prize === c.gold ? c.gold : c["god-cream"]] : undefined });
    if (first && slot === 1) cup(ctx, mid - size * 0.6, at - size * 2.3, size * 1.2, prize);
  });
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean, on: Show<MatchPart>): void {
  const prize = d.tourney && on.has("tourney") ? c.gold : c.up;
  ground(ctx, W, H, prize === c.gold ? c.gold : null);
  const cx = W / 2;
  const winner = on.has("winner") ? d.winners.join(" & ") : "";
  const winnerLine = winner && on.has("winnerLine") ? d.winnerLine : "";
  const id = matchId(d, on);
  const facts = matchFacts(d, on);
  const podiumOn = on.has("standings") && d.rows.length > 0;
  const nameFill: Rgb[] = [c.fg, prize === c.gold ? c.gold : c["god-cream"]];
  const max = W - 160;
  const soft = (s: string, size: number, gap: number) => line(ctx, s, cx, { size, weight: 500, narrow: true, color: c.soft, align: "center", max }, gap);
  // Over the podium: the match, and the winner's rounds (the name is on the top step).
  const above = (size: number, idGap: number) => [
    id && label(ctx, id, cx, size * 0.75, c.muted, "center"),
    facts && soft(facts, size, id ? idGap : 0),
    winnerLine && soft(`${d.winners[0] ?? ""}  ·  ${winnerLine}`, size * 1.15, size * 1.2),
  ];
  // Without the podium the winner takes the light.
  const alone = (cupSize: number, labelSize: number, nameSize: number, lineSize: number, s: number) => [
    winner && block(cupSize, 0, (top, k) => cup(ctx, cx - (cupSize * k) / 2, top, cupSize * k, prize)),
    winner && label(ctx, d.winners.length > 1 ? "Shared win" : "Winner", cx, labelSize, prize, "center", 30 * s),
    winner && line(ctx, winner, cx, { size: nameSize, weight: 800, narrow: true, align: "center", max, fill: nameFill }, 30 * s, 0.2),
    winnerLine && soft(winnerLine, lineSize, 30 * s),
    id && label(ctx, id, cx, labelSize * 0.9, c.muted, "center", winner ? 80 * s : 0),
    facts && soft(facts, lineSize * 0.8, id ? 20 * s : winner ? 80 * s : 0),
  ];
  if (!tall) {
    header(ctx, cx, 64, 20, d.region, "center");
    if (podiumOn) {
      const end = stack(above(24, 18), 100, 260, "start");
      podium(ctx, d, on, cx, end + 30, H, 280, 40, 250, prize);
    } else stack(alone(64, 20, 120, 30, 1), 100, 570, "center", 1.6);
    footer(ctx, W, 600, 18, "right", W - 48);
    return;
  }
  header(ctx, cx, 150, 34, d.region, "center");
  if (podiumOn) {
    // The rest below the podium.
    const rest = fitTable(ctx, { ...d, rows: d.rows.slice(3) }, on, { x: 140, w: W - 280, size: 44, prize, look: "rules" }, 520);
    let floor = 1760;
    if (rest) {
      floor = 1780 - rest.h - 90;
      stack([rest], floor + 90, 1780, "start");
    }
    const end = stack(above(38, 30), 240, 600, "start");
    podium(ctx, d, on, cx, end + 80, floor, 310, 60, 760, prize);
  } else stack(alone(130, 34, 180, 46, 1.6), 240, 1790, "center", 1.6);
  footer(ctx, W, 1860, 30, "center");
}

/** How the compared players' lines differ, as on the site's compare chart. */
const strokes = (): Pick<Series, "color" | "dash">[] => [{ color: c.fg }, { color: c.soft, dash: "dashed" }, { color: c.muted, dash: "dotted" }];

/** A short line in a player's stroke, under the name: which line is whose. */
function key(ctx: CanvasRenderingContext2D, stroke: Pick<Series, "color" | "dash">, x: number, y: number, w: number, width: number): void {
  ctx.save();
  ctx.strokeStyle = rgba(stroke.color);
  ctx.lineWidth = width;
  ctx.lineCap = stroke.dash === "dotted" ? "round" : "butt";
  ctx.setLineDash(stroke.dash === "dashed" ? [width * 4, width * 2.5] : stroke.dash === "dotted" ? [0, width * 2.5] : []);
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.lineTo(x + w / 2, y);
  ctx.stroke();
  ctx.restore();
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean, on: Show<ComparePart>): void {
  ground(ctx, W, H, null);
  const cx = W / 2;
  const s = tall ? 1.5 : 1;
  const n = Math.max(1, d.players.length);
  const stroke = strokes();
  const rows = compareRows(on);
  // Two players are a fight card: either side of "VS", each row's label between them. Otherwise
  // side by side in columns, the labels on the left.
  const fight = d.players.length === 2;
  const pad = tall ? 70 : 64;
  const side = tall ? 280 : 300;
  const labelW = fight || !rows.length ? 0 : tall ? 210 : 190;
  const colW = fight ? 2 * (side - 50 * s) : (W - pad * 2 - labelW) / n;
  const xs = d.players.map((_, i) => (fight ? cx + (i ? side : -side) : pad + labelW + colW * (i + 0.5)));
  const rating = on.has("rating");
  const tier = on.has("tier");
  const series = on.has("chart") ? d.players.flatMap((p, i) => (p.points.length > 1 ? [{ points: p.points, ...(stroke[i] ?? { color: c.muted }) }] : [])) : [];
  const alone = !rows.length && !rating;
  // Smaller with a line and several rows under them on a wide card.
  const busy = !tall && series.length > 0 && rows.length > 2 ? 0.85 : 1;
  const nameSize = (fight ? 84 : n > 1 ? 64 : 110) * s * (tall && !fight && n > 1 ? 0.8 : 1) * (alone ? (fight && tall ? 1.1 : 1.3) : busy);
  const chipSize = 20 * s;
  const keyH = series.length > 1 ? 30 * s : 0;
  header(ctx, cx, tall ? 150 : 64, tall ? 34 : 20, d.region, "center");
  const names = block(nameSize * 0.72 + (tier ? 18 * s + chipSize * 1.55 : 0) + keyH, 0, (t, k) => {
    const base = t + nameSize * k * 0.72;
    d.players.forEach((p, i) => {
      const x = xs[i] ?? cx;
      text(ctx, p.name, x, base, { size: nameSize * k, weight: 800, narrow: true, align: "center", max: colW - 24 });
      let y = base;
      if (tier) {
        if (p.tier) chip(ctx, p.tier, x, y + 18 * s * k, chipSize * k, "center");
        y += (18 * s + chipSize * 1.55) * k;
      }
      if (keyH) key(ctx, stroke[i] ?? { color: c.muted }, x, y + keyH * k * 0.6, Math.min(colW * 0.4, 90 * s), 4 * s);
    });
    if (fight) text(ctx, "VS", cx, base - 7 * s * k, { size: 64 * s * k, weight: 800, narrow: true, align: "center", color: c.muted });
  }, 0.15);
  const ratingSize = (fight ? 90 : tall && n > 2 ? 56 : 72) * s * busy;
  const ratings =
    rating &&
    block(ratingSize * 0.72, 44 * s, (t, k) =>
      d.players.forEach((p, i) =>
        text(ctx, p.rating ?? "–", xs[i] ?? cx, t + ratingSize * k * 0.72, { size: ratingSize * k, weight: 700, narrow: true, align: "center", color: p.rating ? c.fg : c["control-border"] }),
      ),
      0.15,
    );
  const rh = 48 * s;
  const valueSize = 32 * s;
  const table =
    rows.length > 0 &&
    block(
      rows.length * rh,
      (rating ? 40 : 50) * s,
      (t, k) =>
        rows.forEach((r, j) => {
          const y = t + (j * rh + rh * 0.5 + valueSize * 0.36) * k;
          caps(ctx, r[0], fight ? cx : pad, y - 2 * s * k, 15 * s * k, c.muted, fight ? "center" : "left");
          d.players.forEach((p, i) => {
            const best = leads(d.players, p, r);
            text(ctx, r[1](p), xs[i] ?? cx, y, { size: valueSize * k, weight: best ? 800 : 600, narrow: true, align: "center", color: best ? c.fg : c.muted });
          });
        }),
      0.5,
    );
  stack(
    [names, ratings, table, chartBlock(ctx, series, pad, W - pad * 2, tall ? 300 : 100, 50 * s, 1.2)],
    tall ? 240 : 100,
    tall ? 1790 : 570,
    "center",
    1.8,
  );
  footer(ctx, W, tall ? 1860 : 600, tall ? 30 : 18, tall ? "center" : "right", tall ? 0 : W - 48);
}
