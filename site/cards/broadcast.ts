// Broadcast: a TV graphic. A panel cut by the blade (the logo's slice), the tier as a bar down the
// edge, the rank huge and faint behind, the rating as the one big number. With nothing picked for
// the right of the blade, the panel takes most of the card.
import {
  blade,
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
  footer,
  formBlock,
  ghost,
  header,
  inlineBlock,
  label,
  leads,
  line,
  matchFacts,
  matchId,
  playerSeries,
  playerStats,
  rankLine,
  rgba,
  shape,
  stack,
  table,
  tableWidth,
  text,
  trend,
  type Block,
  type Rgb,
} from "./kit";
import type { ComparePart, MatchPart, PlayerPart, Show } from "./parts";
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

/** "▲ 120 last 14 matches", right-aligned on `x`, as a block. */
function changeBlock(ctx: CanvasRenderingContext2D, points: number[], x: number, size: number, gap: number): Block | null {
  const moved = change(points);
  if (!moved) return null;
  return block(size * 0.72, gap, (top, k) => {
    const y = top + size * k * 0.72;
    const noteW = text(ctx, `last ${points.length} matches`, x, y, { size: size * k * 0.8, weight: 500, narrow: true, color: c.muted, align: "right" });
    text(ctx, moved.label, x - noteW - size * k * 0.4, y, { size: size * k, weight: 700, narrow: true, color: moved.color, align: "right" });
  });
}

/**
 * The big figure right of the blade: the rating, or the rank when the rating isn't picked, with its
 * label over it. Then the rank line, the change and the rating line under it.
 */
