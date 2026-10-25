// Sheet: a printed scoresheet. Plain type and thin rules, no glow and no chart: the name huge, the
// figures in ruled cells, recent form along the bottom.
import { c, caps, chip, crownOf, font, form, header, rankLine, rgba, rowDelta, text } from "./kit";
import type { ComparedPlayer, CompareCard, MatchCard, PlayerCard } from "./types";

function ground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, W, H);
}

const rule = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, color = c.border) => {
  ctx.fillStyle = rgba(color);
  ctx.fillRect(x, y, w, 1.5);
};
const upright = (ctx: CanvasRenderingContext2D, x: number, y: number, h: number) => {
  ctx.fillStyle = rgba(c.border);
  ctx.fillRect(x, y, 1.5, h);
};

/** The top line: the brand on the left, the site (or `right`) on the right, a rule under. */
function top(ctx: CanvasRenderingContext2D, W: number, pad: number, y: number, size: number, region: string, right = "genjiball.us"): void {
  header(ctx, pad, y, size, region);
  caps(ctx, right, W - pad, y, size * 0.85, c.muted, "right");
  rule(ctx, pad, y + size * 1.1, W - pad * 2);
}

/** The name with the tier chip after it on the same line. */
function title(ctx: CanvasRenderingContext2D, d: PlayerCard, x: number, y: number, size: number, max: number, chipSize: number): void {
  const { look } = crownOf(d);
  font(ctx, chipSize, 650, true);
  const chipW = d.tier ? ctx.measureText(d.tier.label).width + chipSize * 1.1 + chipSize : 0;
  const w = text(ctx, d.name, x, y, { size, weight: 800, narrow: true, max: max - chipW, fill: look?.name });
  if (d.tier) chip(ctx, d.tier, x + w + chipSize, y - chipSize * 2.3, chipSize);
}

