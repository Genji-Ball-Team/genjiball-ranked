// Classic: the first card. Name and rating side by side, figures, the rating line and recent form,
// each only when picked; what's left takes the room the rest leave.
import {
  block,
  c,
  caps,
  change,
  chartBlock,
  chipBlock,
  compareRows,
  crownOf,
  figuresBlock,
  fitTable,
  font,
  footer,
  form,
  formBlock,
  ground,
  header,
  label,
  leads,
  line,
  matchFacts,
  matchId,
  natural,
  playerSeries,
  playerStats,
  rankLine,
  rgba,
  stack,
  text,
  cup,
  type Block,
  type Rgb,
  type Series,
} from "./kit";
import type { ComparePart, MatchPart, PlayerPart, Show } from "./parts";
import type { CompareCard, MatchCard, PlayerCard } from "./types";

const present = (list: (Block | null | false | undefined | "")[]): Block[] => list.filter((b): b is Block => Boolean(b));

function measure(ctx: CanvasRenderingContext2D, value: string | number, size: number, weight: number, narrow = true): number {
  font(ctx, size, weight, narrow);
  return ctx.measureText(String(value)).width;
}

interface Bit {
  s: string;
  color: Rgb;
  weight: number;
}

/** Texts on one line, `gap` apart, from `x` (or ending at `x` when `align` is "right"). */
function bits(ctx: CanvasRenderingContext2D, list: Bit[], x: number, size: number, align: "left" | "right" | "center", gap = 0): Block | null {
  if (!list.length) return null;
  return block(size * 0.72, gap, (top, k) => {
    const s = size * k;
    const space = s * 0.7;
    const widths = list.map((b) => measure(ctx, b.s, s, b.weight, false));
    const total = widths.reduce((a, w) => a + w, 0) + space * (list.length - 1);
    let left = align === "right" ? x - total : align === "center" ? x - total / 2 : x;
    list.forEach((b, i) => {
      text(ctx, b.s, left, top + s * 0.72, { size: s, weight: b.weight, color: b.color });
      left += (widths[i] ?? 0) + space;
    });
  });
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean, on: Show<PlayerPart>): void {
  const { look, seal } = on.has("title") ? crownOf(d) : { look: null, seal: null };
  ground(ctx, W, H, look?.glow ?? (on.has("tier") ? (d.tier?.color ?? null) : null));
  const tier = on.has("tier") ? d.tier : null;
  const sealColor = look?.seal ?? c.fg;
  // The big number is the rating, or the rank when the rating's hidden.
  const big = on.has("rating") ? String(d.rating ?? "–") : on.has("rank") && d.rank ? `#${d.rank}` : null;
  const bigLabel = on.has("rating") ? "Rating" : "Rank";
  const bigColor = on.has("rating") && !d.rating ? c["control-border"] : (look?.light ?? c.fg);
  const ch = on.has("change") ? change(d.points) : null;
  const sub: Bit[] = [];
  if (on.has("rank") && (on.has("rating") || !d.rank)) sub.push({ s: rankLine(d), color: c.soft, weight: 500 });
  if (ch) sub.push({ s: ch.label, color: ch.color, weight: 700 });
  const stats = playerStats(d, on);
  const series = on.has("chart") ? playerSeries(d) : [];
  const results = on.has("form") ? d.form : [];
  if (!tall) {
    const pad = 64;
    header(ctx, pad, 74, 26, d.region);
    footer(ctx, W, 600, 20, "left", pad);
    const subW = sub.reduce((a, b) => a + measure(ctx, b.s, 28, b.weight, false) + 20, 0);
    const rightW = big ? Math.max(measure(ctx, big, 140, 700), subW) : 0;
    const busy = stats.length > 0 && series.length > 0 ? 0.8 : 1;
    // The name and the rating side by side, drawn bigger when there's room (`k`).
    const left = (k: number) => {
      const max = W - pad * 2 - (rightW ? rightW * k + 70 : 0);
      return present([
        seal && label(ctx, seal, pad, 20 * k, sealColor),
        line(ctx, d.name, pad, { size: 112 * k, weight: 700, narrow: true, max, fill: look?.name }, 26 * k),
        tier && chipBlock(ctx, tier, pad, 26 * k, "left", 22 * k),
        !big && bits(ctx, sub, pad, 28 * k, "left", 26 * k),
      ]);
    };
    const right = (k: number) =>
      big
        ? present([
            label(ctx, bigLabel, W - pad, 20 * k, c.muted, "right"),
            line(ctx, big, W - pad, { size: 140 * k, weight: 700, narrow: true, align: "right", color: bigColor }, 26 * k),
            bits(ctx, sub, W - pad, 28 * k, "right", 26 * k),
          ])
        : [];
    const h = Math.max(natural(left(1)), natural(right(1)));
    const grow = stats.length || series.length ? 0 : 0.3;
    const head = block(h, 0, (top, k) => {
      stack(left(k), top, top + h * k, "end", 1);
      stack(right(k), top, top + h * k, "end", 1);
    }, grow);
    stack(
      [head, figuresBlock(ctx, stats, pad, W - pad * 2, 54 * busy, 60), chartBlock(ctx, series, pad, W - pad * 2, 100 * busy, 50)],
      116,
      results.length ? 540 : 556,
      "center",
      1.8,
    );
    if (results.length) {
      const size = 30;
      const n = Math.min(results.length, 10);
      form(ctx, results.slice(-n), W - pad - n * (size * 1.18) + size * 0.18, 578, size);
    }
    return;
  }
  const pad = 80;
  header(ctx, W / 2, 140, 34, d.region, "center");
  footer(ctx, W, 1860, 30, "center");
  const cx = W / 2;
  const half = Math.ceil(stats.length / 2);
  const rows = stats.length > 2 ? [stats.slice(0, half), stats.slice(half)] : [stats];
  stack(
    [
      seal && label(ctx, seal, cx, 28, sealColor, "center"),
      line(ctx, d.name, cx, { size: 210, weight: 700, narrow: true, align: "center", max: W - pad * 2, fill: look?.name }, 60, 0.15),
      tier && chipBlock(ctx, tier, cx, 46, "center", 40),
      big && label(ctx, bigLabel, cx, 32, c.muted, "center", 150),
      big && line(ctx, big, cx, { size: 300, weight: 700, narrow: true, align: "center", color: bigColor }, 60, 0.15),
      bits(ctx, sub, cx, 48, "center", big ? 60 : 100),
      ...rows.map((list, i) => figuresBlock(ctx, list, pad + 40, W - pad * 2 - 40, 84, i ? 90 : 150)),
      formBlock(ctx, results, cx, W - pad * 2, 72, "center", 110, 10),
      chartBlock(ctx, series, pad, W - pad * 2, 200, 100, 1.4),
    ],
    230,
    1780,
    "center",
    1.6,
  );
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean, on: Show<MatchPart>): void {
  ground(ctx, W, H, d.winners.length && d.tourney && on.has("tourney") ? c.gold : null);
  // A win is `up`; a tourney's winner has earned gold.
  const prize = d.tourney ? c.gold : c.up;
  const nameFill = [c.fg, d.tourney ? c.gold : c["god-cream"]];
  const winner = on.has("winner") ? d.winners.join(" & ") : "";
  const winnerLine = on.has("winnerLine") ? d.winnerLine : "";
  const winLabel = d.winners.length > 1 ? "Shared win" : "Winner";
  const id = matchId(d, on);
  const facts = matchFacts(d, on);
  const standings = on.has("standings") && d.rows.length > 0;
  // Names alone don't take the whole width: centred, or beside the winner.
  const namesOnly = !on.count("won", "kills", "ratings", "changes");
  const cupRow = (x: number, size: number, align: "left" | "center", gap: number) =>
    block(size, gap, (top, k) => {
      const s = size * k;
      if (align === "center") {
        cup(ctx, x - s / 2, top, s, prize);
        return;
      }
      cup(ctx, x, top, s, prize);
      caps(ctx, winLabel, x + s * 1.4, top + s * 0.78, s * 0.55, prize);
    });
  if (!tall) {
    const pad = 64;
    header(ctx, pad, 74, 26, d.region);
    footer(ctx, W, 600, 20, "left", pad);
    const info = present([
      id && label(ctx, id, pad, 22, c.muted),
      facts && line(ctx, facts, pad, { size: 24, color: c.soft, max: standings ? 500 : W - pad * 2 }, 20),
    ]);
    const win = (max: number, size: number) =>
      present([
        (winner || winnerLine) && cupRow(pad, 40, "left", 0),
        winner && line(ctx, winner, pad, { size, weight: 700, narrow: true, max, fill: nameFill }, 34, 0.25),
        winnerLine && line(ctx, winnerLine, pad, { size: 28, color: c.soft, max }, 30),
      ]);
    if (!standings) {
      const body = win(W - pad * 2, 130);
      stack([...info, ...body.map((b, i) => (i ? b : { ...b, gap: info.length ? 70 : 0 }))], 120, 560, "center", 1.8);
      return;
    }
    const leftBlocks = [...info, ...win(500, 100).map((b, i) => (i ? b : { ...b, gap: info.length ? 64 : 0 }))];
    const x = leftBlocks.length ? 620 : namesOnly ? W / 2 - 220 : pad;
    const w = leftBlocks.length ? W - x - pad : namesOnly ? 440 : W - pad * 2;
    stack(leftBlocks, 130, 560, "center", 1.6);
    stack([fitTable(ctx, d, on, { x, w, size: 30, prize, look: "bands" }, 430)], 130, 560, "center");
    return;
  }
  const pad = 80;
  const cx = W / 2;
  header(ctx, cx, 140, 34, d.region, "center");
  footer(ctx, W, 1860, 30, "center");
  const tourney = on.has("tourney") ? d.tourney : null;
  const idOnly = on.has("id") ? `Match #${d.id}` : "";
  const head = present([
    idOnly && label(ctx, idOnly, cx, 34, c.muted, "center"),
    tourney && line(ctx, tourney, cx, { size: 40, weight: 600, align: "center", max: W - pad * 2 }, 30),
    facts && line(ctx, facts, cx, { size: 32, color: c.soft, align: "center", max: W - pad * 2 }, 30),
  ]);
  const win = present([
    (winner || winnerLine) && cupRow(cx, 100, "center", head.length ? 110 : 0),
    (winner || winnerLine) && label(ctx, winLabel, cx, 32, prize, "center", 50),
    winner && line(ctx, winner, cx, { size: 150, weight: 700, narrow: true, align: "center", max: W - pad * 2, fill: nameFill }, 60, standings ? 0 : 0.3),
    winnerLine && line(ctx, winnerLine, cx, { size: 40, color: c.soft, align: "center", max: W - pad * 2 }, 44),
  ]);
  const top = [...head, ...win];
  const room = 1790 - 230 - (top.length ? natural(top) + 100 : 0);
  const table = fitTable(ctx, d, on, { x: namesOnly ? cx - 300 : pad, w: namesOnly ? 600 : W - pad * 2, size: 46, prize, look: "bands" }, Math.min(room, 820), top.length ? 100 : 0);
  stack([...top, table], 230, 1790, "center", 1.6);
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean, on: Show<ComparePart>): void {
  ground(ctx, W, H, null);
  // One line a player, told apart by stroke as well as shade: solid, dashed, dotted.
  const strokes: Pick<Series, "color" | "dash">[] = [{ color: c.fg }, { color: c.soft, dash: "dashed" }, { color: c.muted, dash: "dotted" }];
  const stroke = (i: number) => strokes[i] ?? { color: c.muted };
  const pad = tall ? 80 : 64;
  const n = d.players.length;
  const s = tall ? 1.45 : 1;
  const gap = 32 * s;
  const colW = (W - pad * 2 - gap * (n - 1)) / n;
  const rows = compareRows(on);
  const series = on.has("chart") ? d.players.flatMap((p, i) => (p.points.length > 1 ? [{ points: p.points, ...stroke(i) }] : [])) : [];
  const anyTier = on.has("tier") && d.players.some((p) => p.tier);
  // Fewer parts, bigger type.
  const few = !on.has("rating") && !rows.length && !series.length ? 1.4 : 1;
  // A wide card with the lines under everything: smaller figures.
  const busy = !tall && series.length && rows.length > 1 ? 0.7 : 1;
  const nameSize = Math.min(...d.players.map((p) => {
    font(ctx, 54 * s * few, 700, true);
    const w = ctx.measureText(p.name).width;
    const room = colW - 24 * s;
    return Math.max(54 * s * 0.6, (w > room ? 54 * s * few * (room / w) : 54 * s * few) * busy);
  }));
  const step = (tall ? 54 : 38) * s * (on.has("rating") ? 1 : 1.15) * (busy < 1 ? 0.78 : 1);
  header(ctx, tall ? W / 2 : pad, tall ? 140 : 74, tall ? 34 : 26, d.region, tall ? "center" : "left");
  footer(ctx, W, tall ? 1860 : 600, tall ? 30 : 20, tall ? "center" : "left", pad);
  const kind = n === 2 ? "Head to head" : n > 2 ? "Compare" : "Player";
  const columns = block(0, 0, () => undefined);
  // Every column has the same parts, so one height fits all.
  const parts = (x: number, p: CompareCard["players"][number], i: number): Block[] =>
    present([
      block(8 * s, 0, (top, k) => {
        const { color, dash } = stroke(i);
        ctx.save();
        ctx.strokeStyle = rgba(color);
        ctx.lineWidth = 8 * s * k;
        ctx.lineCap = dash === "dotted" ? "round" : "butt";
        ctx.setLineDash(dash === "dashed" ? [32 * s, 20 * s] : dash === "dotted" ? [0, 18 * s] : []);
        ctx.beginPath();
        ctx.moveTo(x + (dash === "dotted" ? 4 * s : 0), top + 4 * s);
        ctx.lineTo(x + colW, top + 4 * s);
        ctx.stroke();
        ctx.restore();
      }),
      line(ctx, p.name, x, { size: nameSize, weight: 700, narrow: true, max: colW }, 40 * s * busy),
      anyTier && block(22 * s * 1.55, 18 * s, (top, k) => p.tier && chipBlock(ctx, p.tier, x, 22 * s * k).draw(top, 1)),
      on.has("rating") && line(ctx, p.rating ?? "–", x, { size: 96 * s * busy, weight: 700, narrow: true, color: p.rating ? c.fg : c["control-border"] }, 40 * s * busy),
      ...rows.map((row, j) =>
        block(24 * s * 0.72, j ? step - 24 * s * 0.72 : 44 * s * busy, (top, k) => {
          const y = top + 24 * s * 0.72 * k;
          const best = leads(d.players, p, row);
          text(ctx, row[0], x, y, { size: 22 * s * k, color: c.muted, max: colW * 0.6 });
          // The leader in each row is brighter and bolder.
          text(ctx, row[1](p), x + colW, y, { size: 24 * s * k, weight: best ? 800 : 600, narrow: true, align: "right", color: best ? c.fg : c.muted });
        }),
      ),
    ]);
  const h = natural(parts(pad, d.players[0] as CompareCard["players"][number], 0));
  columns.h = h;
  columns.gap = 34 * s;
  columns.draw = (top, k) => d.players.forEach((p, i) => stack(parts(pad + i * (colW + gap), p, i), top, top + h * k, "start", 1));
  stack(
    [
      label(ctx, kind, tall ? W / 2 : pad, 20 * s, c.muted, tall ? "center" : "left"),
      columns,
      tall && series.length > 0 && label(ctx, "Rating over time", pad, 20 * s, c.muted, "left", 120),
      chartBlock(ctx, series, pad, W - pad * 2, tall ? 320 : 80, tall ? 40 : 30, tall ? 0.3 : 1.2, series.length === 1),
    ],
    tall ? 250 : 110,
    tall ? 1780 : 556,
    "center",
    1.6,
  );
}
