// Classic: the first card. Everything at once: name and rating, four figures, the rating line and
// recent form.
import { box, c, caps, chip, cup, figures, footer, form, ground, header, lines, rgba, text, titleLooks, trend, type Series } from "./kit";
import { titleSeals } from "../titles";
import type { ComparedPlayer, CompareCard, MatchCard, PlayerCard } from "./types";
export function playerCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: PlayerCard, tall: boolean): void {
  const look = d.crown ? titleLooks[d.crown]() : null;
  const seal = d.crown ? titleSeals[d.crown] : null;
  const sealText = seal && `${seal[0]} · ${d.region} ${seal[1]}`;
  ground(ctx, W, H, look?.glow ?? d.tier?.color ?? null);
  const graph: Series[] = d.points.length > 1 ? [{ points: d.points.map((rating, t) => ({ rating, t })), color: trend(d.points) }] : [];
  const stats: [string, string | number][] = [
    ["Rated rounds", d.rounds ?? "–"],
    ["Rounds won", d.winRate ?? "–"],
    ["Peak", d.peak ?? "–"],
    ["Best streak", d.bestStreak ?? "–"],
  ];
  const rank = d.rank ? `#${d.rank} in ${d.region}` : d.rating ? "Not ranked yet" : `Not rated in ${d.region}`;
  const rating = d.rating ?? "–";
  const sealColor = look?.seal ?? c.fg;
  if (!tall) {
    const pad = 64;
    header(ctx, pad, 74, 26, d.region);
    let y = 214;
    if (sealText) {
      caps(ctx, sealText, pad, 136, 20, sealColor);
      y = 222;
    }
    text(ctx, d.name, pad, y, { size: 112, weight: 700, narrow: true, max: W - pad * 2 - 380, fill: look?.name });
    if (d.tier) chip(ctx, d.tier, pad, y + 26, 26);
    caps(ctx, "Rating", W - pad, 128, 20, c.muted, "right");
    text(ctx, rating, W - pad, 252, { size: 140, weight: 700, narrow: true, align: "right", color: look?.light ?? c.fg });
    text(ctx, rank, W - pad, 296, { size: 28, weight: 500, color: c.soft, align: "right" });
    figures(ctx, stats, pad, 392, W - pad * 2, 54);
    lines(ctx, graph, pad, 470, W - pad * 2, 90);
    footer(ctx, W, 600, 20, "left", pad);
    if (d.form.length) {
      const size = 30;
      const n = Math.min(d.form.length, 10);
      form(ctx, d.form.slice(-n), W - pad - n * (size * 1.18) + size * 0.18, 578, size);
    }
    return;
  }
  const pad = 80;
  header(ctx, W / 2, 140, 34, d.region, "center");
  if (sealText) caps(ctx, sealText, W / 2, 330, 28, sealColor, "center");
  text(ctx, d.name, W / 2, 520, { size: 210, weight: 700, narrow: true, align: "center", max: W - pad * 2, fill: look?.name });
  if (d.tier) chip(ctx, d.tier, W / 2, 576, 46, "center");
  caps(ctx, "Rating", W / 2, 780, 32, c.muted, "center");
  text(ctx, rating, W / 2, 1040, { size: 300, weight: 700, narrow: true, align: "center", color: look?.light ?? c.fg });
  text(ctx, rank, W / 2, 1116, { size: 48, weight: 500, color: c.soft, align: "center" });
  figures(ctx, stats.slice(0, 2), pad + 40, 1270, W - pad * 2 - 40, 84);
  figures(ctx, stats.slice(2), pad + 40, 1430, W - pad * 2 - 40, 84);
  if (d.form.length) form(ctx, d.form.slice(-10), W / 2, 1530, 72, "center");
  lines(ctx, graph, pad, 1680, W - pad * 2, 130);
  footer(ctx, W, 1860, 30, "center");
}

