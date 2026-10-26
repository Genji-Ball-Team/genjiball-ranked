// Sheet: a printed scoresheet. Plain type and thin rules, no glow: the name huge, the figures in ruled
// cells, the rating line a thin stroke in its own ruled row, recent form along the bottom. The rows
// and cells are only the picked figures, sized to fill the sheet.
import {
  block,
  c,
  caps,
  change,
  chip,
  chipWidth,
  compareRows,
  crownOf,
  fitTable,
  form,
  header,
  label,
  leads,
  lines,
  matchFacts,
  natural,
  rgba,
  stack,
  text,
  trend,
  type Block,
  type Series,
} from "./kit";
import type { ComparePart, MatchPart, PlayerPart, Show } from "./parts";
import type { CompareCard, MatchCard, PlayerCard } from "./types";

const present = (list: (Block | null | false | undefined | "")[]): Block[] => list.filter((b): b is Block => Boolean(b));

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

/** The name with the tier chip after it on the same line, as a block. */
function title(ctx: CanvasRenderingContext2D, d: PlayerCard, on: Show<PlayerPart>, x: number, size: number, max: number, chipSize: number, gap: number): Block {
  const look = on.has("title") ? crownOf(d).look : null;
  const tier = on.has("tier") ? d.tier : null;
  return block(
    size * 0.72,
    gap,
    (t, k) => {
      const y = t + size * k * 0.72;
      const room = tier ? chipWidth(ctx, tier, chipSize * k) + chipSize * k : 0;
      const w = text(ctx, d.name, x, y, { size: size * k, weight: 800, narrow: true, max: max - room, shrink: 0.3, fill: look?.name });
      if (tier) chip(ctx, tier, x + w + chipSize * k, y - chipSize * k * 1.55, chipSize * k);
    },
    0.25,
  );
}

/** A player's picked figures, labelled, the rating first. */
function playerFigures(d: PlayerCard, on: Show<PlayerPart>): [string, string | number][] {
  const moved = change(d.points);
  const list: [PlayerPart, string, string | number][] = [
    ["rating", "Rating", d.rating ?? "–"],
    ["rank", "Rank", d.rank ? `#${d.rank}` : "–"],
    ["change", `Last ${d.points.length} matches`, moved?.label ?? "–"],
    ["rounds", "Rated rounds", d.rounds ?? "–"],
    ["winRate", "Rounds won", d.winRate ?? "–"],
    ["peak", "Peak", d.peak ?? "–"],
    ["streak", "Best streak", d.bestStreak ?? "–"],
  ];
  return list.filter(([part]) => on.has(part) && (part !== "change" || moved)).map(([, l, v]) => [l, v]);
}

/** Cells in a row between two rules, an upright between each; the first one bigger. As a block. */
function cells(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, w: number, h: number, size: number, gap: number, colors: Map<string, [number, number, number]>): Block | null {
  if (!list.length) return null;
  // Smaller figures when there are many cells.
  const s = size * Math.min(1, 5.5 / (list.length + 0.5));
  const weights = list.map((_, i) => (i ? 1 : 1.5));
  const total = weights.reduce((a, b) => a + b, 0);
  return block(
    h,
    gap,
    (y, k) => {
      const hk = h * k;
      rule(ctx, x, y, w);
      rule(ctx, x, y + hk, w);
      let left = x;
      list.forEach(([l, value], i) => {
        const cw = (w * (weights[i] ?? 1)) / total;
        const inset = i ? s * 0.4 : 0;
        if (i) upright(ctx, left, y, hk);
        caps(ctx, l, left + inset, y + Math.max(s * 0.62, 26 * k), Math.min(s * 0.32, 20) * k, c.muted);
        text(ctx, value, left + inset, y + hk - s * 0.3 * k, { size: (i ? s : s * 1.3) * k, weight: 700, narrow: true, max: cw - inset - s * 0.3, color: colors.get(l) ?? c.fg });
        left += cw;
      });
    },
    0.2,
  );
}

