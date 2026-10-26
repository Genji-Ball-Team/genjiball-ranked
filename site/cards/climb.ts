// Climb: the rating line is the card. It fills the bottom edge to edge, shaded under, in one colour
// from the net change (up or down), with the tier's threshold as a dashed line. A match shows each
// player's swing as a bar; a compare card shows everyone's lines. The line takes whatever room the
// picked parts above it leave; without it, they fill the card.
import {
  block,
  c,
  caps,
  change,
  chip,
  chipBlock,
  chipWidth,
  compareRows,
  crownOf,
  figuresBlock,
  fitTable,
  footer,
  formBlock,
  header,
  inlineBlock,
  label,
  leads,
  line,
  lines,
  matchFacts,
  natural,
  playerStats,
  rankLine,
  rgba,
  rowDelta,
  stack,
  text,
  trend,
  type Block,
  type Rgb,
  type Series,
} from "./kit";
import type { ComparePart, MatchPart, PlayerPart, Show } from "./parts";
import type { CompareCard, MatchCard, PlayerCard } from "./types";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const present = (list: (Block | null | false | undefined | "")[]): Block[] => list.filter((b): b is Block => Boolean(b));

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

/** The tier chip with a line of text after it (or at `end`, right-aligned), as a block. */
function tagRow(ctx: CanvasRenderingContext2D, tier: PlayerCard["tier"], note: string | null, x: number, size: number, noteSize: number, gap: number, end?: number): Block | null {
  if (!tier && !note) return null;
  const h = Math.max(tier ? size * 1.55 : 0, noteSize * 0.72);
  // Alone, the note starts where the chip would.
  const right = tier ? end : undefined;
  return block(h, gap, (top, k) => {
    if (tier) chip(ctx, tier, x, top + (h - size * 1.55) * k * 0.5, size * k);
    if (!note) return;
    const after = tier ? x + chipWidth(ctx, tier, size * k) + size * k * 0.75 : x;
    const y = top + (h * k + noteSize * k * 0.72) / 2;
    text(ctx, note, right ?? after, y, { size: noteSize * k, weight: 600, narrow: true, color: c.soft, align: right ? "right" : "left", max: (right ?? x + 2000) - after });
  });
}

/** "▲ 120 last 14 matches" from `x`, as a block. */
function changeBlock(ctx: CanvasRenderingContext2D, points: number[], x: number, size: number, gap: number, align: CanvasTextAlign = "left"): Block | null {
  const moved = change(points);
  if (!moved) return null;
  return block(size * 0.72, gap, (top, k) => {
    const y = top + size * k * 0.72;
    const note = `last ${points.length} matches`;
    const o = { weight: 500, narrow: true, color: c.muted };
    if (align === "right") {
      const w = text(ctx, note, x, y, { ...o, size: size * k * 0.72, align: "right" });
      text(ctx, moved.label, x - w - size * k * 0.4, y, { size: size * k, weight: 700, narrow: true, color: moved.color, align: "right" });
    } else {
      const w = text(ctx, moved.label, x, y, { size: size * k, weight: 700, narrow: true, color: moved.color });
      text(ctx, note, x + w + size * k * 0.4, y, { ...o, size: size * k * 0.72 });
    }
  });
}

/** The big number: the rating, or the rank when the rating isn't picked, its label over it. */
function bigNumber(ctx: CanvasRenderingContext2D, d: PlayerCard, on: Show<PlayerPart>, x: number, size: number, align: CanvasTextAlign, light: Rgb | null, max: number): Block[] {
  const out: Block[] = [];
  if (on.has("rating")) {
    out.push(label(ctx, "Rating", x, size * 0.13, c.muted, align));
    out.push(line(ctx, d.rating ?? "–", x, { size, weight: 700, narrow: true, align, color: light ?? c.fg, max }, size * 0.2, 0.15));
  } else if (on.has("rank")) {
    out.push(label(ctx, d.rank ? `Rank in ${d.region}` : "Rank", x, size * 0.13, c.muted, align));
    out.push(line(ctx, d.rank ? `#${d.rank}` : rankLine(d), x, { size: d.rank ? size : size * 0.3, weight: 700, narrow: true, align, color: light ?? c.fg, max }, size * 0.2, 0.15));
  }
  return out;
}