export function matchCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: MatchCard, tall: boolean): void {
  ground(ctx, W, H, d.winners.length && d.tourney ? c.gold : null);
  const facts = [d.date, d.map, d.rounds, d.playerCount].filter(Boolean).join("  ·  ");
  const winner = d.winners.join(" & ");
  // A win is `up`; a tourney's winner has earned gold.
  const prize = d.tourney ? c.gold : c.up;
  const nameFill = [c.fg, d.tourney ? c.gold : c["god-cream"]];
  const pad = tall ? 80 : 64;
  const table = (x: number, y: number, w: number, rowH: number, size: number, max: number) => {
    const rating = x + w - size * 0.6;
    const kills = rating - size * 5.2;
    const cols = { place: x + size * 0.9, name: x + size * 2.2, won: kills - size * 3.4, kills, rating };
    caps(ctx, "#", cols.place, y, size * 0.6, c.muted, "center");
    caps(ctx, "Player", cols.name, y, size * 0.6, c.muted);
    caps(ctx, "Won", cols.won, y, size * 0.6, c.muted, "right");
    caps(ctx, "Kills", cols.kills, y, size * 0.6, c.muted, "right");
    caps(ctx, "Rating", cols.rating, y, size * 0.6, c.muted, "right");
    d.rows.slice(0, max).forEach((p, i) => {
      const top = y + size * 0.7 + i * rowH;
      const base = top + rowH * 0.66;
      box(ctx, x, top, w, rowH - 8, 10);
      ctx.fillStyle = p.place === 1 ? rgba(prize, 0.1) : rgba(c.fg, i % 2 ? 0.02 : 0.045);
      ctx.fill();
      text(ctx, p.place, cols.place, base, { size, weight: 700, narrow: true, align: "center", color: p.place === 1 ? prize : c.soft });
      text(ctx, p.name, cols.name, base, { size, weight: 600, narrow: true, max: cols.won - cols.name - size * 1.6, shrink: 0.7 });
      text(ctx, p.won, cols.won, base, { size, weight: 600, narrow: true, align: "right", color: c.soft });
      text(ctx, p.kills, cols.kills, base, { size, weight: 600, narrow: true, align: "right", color: c.soft });
      const delta = p.after != null && p.before != null ? p.after - p.before : 0;
      let right = cols.rating;
      // The arrow says it too, so the colour isn't the only cue.
      if (delta) right -= text(ctx, `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}`, right, base, { size: size * 0.8, weight: 700, narrow: true, align: "right", color: delta > 0 ? c.up : c.down }) + size * 0.4;
      text(ctx, p.after ? p.after : "–", right, base, { size, weight: 700, narrow: true, align: "right", color: p.after ? c.fg : c["control-border"] });
    });
  };
  const label = d.winners.length > 1 ? "Shared win" : "Winner";
  if (!tall) {
    header(ctx, pad, 74, 26, d.region);
    caps(ctx, `Match #${d.id}${d.tourney ? ` · ${d.tourney}` : ""}`, pad, 150, 22, c.muted);
    text(ctx, facts, pad, 190, { size: 24, color: c.soft, max: 520 });
    if (winner) {
      cup(ctx, pad, 252, 40, prize);
      caps(ctx, label, pad + 56, 284, 22, prize);
      text(ctx, winner, pad, 400, { size: 104, weight: 700, narrow: true, max: 520, fill: nameFill });
      text(ctx, d.winnerLine, pad, 452, { size: 28, color: c.soft, max: 520 });
    }
    table(620, 150, W - 620 - pad, 76, 30, 5);
    footer(ctx, W, 600, 20, "left", pad);
    return;
  }
  header(ctx, W / 2, 140, 34, d.region, "center");
  caps(ctx, `Match #${d.id}`, W / 2, 300, 34, c.muted, "center");
  if (d.tourney) text(ctx, d.tourney, W / 2, 354, { size: 36, weight: 600, align: "center", max: W - pad * 2 });
  text(ctx, facts, W / 2, d.tourney ? 408 : 360, { size: 32, color: c.soft, align: "center", max: W - pad * 2 });
  if (winner) {
    cup(ctx, W / 2 - 50, 500, 100, prize);
    caps(ctx, label, W / 2, 680, 32, prize, "center");
    text(ctx, winner, W / 2, 840, { size: 150, weight: 700, narrow: true, align: "center", max: W - pad * 2, fill: nameFill });
    text(ctx, d.winnerLine, W / 2, 910, { size: 40, color: c.soft, align: "center", max: W - pad * 2 });
  }
  table(pad, 1030, W - pad * 2, 88, 40, 8);
  footer(ctx, W, 1860, 30, "center");
}