/** One ruled row each: the label left, the figure right, the first figure bigger. As a block. */
function ruledRows(ctx: CanvasRenderingContext2D, list: [string, string | number][], x: number, w: number, rowH: number, size: number, gap: number, colors: Map<string, [number, number, number]>, first: [number, number, number] | null): Block | null {
  if (!list.length) return null;
  return block(
    list.length * rowH,
    gap,
    (t, k) => {
      const r = rowH * k;
      list.forEach(([l, value], i) => {
        const y = t + i * r;
        rule(ctx, x, y, w);
        caps(ctx, l, x, y + r * 0.6, size * 0.31 * k, c.muted);
        text(ctx, value, x + w, y + r * 0.74, { size: (i ? size : size * 1.35) * Math.min(k, 1.15), weight: 700, narrow: true, align: "right", color: colors.get(l) ?? (i ? c.fg : (first ?? c.fg)) });
      });
      rule(ctx, x, t + list.length * r, w);
    },
    0.25,
  );
}

/** The rating line as a thin plain stroke with a ruled row label. */
function sheetLine(ctx: CanvasRenderingContext2D, series: Series[], x: number, w: number, h: number, size: number, gap: number, caption: string): Block | null {
  if (!series.length) return null;
  return block(
    h,
    gap,
    (t, k) => {
      caps(ctx, caption, x, t + size * 0.72, size * k, c.muted);
      // Room for the caption, then for the peak's label over the line.
      const head = (size * 1.6 + Math.max(16, h / 7) * 1.3) * k;
      lines(ctx, series, x, t + head, w, h * k - head, false);
    },
    1,
  );
}