export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean, on: Show<PlayerPart>): void {
  const { look, seal } = on.has("title") ? crownOf(d) : { look: null, seal: null };
  const tier = on.has("tier") ? d.tier : null;
  const chart = on.has("chart");
  const moved = change(d.points);
  ground(ctx, W, H, (chart || on.has("change")) && moved ? moved.color : (look?.glow ?? tier?.color ?? null));
  const stats = playerStats(d, on);
  // The rank sits by the chip under the rating; without the rating it's the big number.
  const rankNote = on.has("rank") && on.has("rating") ? rankLine(d) : null;
  const threshold = tier?.threshold ?? null;
  if (!tall) {
    const pad = 64;
    const top = 116;
    header(ctx, pad, 74, 22, d.region);
    footer(ctx, W, 74, 22, "right", W - pad);
    const right = present([...bigNumber(ctx, d, on, W - pad, 150, "right", look?.light ?? null, 360), on.has("change") && changeBlock(ctx, d.points, W - pad, 32, 26, "right")]);
    const max = W - pad * 2 - (right.length ? 400 : 0);
    // Without the line, the figures go across the bottom.
    const figures = !chart && figuresBlock(ctx, stats, pad, W - pad * 2, 56);
    const left = present([
      seal && label(ctx, seal, pad, 18, look?.seal ?? c.fg),
      line(ctx, d.name, pad, { size: 112, weight: 800, narrow: true, max, fill: look?.name }, 34, 0.3),
      tagRow(ctx, tier, rankNote, pad, 22, 30, 30),
      chart && inlineBlock(ctx, stats, pad, max, 40, 40, 30),
      on.has("form") && formBlock(ctx, d.form, pad, max, 34, "left", 30, 16),
    ]);
    const need = Math.max(natural(left), natural(right));
    const bottom = chart ? clamp(top + need + 50, 330, 420) : figures ? H - 180 : H - 50;
    if (chart) climb(ctx, d.points, bottom, H, W - pad, W, threshold);
    stack(left, top, chart ? bottom - 30 : bottom, "center", 1.8);
    stack(right, top, chart ? bottom - 30 : bottom, "center", 1.6);
    if (figures) {
      ctx.fillStyle = rgba(c.line);
      ctx.fillRect(pad, H - 160, W - pad * 2, 2);
      stack([figures], H - 140, H - 50);
    }
    return;
  }
  const pad = 80;
  const top = 230;
  header(ctx, pad, 150, 34, d.region);
  footer(ctx, W, 150, 30, "right", W - pad);
  const blocks = present([
    seal && label(ctx, seal, pad, 28, look?.seal ?? c.fg),
    line(ctx, d.name, pad, { size: 190, weight: 800, narrow: true, max: W - pad * 2, fill: look?.name }, 50, 0.2),
    tagRow(ctx, tier, rankNote, pad, 40, 48, 50, W - pad),
    ...bigNumber(ctx, d, on, pad, 280, "left", look?.light ?? null, W - pad * 2).map((b, i) => (i ? b : { ...b, gap: 130 })),
    on.has("change") && changeBlock(ctx, d.points, pad, 56, 50),
    inlineBlock(ctx, stats, pad, W - pad * 2, 80, 64, 110),
    on.has("form") && formBlock(ctx, d.form, pad, W - pad * 2, 70, "left", 90, 12),
  ]);
  const bottom = chart ? clamp(top + natural(blocks) + 90, 820, 1320) : H - 120;
  if (chart) climb(ctx, d.points, bottom, H, W - pad, W, threshold);
  stack(blocks, top, chart ? bottom - 60 : bottom, "center", 1.6);
}