function figureColumn(ctx: CanvasRenderingContext2D, d: PlayerCard, on: Show<PlayerPart>, x: number, w: number, s: number, light: Rgb | null): Block[] {
  const rating = on.has("rating");
  const rank = on.has("rank");
  const out: (Block | null)[] = [];
  if (rating) {
    out.push(label(ctx, "Rating", x, 20 * s, c.muted, "right"));
    out.push(line(ctx, d.rating ?? "–", x, { size: 200 * s, weight: 700, narrow: true, align: "right", color: light ?? c.fg, max: w }, 34 * s, 0.15));
    if (rank) out.push(line(ctx, rankLine(d), x, { size: 34 * s, weight: 600, narrow: true, color: c.soft, align: "right", max: w }, 34 * s));
  } else if (rank) {
    out.push(label(ctx, d.rank ? `Rank in ${d.region}` : "Rank", x, 20 * s, c.muted, "right"));
    out.push(line(ctx, d.rank ? `#${d.rank}` : rankLine(d), x, { size: (d.rank ? 200 : 60) * s, weight: 700, narrow: true, align: "right", color: light ?? c.fg, max: w }, 34 * s, 0.15));
  }
  if (on.has("change")) out.push(changeBlock(ctx, d.points, x, 30 * s, 28 * s));
  if (on.has("chart")) out.push(chartBlock(ctx, playerSeries(d), x - w, w, 110 * s, 40 * s, 1));
  return out.filter((b): b is Block => b != null);
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean, on: Show<PlayerPart>): void {
  const { look, seal } = on.has("title") ? crownOf(d) : { look: null, seal: null };
  const tier = on.has("tier") ? d.tier : null;
  const stats = playerStats(d, on);
  const ghostRank = on.has("rank") && d.rank ? `#${d.rank}` : null;
  if (!tall) {
    const pad = 64;
    const right = figureColumn(ctx, d, on, W - pad, 300, 1, look?.light ?? null);
    // Nothing on the right: the panel takes most of the card.
    const edge = right.length ? 650 : 900;
    const max = edge - pad - 50;
    panel(ctx, W, H, [[0, 0], [edge + 140, 0], [edge, H], [0, H]], [edge, H, edge + 140, 0], 4, () => ghostRank && ghost(ctx, ghostRank, W + 30, H + 110, 520));
    bar(ctx, H, look?.light ?? tier?.color, 12);
    header(ctx, pad, 74, 22, d.region);
    stack(
      [
        seal && label(ctx, seal, pad, 18, look?.seal ?? c.fg),
        line(ctx, d.name, pad, { size: 128, weight: 800, narrow: true, max, fill: look?.name }, 40, 0.25),
        tier && chipBlock(ctx, tier, pad, 22, "left", 30),
        inlineBlock(ctx, stats, pad, max, 56, 48, 70),
        on.has("form") && formBlock(ctx, d.form, pad, max, 36, "left", 40, 12),
      ],
      124,
      560,
      "center",
      1.8,
    );
    stack(right, 110, 548, "center", 1.6);
    footer(ctx, W, 592, 22, "right", W - pad);
    return;
  }
  const pad = 80;
  const right = figureColumn(ctx, d, on, W - pad, W - pad * 2, 1.55, look?.light ?? null);
  // The panel reaches lower when there's little under it.
  const low = right.length ? 0 : 420;
  panel(ctx, W, H, [[0, 0], [W, 0], [W, 1020 + low], [0, 1200 + low]], [0, 1200 + low, W, 1020 + low], 6, () => ghostRank && ghost(ctx, ghostRank, W + 40, H + 200, 900));
  bar(ctx, H, look?.light ?? tier?.color, 16);
  header(ctx, pad, 150, 34, d.region);
  stack(
    [
      seal && label(ctx, seal, pad, 28, look?.seal ?? c.fg),
      line(ctx, d.name, pad, { size: 200, weight: 800, narrow: true, max: W - pad * 2, fill: look?.name }, 60, 0.2),
      tier && chipBlock(ctx, tier, pad, 40, "left", 50),
      inlineBlock(ctx, stats, pad, W - pad * 2, 84, 64, 110),
      on.has("form") && formBlock(ctx, d.form, pad, W - pad * 2, 72, "left", 70, 10),
    ],
    240,
    1000 + low,
    "center",
    1.6,
  );
  stack(right, 1250, 1790, "center", 1.6);
  footer(ctx, W, 1860, 30, "left", pad);
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean, on: Show<MatchPart>): void {
  const prize = d.tourney && on.has("tourney") ? c.gold : c.up;
  const winner = on.has("winner") ? d.winners.join(" & ") : "";
  const label2 = d.winners.length > 1 ? "Shared win" : "Winner";
  const facts = matchFacts(d, on);
  const id = matchId(d, on);
  const nameFill = [c.fg, prize === c.gold ? c.gold : c["god-cream"]];
  const winnerLine = winner && on.has("winnerLine") ? d.winnerLine : "";
  /** The cup and "Winner" over the name. */
  const cupLine = (x: number, size: number, gap: number): Block =>
    block(size * 1.6, gap, (top, k) => {
      cup(ctx, x, top, size * 1.6 * k, prize);
      caps(ctx, label2, x + size * 2.3 * k, top + size * 1.25 * k, size * k, prize);
    });
  if (!tall) {
    const pad = 64;
    const standings = (x: number, w: number) => table(ctx, d, on, { x, w, size: 34, rowH: 66, max: 6, prize });
    const hasTable = Boolean(standings(0, 300));
    // The more columns, the further left the blade, down to half the card.
    const edge = hasTable ? Math.max(420, Math.min(650, W - pad - 182 - tableWidth(on, 30))) : 900;
    const max = edge - pad - 50;
    panel(ctx, W, H, [[0, 0], [edge + 140, 0], [edge, H], [0, H]], [edge, H, edge + 140, 0], 4);
    bar(ctx, H, prize, 12);
    header(ctx, pad, 74, 22, d.region);
    stack(
      [
        winner && cupLine(pad, 22, 0),
        winner && line(ctx, winner, pad, { size: 112, weight: 800, narrow: true, max, fill: nameFill }, 34, 0.25),
        winnerLine && line(ctx, winnerLine, pad, { size: 30, weight: 500, narrow: true, color: c.soft, max }, 30),
        id && label(ctx, id, pad, 20, c.muted, "left", 80),
        facts && line(ctx, facts, pad, { size: 26, weight: 500, narrow: true, color: c.soft, max }, id ? 20 : 80),
      ],
      124,
      560,
      "center",
      1.6,
    );
    stack([standings(edge + 182, W - edge - 182 - pad)], 110, 556, "center");
    footer(ctx, W, 592, 22, "right", W - pad);
    return;
  }
  const pad = 80;
  const standings = table(ctx, d, on, { x: pad, w: W - pad * 2, size: 50, rowH: 82, max: 7, prize });
  const low = standings ? 0 : 520;
  panel(ctx, W, H, [[0, 0], [W, 0], [W, 900 + low], [0, 1080 + low]], [0, 1080 + low, W, 900 + low], 6);
  bar(ctx, H, prize, 16);
  header(ctx, pad, 150, 34, d.region);
  stack(
    [
      id && label(ctx, id, pad, 30, c.muted),
      facts && line(ctx, facts, pad, { size: 38, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 }, 30),
      winner && cupLine(pad, 34, 110),
      winner && line(ctx, winner, pad, { size: 180, weight: 800, narrow: true, max: W - pad * 2, fill: nameFill }, 60, 0.2),
      winnerLine && line(ctx, winnerLine, pad, { size: 46, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 }, 50),
    ],
    250,
    880 + low,
    "center",
    1.6,
  );
  stack([standings], 1160, 1790, "center");
  footer(ctx, W, 1860, 30, "left", pad);
}