/** Recent form with "Last 20 rounds · 9 won" over it, in `rows` rows if it needs them. */
function formRows(ctx: CanvasRenderingContext2D, results: number[], x: number, w: number, size: number, labelSize: number, gap: number, perRow: number): Block | null {
  if (!results.length) return null;
  const n = Math.min(results.length, perRow * 2);
  const list = results.slice(-n);
  const won = list.filter((place) => place === 1).length;
  const rows = Math.ceil(n / perRow);
  const s = Math.min(size, w / (1.18 * Math.min(n, perRow) - 0.18));
  const h = labelSize * 0.72 + labelSize * 0.9 + rows * s * 1.2 - s * 0.2;
  return block(h, gap, (t) => {
    caps(ctx, `Last ${n} rounds · ${won} won`, x, t + labelSize * 0.72, labelSize, c.muted);
    for (let r = 0; r < rows; r++) form(ctx, list.slice(r * perRow, (r + 1) * perRow), x, t + labelSize * 1.62 + r * s * 1.2, s);
  });
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean, on: Show<PlayerPart>): void {
  const { look, seal } = on.has("title") ? crownOf(d) : { look: null, seal: null };
  ground(ctx, W, H);
  const list = playerFigures(d, on);
  const moved = change(d.points);
  const colors = new Map(moved ? [[`Last ${d.points.length} matches`, moved.color] as [string, [number, number, number]]] : []);
  const series: Series[] = on.has("chart") && d.points.length > 1 ? [{ points: d.points.map((rating, t) => ({ rating, t })), color: trend(d.points) }] : [];
  const form = on.has("form") ? d.form : [];
  if (!tall) {
    const pad = 64;
    top(ctx, W, pad, 74, 22, d.region);
    // The form goes beside the line when both are picked, so neither gets squeezed.
    const both = series.length > 0 && form.length > 0;
    const blocks = present([
      seal && label(ctx, seal, pad, 18, look?.seal ?? c.fg),
      title(ctx, d, on, pad, 150, W - pad * 2, 22, 28),
      cells(ctx, list, pad, W - pad * 2, 150, 64, 40, colors),
      both
        ? block(110, 34, (t, k) => {
            sheetLine(ctx, series, pad, (W - pad * 2) * 0.48, 110, 16, 0, "Rating")?.draw(t, k);
            formRows(ctx, form, pad + (W - pad * 2) * 0.54, (W - pad * 2) * 0.46, 30, 16, 0, 12)?.draw(t + (110 * k - 60) / 2, 1);
          })
        : sheetLine(ctx, series, pad, W - pad * 2, 110, 16, 34, "Rating"),
      !both && formRows(ctx, form, pad, W - pad * 2, 30, 16, 34, 20),
    ]);
    stack(blocks, 124, H - 40, "center", 1.8);
    return;
  }
  const pad = 80;
  top(ctx, W, pad, 150, 34, d.region);
  const rowH = Math.min(150, 860 / Math.max(1, list.length));
  const blocks = present([
    seal && label(ctx, seal, pad, 28, look?.seal ?? c.fg),
    title(ctx, d, on, pad, 190, W - pad * 2, 32, 50),
    ruledRows(ctx, list, pad, W - pad * 2, rowH, 96, 70, colors, look?.light ?? null),
    sheetLine(ctx, series, pad, W - pad * 2, 260, 28, 70, "Rating line"),
    formRows(ctx, form, pad, W - pad * 2, 78, 28, 70, 10),
  ]);
  stack(blocks, 250, H - 70, "center", 1.6);
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean, on: Show<MatchPart>): void {
  ground(ctx, W, H);
  const prize = d.tourney ? c.gold : c.up;
  const winner = on.has("winner") ? d.winners.join(" & ") : "";
  const facts = matchFacts(d, on);
  const tourney = on.has("tourney") ? d.tourney : null;
  const where = [tourney, facts].filter(Boolean).join("  ·  ");
  const winnerLine = on.has("winnerLine") ? d.winnerLine : "";
  const pad = tall ? 80 : 64;
  const s = tall ? 1.5 : 1;
  const w = W - pad * 2;
  top(ctx, W, pad, tall ? 150 : 74, 22 * s, d.region, on.has("id") ? `Match #${d.id}` : "genjiball.us");
  const nameFill = [c.fg, d.tourney ? c.gold : c["god-cream"]];
  const winLabel = d.winners.length > 1 ? "Shared win" : "Winner";
  const blocks: Block[] = [];
  if (!tall) {
    // The winner on the left with where it was played on the right of the same line.
    if (winner) {
      blocks.push(label(ctx, winLabel, pad, 18, prize));
      blocks.push(
        block(
          76 * 0.72,
          26,
          (t, k) => {
            const y = t + 76 * k * 0.72;
            const room = where ? Math.min(500, w * 0.42) : 0;
            text(ctx, winner, pad, y, { size: 76 * k, weight: 800, narrow: true, max: w - room - 30, fill: nameFill });
            if (where) text(ctx, where, W - pad, y, { size: 24, weight: 500, narrow: true, color: c.soft, align: "right", max: room });
          },
          0.4,
        ),
      );
    } else if (where) blocks.push(block(24 * 0.72, 0, (t) => void text(ctx, where, pad, t + 24 * 0.72, { size: 24, weight: 500, narrow: true, color: c.soft, max: w })));
    if (winnerLine) blocks.push(block(26 * 0.72, 22, (t) => void text(ctx, winnerLine, pad, t + 26 * 0.72, { size: 26, weight: 500, narrow: true, color: c.soft, max: w })));
    const t = fitTable(ctx, d, on, { x: pad, w, size: 28, prize, look: "rules", head: "auto" }, H - 40 - 130 - natural(blocks) - 40, blocks.length ? 40 : 0);
    if (t) blocks.push(t);
    stack(blocks, 130, H - 40, t ? "start" : "center", t ? 1.3 : 1.8);
    return;
  }
  if (winner) {
    blocks.push(label(ctx, winLabel, pad, 27, prize));
    blocks.push(line(winner, 114, 40, nameFill));
  }
  if (winnerLine) blocks.push({ ...line(winnerLine, 44, winner ? 34 : 0, null, c.soft), grow: 0 });
  if (where) blocks.push({ ...line(where, 36, blocks.length ? 30 : 0, null, c.soft), grow: 0 });
  const t = fitTable(ctx, d, on, { x: pad, w, size: 44, prize, look: "rules", head: "auto" }, H - 120 - 300 - natural(blocks) - 90, blocks.length ? 90 : 0);
  if (t) blocks.push(t);
  stack(blocks, 300, H - 120, t ? "start" : "center", t ? 1.5 : 1.8);
  caps(ctx, "genjiball.us", pad, 1860, 30, c.muted);

  function line(value: string, size: number, gap: number, fill: typeof nameFill | null, color = c.fg): Block {
    return block(size * 0.72, gap, (top, k) => void text(ctx, value, pad, top + size * k * 0.72, { size: size * k, weight: fill ? 800 : 500, narrow: true, max: w, fill: fill ?? undefined, color }), 0.3);
  }
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean, on: Show<ComparePart>): void {
  ground(ctx, W, H);
  const pad = tall ? 80 : 64;
  const s = tall ? 1.5 : 1;
  top(ctx, W, pad, tall ? 150 : 74, 22 * s, d.region, d.players.length === 2 ? "Head to head" : "Compare");
  const n = Math.max(1, d.players.length);
  const rows = compareRows(on, true);
  // Without rows the names need no label column.
  const labelW = rows.length ? (tall ? (n > 2 ? 200 : 260) : 300) : 0;
  const colW = (W - pad * 2 - labelW) / n;
  const colX = (i: number) => pad + labelW + (i + 1) * colW - 8;
  const strokes: Pick<Series, "color" | "dash">[] = [{ color: c.fg }, { color: c.soft, dash: "dashed" }, { color: c.muted, dash: "dotted" }];
  const series = on.has("chart") ? d.players.flatMap((p, i) => (p.points.length > 1 ? [{ points: p.points, ...(strokes[i] ?? { color: c.muted }) }] : [])) : [];
  const nameSize = (n > 2 ? 44 : 54) * s * (rows.length ? 1 : 1.3);
  const tier = on.has("tier");
  const keyH = series.length ? 14 * s : 0;
  const names = block(nameSize * 0.72 + (tier ? 16 * s + 18 * s * 1.55 : 0) + keyH, 0, (t, k) => {
    d.players.forEach((p, i) => {
      const x = colX(i);
      const base = t + nameSize * k * 0.72;
      text(ctx, p.name, x, base, { size: nameSize * k, weight: 800, narrow: true, align: "right", max: colW - 16 });
      if (tier && p.tier) chip(ctx, p.tier, x, base + 16 * s * k, 18 * s * k, "right");
      if (series.length) {
        // Which line is whose, under the name.
        const { color, dash } = strokes[i] ?? { color: c.muted };
        const y = base + (tier ? 16 * s + 18 * s * 1.55 : 0) * k + 12 * s * k;
        ctx.save();
        ctx.strokeStyle = rgba(color);
        ctx.lineWidth = 4 * s;
        ctx.lineCap = dash === "dotted" ? "round" : "butt";
        ctx.setLineDash(dash === "dashed" ? [16 * s, 10 * s] : dash === "dotted" ? [0, 10 * s] : []);
        ctx.beginPath();
        ctx.moveTo(x - Math.min(colW - 16, 90 * s), y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.restore();
      }
    });
  });
  const rowH = tall ? Math.min(190, 950 / Math.max(1, rows.length)) : Math.min(70, 300 / Math.max(1, rows.length));
  const table: Block | null = rows.length
    ? block(
        rows.length * rowH,
        50 * s,
        (t, k) => {
          const r = rowH * k;
          rows.forEach((row, j) => {
            const y = t + j * r;
            rule(ctx, pad, y, W - pad * 2, j ? c.line : c.border);
            caps(ctx, row[0], pad, y + r * 0.62, 18 * s * Math.min(k, 1.2), c.muted);
            d.players.forEach((p, i) => {
              const best = leads(d.players, p, row);
              text(ctx, row[1](p), colX(i), y + r * 0.72, { size: (row[0] === "Rating" ? 52 : 40) * s * Math.min(k, 1.2), weight: best ? 800 : 600, narrow: true, align: "right", color: best ? c.fg : c.muted });
            });
          });
          rule(ctx, pad, t + rows.length * r, W - pad * 2);
        },
        0.3,
      )
    : null;
  const chart = series.length
    ? block(
        tall ? 420 : 150,
        40 * s,
        (t, k) => {
          lines(ctx, series, pad, t, W - pad * 2, (tall ? 420 : 150) * k, false);
        },
        1,
      )
    : null;
  stack(present([names, table, chart]), tall ? 280 : 130, tall ? H - 120 : H - 40, "center", 1.6);
  if (tall) caps(ctx, "genjiball.us", pad, 1860, 30, c.muted);
}