type Row = MatchCard["rows"][number];

/** Each player's rating change as a bar up or down from a middle line, the name under it, then `extras` under that (`stacked`, or on one line). */
function swings(ctx: CanvasRenderingContext2D, d: MatchCard, x: number, top: number, w: number, h: number, size: number, count: number, extras: ((p: Row) => string)[], stacked: boolean): void {
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
    const first = p.place === 1;
    text(ctx, p.name, cx, top + h + size * 1.3, { size: size * 0.9, weight: first ? 700 : 500, narrow: true, align: "center", color: first ? c.fg : c.soft, max: cell - 8, shrink: 0.6 });
    const under = stacked ? extras.map((extra) => extra(p)) : extras.length ? [extras.map((extra) => extra(p)).join(" · ")] : [];
    under.forEach((s, j) => {
      text(ctx, s, cx, top + h + size * (2.3 + j * 0.95), { size: size * 0.7, weight: 500, narrow: true, align: "center", color: c.muted, max: cell - 8, shrink: 0.6 });
    });
  });
}

/** What's under each name with the swings: the picked columns other than the change. */
function swingExtras(on: Show<MatchPart>): ((p: Row) => string)[] {
  const list: [MatchPart, (p: Row) => string][] = [
    ["ratings", (p) => (p.after != null ? `${p.after}` : "–")],
    ["won", (p) => `${p.won} won`],
    ["kills", (p) => `${p.kills} kills`],
  ];
  return list.filter(([part]) => on.has(part)).map(([, f]) => f);
}