/** One player's side of a compare card, as blocks. `wide`: the rating beside the name, not under it. */
function side(ctx: CanvasRenderingContext2D, p: ComparedPlayer, all: ComparedPlayer[], on: Show<ComparePart>, x: number, w: number, s: number, wide = false): Block[] {
  const rows = compareRows(on).filter(([name]) => name !== "Rank");
  const tier = on.has("tier") ? p.tier : null;
  const rating = on.has("rating");
  const rank = on.has("rank") ? (p.rank ? `#${p.rank}` : "Not ranked") : null;
  const ratingColor = p.rating ? c.fg : c["control-border"];
  const top: (Block | null | false | "")[] = wide
    ? [
        block(84 * s * 0.72, 0, (t, k) => {
          const rw = rating ? text(ctx, p.rating ?? "–", x + w, t + 84 * s * k * 0.72, { size: 84 * s * k, weight: 700, narrow: true, align: "right", color: ratingColor }) : 0;
          text(ctx, p.name, x, t + 84 * s * k * 0.72, { size: 84 * s * k, weight: 800, narrow: true, max: w - rw - 40 * s });
        }),
        (tier || rank) &&
          block(20 * s * 1.55, 30 * s, (t, k) => {
            if (tier) chip(ctx, tier, x, t, 20 * s * k);
            if (rank) text(ctx, rank, x + w, t + 20 * s * k * 1.2, { size: 30 * s * k, weight: 600, narrow: true, color: c.soft, align: "right" });
          }),
      ]
    : [
        line(ctx, p.name, x, { size: 84 * s, weight: 800, narrow: true, max: w }, 0, 0.2),
        tier && chipBlock(ctx, tier, x, 20 * s, "left", 30 * s),
        rating && line(ctx, p.rating ?? "–", x, { size: 110 * s, weight: 700, narrow: true, color: ratingColor }, 40 * s, 0.2),
        rank && line(ctx, rank, x, { size: 30 * s, weight: 600, narrow: true, color: c.soft }, 22 * s),
      ];
  const blocks: (Block | null | false | "")[] = [
    ...top,
    rows.length > 0 &&
      block(rows.length * 40 * s - 18 * s, 40 * s, (t, k) =>
        rows.forEach((row, i) => {
          const ry = t + (22 + i * 40) * s * k;
          const best = leads(all, p, row);
          text(ctx, row[0], x, ry, { size: 22 * s * k, color: c.muted, max: w * 0.6 });
          text(ctx, row[1](p), x + w, ry, { size: 26 * s * k, weight: best ? 800 : 600, narrow: true, align: "right", color: best ? c.fg : c.muted });
        }),
      ),
    on.has("chart") && p.points.length > 1 && chartBlock(ctx, [{ points: p.points, color: trend(p.points.map((q) => q.rating)) }], x, w, 80 * s, 34 * s, 1.5, true),
  ];
  return blocks.filter((b): b is Block => Boolean(b));
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean, on: Show<ComparePart>): void {
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
      stack(side(ctx, p, d.players, on, left, right - left, s), 130, 560, "center", 1.6);
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
  const s = n > 2 ? 1.2 : 1.5;
  d.players.forEach((p, i) => stack(side(ctx, p, d.players, on, pad, W - pad * 2, s, true), top + i * zone + slant + 40, top + (i + 1) * zone - slant - 20, "center", 1.6));
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