/** Cells in a row between two rules, an upright between each; the first one bigger. */
function cells(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, y: number, w: number, h: number, size: number): void {
  const weights = list.map((_, i) => (i ? 1 : 1.5));
  const total = weights.reduce((a, b) => a + b, 0);
  rule(ctx, x, y, w);
  rule(ctx, x, y + h, w);
  let left = x;
  list.forEach(([label, value], i) => {
    const cw = (w * (weights[i] ?? 1)) / total;
    const inset = i ? size * 0.4 : 0;
    if (i) upright(ctx, left, y, h);
    caps(ctx, label, left + inset, y + size * 0.62, size * 0.32, c.muted);
    text(ctx, value, left + inset, y + h - size * 0.3, { size: i ? size : size * 1.3, weight: 700, narrow: true, max: cw - inset - size * 0.3 });
    left += cw;
  });
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean): void {
  const { look, seal } = crownOf(d);
  ground(ctx, W, H);
  const won = d.form.filter((place) => place === 1).length;
  if (!tall) {
    const pad = 64;
    top(ctx, W, pad, 74, 22, d.region);
    if (seal) caps(ctx, seal, pad, 140, 18, look?.seal ?? c.fg);
    title(ctx, d, pad, seal ? 270 : 258, 150, W - pad * 2, 22);
    cells(
      ctx,
      [
        ["Rating", d.rating ?? "–"],
        ["Rank", d.rank ? `#${d.rank}` : "–"],
        ["Rounds won", d.winRate ?? "–"],
        ["Peak", d.peak ?? "–"],
        ["Best streak", d.bestStreak ?? "–"],
      ],
      pad,
      316,
      W - pad * 2,
      150,
      64,
    );
    if (d.form.length) {
      const n = Math.min(d.form.length, 20);
      caps(ctx, `Last ${n} rounds · ${won} won`, pad, 580, 18, c.muted);
      form(ctx, d.form.slice(-n), W - pad - n * 30 * 1.18 + 30 * 0.18, 557, 30);
    } else caps(ctx, rankLine(d), pad, 580, 18, c.muted);
    return;
  }
  const pad = 80;
  top(ctx, W, pad, 150, 34, d.region);
  if (seal) caps(ctx, seal, pad, 300, 28, look?.seal ?? c.fg);
  title(ctx, d, pad, 470, 190, W - pad * 2, 32);
  text(ctx, rankLine(d), pad, 550, { size: 48, weight: 600, narrow: true, color: c.soft });
  const list: [string, string | number][] = [
    ["Rating", d.rating ?? "–"],
    ["Rank", d.rank ? `#${d.rank}` : "–"],
    ["Rated rounds", d.rounds ?? "–"],
    ["Rounds won", d.winRate ?? "–"],
    ["Peak", d.peak ?? "–"],
    ["Best streak", d.bestStreak ?? "–"],
  ];
  // One ruled row each: the label left, the figure right.
  list.forEach(([label, value], i) => {
    const y = 660 + i * 150;
    rule(ctx, pad, y, W - pad * 2);
    caps(ctx, label, pad, y + 92, 30, c.muted);
    text(ctx, value, W - pad, y + 112, { size: i ? 96 : 130, weight: 700, narrow: true, align: "right", color: look && !i ? look.light : c.fg });
  });
  rule(ctx, pad, 660 + list.length * 150, W - pad * 2);
  if (d.form.length) {
    const n = Math.min(d.form.length, 20);
    caps(ctx, `Last ${n} rounds · ${won} won`, pad, 1650, 28, c.muted);
    const row = d.form.slice(-n);
    form(ctx, row.slice(0, 10), pad, 1690, 78);
    if (row.length > 10) form(ctx, row.slice(10), pad, 1784, 78);
  }
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean): void {
  ground(ctx, W, H);
  const prize = d.tourney ? c.gold : c.up;
  const winner = d.winners.join(" & ");
  const facts = [d.date, d.map, d.rounds, d.playerCount].filter(Boolean).join("  ·  ");
  const pad = tall ? 80 : 64;
  const s = tall ? 1.5 : 1;
  top(ctx, W, pad, tall ? 150 : 74, 22 * s, d.region, `Match #${d.id}`);
  const head = tall ? 300 : 140;
  caps(ctx, d.winners.length > 1 ? "Shared win" : "Winner", pad, head, 18 * s, prize);
  if (winner) text(ctx, winner, pad, head + 76 * s, { size: 76 * s, weight: 800, narrow: true, max: tall ? W - pad * 2 : 560, fill: [c.fg, d.tourney ? c.gold : c["god-cream"]] });
  const where = d.tourney ? `${d.tourney}  ·  ${facts}` : facts;
  if (tall) text(ctx, where, pad, head + 150 * s, { size: 36, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 });
  else text(ctx, where, W - pad, head + 76, { size: 24, weight: 500, narrow: true, color: c.soft, align: "right", max: 500 });
  // The table: place, name, rounds won, kills, rating, change.
  const tableTop = tall ? 640 : 262;
  const rowH = tall ? 104 : 54;
  const max = tall ? 10 : d.rows.length > 6 ? 5 : 6;
  const size = tall ? 44 : 28;
  const w = W - pad * 2;
  const cols = { place: pad + size * 0.6, name: pad + size * 1.8, won: pad + w * 0.56, kills: pad + w * 0.68, rating: pad + w * 0.82, change: W - pad };
  caps(ctx, "#", cols.place, tableTop + size * 0.2, size * 0.5, c.muted, "center");
  caps(ctx, "Player", cols.name, tableTop + size * 0.2, size * 0.5, c.muted);
  caps(ctx, "Won", cols.won, tableTop + size * 0.2, size * 0.5, c.muted, "right");
  caps(ctx, "Kills", cols.kills, tableTop + size * 0.2, size * 0.5, c.muted, "right");
  caps(ctx, "Rating", cols.rating, tableTop + size * 0.2, size * 0.5, c.muted, "right");
  caps(ctx, "Change", cols.change, tableTop + size * 0.2, size * 0.5, c.muted, "right");
  const rows = d.rows.slice(0, max);
  rows.forEach((p, i) => {
    const y = tableTop + size * 0.6 + i * rowH;
    rule(ctx, pad, y, w, i ? c.line : c.border);
    const base = y + rowH * 0.7;
    const first = p.place === 1;
    text(ctx, p.place, cols.place, base, { size, weight: 700, narrow: true, align: "center", color: first ? prize : c.muted });
    text(ctx, p.name, cols.name, base, { size, weight: first ? 700 : 600, narrow: true, max: cols.won - cols.name - size * 1.6, shrink: 0.7 });
    text(ctx, p.won, cols.won, base, { size, weight: 600, narrow: true, align: "right", color: c.soft });
    text(ctx, p.kills, cols.kills, base, { size, weight: 600, narrow: true, align: "right", color: c.soft });
    text(ctx, p.after ?? "–", cols.rating, base, { size, weight: 700, narrow: true, align: "right", color: p.after ? c.fg : c["control-border"] });
    const delta = rowDelta(p);
    text(ctx, delta ? `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}` : "–", cols.change, base, { size: size * 0.9, weight: 700, narrow: true, align: "right", color: delta ? (delta > 0 ? c.up : c.down) : c.muted });
  });
  const end = tableTop + size * 0.6 + rows.length * rowH;
  rule(ctx, pad, end, w);
  if (d.rows.length > max) caps(ctx, `+ ${d.rows.length - max} more`, pad, end + size * 1.1, size * 0.5, c.muted);
  if (tall) caps(ctx, "genjiball.us", pad, 1860, 30, c.muted);
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean): void {
  ground(ctx, W, H);
  const pad = tall ? 80 : 64;
  const s = tall ? 1.5 : 1;
  top(ctx, W, pad, tall ? 150 : 74, 22 * s, d.region, d.players.length === 2 ? "Head to head" : "Compare");
  const n = Math.max(1, d.players.length);
  const labelW = tall ? (n > 2 ? 200 : 260) : 300;
  const colW = (W - pad * 2 - labelW) / n;
  const head = tall ? 330 : 170;
  d.players.forEach((p, i) => {
    const x = pad + labelW + i * colW;
    text(ctx, p.name, x + colW - 8, head, { size: (n > 2 ? 44 : 54) * s, weight: 800, narrow: true, align: "right", max: colW - 16 });
    if (p.tier) chip(ctx, p.tier, x + colW - 8, head + 16 * s, 18 * s, "right");
  });
  const rows: [string, (p: ComparedPlayer) => string, (p: ComparedPlayer) => number | null, 1 | -1][] = [
    ["Rating", (p) => String(p.rating ?? "–"), (p) => p.rating, 1],
    ["Rank", (p) => (p.rank ? `#${p.rank}` : "–"), (p) => p.rank, -1],
    ["Rounds won", (p) => p.winRate ?? "–", (p) => p.winShare, 1],
    ["Kills a round", (p) => p.killsPerRound?.toFixed(2) ?? "–", (p) => p.killsPerRound, 1],
    ["Peak", (p) => String(p.peak ?? "–"), (p) => p.peak, 1],
  ];
  const tableTop = head + 70 * s;
  const rowH = tall ? 190 : 70;
  rows.forEach(([label, show, value, better], j) => {
    const y = tableTop + j * rowH;
    rule(ctx, pad, y, W - pad * 2, j ? c.line : c.border);
    caps(ctx, label, pad, y + rowH * 0.62, 18 * s, c.muted);
    const known = d.players.map(value).filter((v): v is number => v != null);
    d.players.forEach((p, i) => {
      const mine = value(p);
      const best = n > 1 && known.length > 1 && mine != null && mine === (better > 0 ? Math.max(...known) : Math.min(...known));
      const x = pad + labelW + (i + 1) * colW - 8;
      text(ctx, show(p), x, y + rowH * 0.72, { size: (j ? 40 : 52) * s, weight: best ? 800 : 600, narrow: true, align: "right", color: best ? c.fg : c.muted });
    });
  });
  rule(ctx, pad, tableTop + rows.length * rowH, W - pad * 2);
  if (tall) caps(ctx, "genjiball.us", pad, 1860, 30, c.muted);
}