/** The match's standings in `top`–`bottom`: bars when the change is picked, else a table. */
function standings(ctx: CanvasRenderingContext2D, d: MatchCard, on: Show<MatchPart>, x: number, top: number, bottom: number, w: number, size: number, count: number, prize: Rgb): void {
  if (on.has("changes")) {
    const extras = swingExtras(on);
    // One extra a line when that still leaves the bars room, else all on one line.
    const stacked = bottom - top - size * (0.8 + 1.6 + extras.length * 0.95 + 2.8) >= size * 5;
    caps(ctx, "Rating change", x, top + size * 0.5, size * 0.7, c.muted);
    const under = size * (1.6 + (stacked ? extras.length : Math.min(1, extras.length)) * 0.95);
    swings(ctx, d, x, top + size * 0.8, w, bottom - top - size * 0.8 - under, size, count, extras, stacked);
    return;
  }
  const t = on.has("standings") ? fitTable(ctx, d, on, { x, w, size, prize, look: "rules", head: true }, bottom - top) : null;
  if (t) stack([t], top, bottom, "start");
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean, on: Show<MatchPart>): void {
  ground(ctx, W, H, d.tourney && on.has("tourney") ? c.gold : null);
  const prize = d.tourney ? c.gold : c.up;
  const winner = on.has("winner") ? d.winners.join(" & ") : "";
  const winnerLine = on.has("winnerLine") ? d.winnerLine : "";
  const winLabel = d.winners.length > 1 ? "Shared win" : "Winner";
  const id = on.has("id") ? `Match #${d.id}` : "";
  const tourney = on.has("tourney") ? d.tourney : null;
  const facts = matchFacts(d, on);
  const nameFill = [c.fg, d.tourney ? c.gold : c["god-cream"]];
  const body = on.has("standings") && d.rows.length > 0;
  if (!tall) {
    const pad = 64;
    const top = 116;
    header(ctx, pad, 74, 22, d.region);
    footer(ctx, W, 74, 22, "right", W - pad);
    const right = present([
      id && label(ctx, id, W - pad, 20, c.muted, "right"),
      tourney && line(ctx, tourney, W - pad, { size: 28, weight: 600, narrow: true, align: "right", max: 420 }, 24),
      facts && line(ctx, facts, W - pad, { size: 24, weight: 500, narrow: true, color: c.soft, align: "right", max: 420 }, 22),
    ]);
    const max = W - pad * 2 - (right.length ? 460 : 0);
    const left = present([
      winner && label(ctx, winLabel, pad, 20, prize),
      winner && line(ctx, winner, pad, { size: 92, weight: 800, narrow: true, max, fill: nameFill }, 26, 0.4),
      winnerLine && line(ctx, winnerLine, pad, { size: 30, weight: 500, narrow: true, color: c.soft, max }, 26),
    ]);
    const need = Math.max(natural(left), natural(right));
    const split = body ? clamp(top + need + 40, 210, 290) : H - 50;
    stack(left, top, body ? split - 30 : split, "center", 1.6);
    stack(right, top, body ? split - 30 : split, "center", 1.6);
    if (body) standings(ctx, d, on, pad, split, H - 40, W - pad * 2, 26, 8, prize);
    return;
  }
  const pad = 80;
  const top = 230;
  header(ctx, pad, 150, 34, d.region);
  footer(ctx, W, 150, 30, "right", W - pad);
  const blocks = present([
    id && label(ctx, id, pad, 30, c.muted),
    tourney && line(ctx, tourney, pad, { size: 44, weight: 600, narrow: true, max: W - pad * 2 }, 36),
    facts && line(ctx, facts, pad, { size: 38, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 }, tourney ? 26 : 36),
    winner && label(ctx, winLabel, pad, 32, prize, "left", id || tourney || facts ? 130 : 0),
    winner && line(ctx, winner, pad, { size: 170, weight: 800, narrow: true, max: W - pad * 2, fill: nameFill }, 46, 0.3),
    winnerLine && line(ctx, winnerLine, pad, { size: 44, weight: 500, narrow: true, color: c.soft, max: W - pad * 2 }, winner ? 40 : 130),
  ]);
  // A table goes under the rest; the bars take the bottom of the card.
  const bars = body && on.has("changes");
  if (body && !bars) {
    const room = H - 120 - top - natural(blocks) - 110;
    const t = fitTable(ctx, d, on, { x: pad, w: W - pad * 2, size: 40, prize, look: "rules", head: true }, room);
    if (t) blocks.push({ ...t, gap: blocks.length ? 110 : 0 });
  }
  const split = bars ? clamp(top + natural(blocks) + 120, 560, 1000) : H - 120;
  stack(blocks, top, bars ? split - 60 : split, "center", 1.6);
  if (bars) standings(ctx, d, on, pad, split, H - 80, W - pad * 2, 40, 6, prize);
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean, on: Show<ComparePart>): void {
  ground(ctx, W, H, null);
  const strokes: Pick<Series, "color" | "dash">[] = [{ color: c.fg }, { color: c.soft, dash: "dashed" }, { color: c.muted, dash: "dotted" }];
  const stroke = (i: number) => strokes[i] ?? { color: c.muted };
  const n = Math.max(1, d.players.length);
  const pad = tall ? 80 : 64;
  const series = on.has("chart") ? d.players.flatMap((p, i) => (p.points.length > 1 ? [{ points: p.points, ...stroke(i) }] : [])) : [];
  const rows = compareRows(on);
  const key = (i: number, x: number, w: number, s: number, gap: number): Block =>
    block(7 * s, gap, (top, k) => {
      const { color, dash } = stroke(i);
      const y = top + 3.5 * s * k;
      ctx.save();
      ctx.strokeStyle = rgba(color);
      ctx.lineWidth = 7 * s * k;
      ctx.lineCap = dash === "dotted" ? "round" : "butt";
      ctx.setLineDash(dash === "dashed" ? [28 * s, 18 * s] : dash === "dotted" ? [0, 16 * s] : []);
      ctx.beginPath();
      ctx.moveTo(x + (dash === "dotted" ? 4 * s : 0), y);
      ctx.lineTo(x + w, y);
      ctx.stroke();
      ctx.restore();
    });
  /** The rating with the chip after it, or either alone. */
  const ratingRow = (p: CompareCard["players"][number], x: number, size: number, chipSize: number, gap: number): Block | null => {
    const tier = on.has("tier") ? p.tier : null;
    if (!on.has("rating")) return tier ? chipBlock(ctx, tier, x, chipSize, "left", gap) : null;
    return block(size * 0.72, gap, (top, k) => {
      const y = top + size * k * 0.72;
      const w = text(ctx, p.rating ?? "–", x, y, { size: size * k, weight: 700, narrow: true, color: p.rating ? c.fg : c["control-border"] });
      if (tier) chip(ctx, tier, x + w + chipSize * k * 0.8, y - chipSize * k * 1.55, chipSize * k);
    });
  };
  if (!tall) {
    const top = 120;
    header(ctx, pad, 74, 22, d.region);
    footer(ctx, W, 74, 22, "right", W - pad);
    const gap = 40;
    const colW = (W - pad * 2 - gap * (n - 1)) / n;
    const columns = d.players.map((p, i) => {
      const x = pad + i * (colW + gap);
      return present([
        key(i, x, Math.min(colW, 160), 1, 0),
        line(ctx, p.name, x, { size: 60, weight: 800, narrow: true, max: colW }, 30, 0.3),
        ratingRow(p, x, 50, 18, 26),
        ...rows.map((row, j) => {
          const lead = leads(d.players, p, row);
          return block(24 * 0.72, j ? 14 : 26, (t, k) => {
            const y = t + 24 * k * 0.72;
            caps(ctx, row[0], x, y, 15 * k, c.muted);
            text(ctx, row[1](p), x + colW, y, { size: 24 * k, weight: lead ? 700 : 600, narrow: true, align: "right", color: lead ? c.fg : c.soft });
          });
        }),
      ]);
    });
    const need = Math.max(...columns.map(natural));
    const split = series.length ? clamp(top + need + 40, 280, 420) : H - 50;
    for (const col of columns) stack(col, top, series.length ? split - 20 : split, series.length ? "start" : "center", 1.6);
    if (series.length) lines(ctx, series, pad, split + 20, W - pad * 2, H - 40 - split - 20, series.length === 1);
    return;
  }
  const top = 230;
  header(ctx, pad, 150, 34, d.region);
  footer(ctx, W, 150, 30, "right", W - pad);
  const blocks = d.players.flatMap((p, i) => {
    const tier = on.has("tier") ? p.tier : null;
    const nameH = 84 * 0.72;
    return present([
      block(nameH, i ? 90 : 0, (t, k) => {
        const y = t + nameH * k;
        const off = 160 * k;
        key(i, pad, 120, 1.4, 0).draw(y - nameH * k * 0.5 - 5 * k, k);
        const rw = on.has("rating") ? text(ctx, p.rating ?? "–", W - pad, y, { size: 84 * k, weight: 700, narrow: true, align: "right", color: p.rating ? c.fg : c["control-border"] }) : 0;
        text(ctx, p.name, pad + off, y, { size: 84 * k, weight: 800, narrow: true, max: W - pad * 2 - off - rw - 40 * k });
      }),
      tier && chipBlock(ctx, tier, pad + 160, 26, "left", 26),
      inlineBlock(
        ctx,
        rows.map((row) => [row[0], row[1](p)]),
        pad + 160,
        W - pad * 2 - 160,
        56,
        56,
        40,
      ),
    ]);
  });
  const need = natural(blocks);
  const split = series.length ? clamp(top + need + 120, 700, 1300) : H - 120;
  stack(blocks, top, series.length ? split - 60 : split, "center", 1.6);
  if (series.length) {
    caps(ctx, "Rating over time", pad, split + 30, 28, c.muted);
    lines(ctx, series, pad, split + 100, W - pad * 2, H - 120 - split - 100, series.length === 1);
  }
}