export function compareCard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CompareCard, tall: boolean): void {
  ground(ctx, W, H, null);
  // One line a player, told apart by stroke as well as shade: solid, dashed, dotted.
  const strokes: Pick<Series, "color" | "dash">[] = [{ color: c.fg }, { color: c.soft, dash: "dashed" }, { color: c.muted, dash: "dotted" }];
  const stroke = (i: number) => strokes[i] ?? { color: c.muted };
  const pad = tall ? 80 : 64;
  const n = d.players.length;
  const s = tall ? 1.45 : 1;
  const top = tall ? 400 : 160;
  const step = tall ? 54 : 38;
  const gap = 32 * s;
  const colW = (W - pad * 2 - gap * (n - 1)) / n;
  header(ctx, tall ? W / 2 : pad, tall ? 140 : 74, tall ? 34 : 26, d.region, tall ? "center" : "left");
  caps(ctx, n === 2 ? "Head to head" : n > 2 ? "Compare" : "Player", tall ? W / 2 : pad, top - 30 * s, 20 * s, c.muted, tall ? "center" : "left");
  const rows: [string, (p: ComparedPlayer) => string, (p: ComparedPlayer) => number | null, 1 | -1][] = [
    ["Rank", (p) => (p.rank ? `#${p.rank}` : "–"), (p) => p.rank, -1],
    ["Rounds won", (p) => p.winRate ?? "–", (p) => p.winShare, 1],
    ["Kills a round", (p) => p.killsPerRound?.toFixed(2) ?? "–", (p) => p.killsPerRound, 1],
    ["Peak", (p) => String(p.peak ?? "–"), (p) => p.peak, 1],
  ];
  d.players.forEach((p, i) => {
    const x = pad + i * (colW + gap);
    const { color, dash } = stroke(i);
    // The key: a sample of the player's line.
    ctx.save();
    ctx.strokeStyle = rgba(color);
    ctx.lineWidth = 8 * s;
    ctx.lineCap = dash === "dotted" ? "round" : "butt";
    ctx.setLineDash(dash === "dashed" ? [32 * s, 20 * s] : dash === "dotted" ? [0, 18 * s] : []);
    ctx.beginPath();
    ctx.moveTo(x + (dash === "dotted" ? 4 * s : 0), top + 4 * s);
    ctx.lineTo(x + colW, top + 4 * s);
    ctx.stroke();
    ctx.restore();
    text(ctx, p.name, x, top + 72 * s, { size: 54 * s, weight: 700, narrow: true, max: colW });
    if (p.tier) chip(ctx, p.tier, x, top + 92 * s, 22 * s);
    text(ctx, p.rating ?? "–", x, top + 220 * s, { size: 96 * s, weight: 700, narrow: true, color: p.rating ? c.fg : c["control-border"] });
    rows.forEach(([label, show, value, better], j) => {
      const y = top + (262 + j * step) * s;
      const known = d.players.map(value).filter((v): v is number => v != null);
      const mine = value(p);
      const best = n > 1 && known.length > 1 && mine != null && mine === (better > 0 ? Math.max(...known) : Math.min(...known));
      text(ctx, label, x, y, { size: 22 * s, color: c.muted, max: colW * 0.6 });
      // The leader in each row is brighter and bolder.
      text(ctx, show(p), x + colW, y, { size: 24 * s, weight: best ? 800 : 600, narrow: true, align: "right", color: best ? c.fg : c.muted });
    });
  });
  const series = d.players.flatMap((p, i) => (p.points.length > 1 ? [{ points: p.points, ...stroke(i) }] : []));
  if (tall) {
    if (series.length) {
      caps(ctx, "Rating over time", pad, 1200, 28, c.muted);
      lines(ctx, series, pad, 1250, W - pad * 2, 500, series.length === 1);
    }
    footer(ctx, W, 1860, 30, "center");
  } else footer(ctx, W, 600, 20, "left", pad);
}
