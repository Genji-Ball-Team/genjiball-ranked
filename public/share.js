// Share: a button on the player, match and compare pages that draws a card of what the page shows,
// to post anywhere: the phone's own share menu, a copied image to paste in Discord, a download, the
// link, or a post on X, Reddit or Bluesky. Two sizes: wide (Discord, X) and story (9:16, phones).
// The page hands over plain data (`share.attach(box, card)`); the card is drawn here, on a canvas,
// in the site's colours and font. A link posted without the image still shows a preview of its own
// (src/site/preview.ts).
"use strict";

const share = (() => {
  const formats = {
    wide: { w: 1200, h: 630, label: "Wide", hint: "Discord, X" },
    story: { w: 1080, h: 1920, label: "Story", hint: "Instagram, TikTok" },
  };
  const formatKey = "share-format";
  // style.css's palette (genjiball.us's).
  const c = { bg: "#090b10", panel: "#0e1117", raised: "#151922", line: "#1d222b", fg: "#eef1f7", soft: "#b4bbc7", muted: "#858d9a", faint: "#5d6573", good: "#67d49a", bad: "#ef6b6b", gold: "#f3cf6b" };
  // A title's colours: its seal and the glow behind the card (style.css, `.hero.god`, `.hero.demi`).
  const titleLooks = { God: { color: c.gold, light: "#fff6d8", seal: "Reigning God", what: "1v1 champion" }, Demigod: { color: "#e0523a", light: "#ffb4a0", seal: "Demigod", what: "1v1 top 4" } };
  const fontStack = "Saira, system-ui, sans-serif";
  const trophy = "M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M9.5 17h5v3h-5z";

  // Colours: `#rrggbb` or `[r, g, b]`, with an alpha.
  function rgba(color, a = 1) {
    const [r, g, b] = Array.isArray(color) ? color : [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${a})`;
  }
  // Dark or light text on a tier's colour, whichever reads better (site.js, `tierStyle`).
  function onColor([r, g, b]) {
    const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return 1.05 / (lum + 0.05) > (lum + 0.05) / 0.0535 ? "#fff" : c.bg;
  }
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || c.good;

  // Text

  function font(ctx, size, weight = 400, narrow = false) {
    ctx.font = `${weight} ${size}px ${fontStack}`;
    if ("fontStretch" in ctx) ctx.fontStretch = narrow ? "condensed" : "normal";
  }
  // Draws one line and returns its width. `max`: shrinks the text to fit, down to `shrink` of
  // `size`, then cuts it with an ellipsis. `spacing`: letter spacing, for the small caps labels.
  function text(ctx, s, x, y, { size, weight = 400, narrow = false, color = c.fg, align = "left", max, shrink = 0.45, spacing = 0, fill } = {}) {
    s = String(s);
    let px = size;
    font(ctx, px, weight, narrow);
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
    if (max) {
      while (px > size * shrink && ctx.measureText(s).width > max) font(ctx, (px -= 2), weight, narrow);
      if (ctx.measureText(s).width > max) {
        while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
        s = `${s.trimEnd()}…`;
      }
    }
    const width = ctx.measureText(s).width;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    if (fill) {
      const left = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
      const g = ctx.createLinearGradient(left, y - px, left + width, y);
      fill.forEach((stop, i) => g.addColorStop(i / (fill.length - 1), stop));
      ctx.fillStyle = g;
    } else ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    return width;
  }
  const caps = (ctx, s, x, y, size, color, align = "left") => text(ctx, s.toUpperCase(), x, y, { size, weight: 600, color, align, spacing: size * 0.2 });

  // Shapes

  function box(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  // A tier chip, like the site's: the tier's colour, its label on it. `align`: where `x` is.
  function chip(ctx, tier, x, y, size, align = "left") {
    font(ctx, size, 650, true);
    const w = ctx.measureText(tier.label).width + size * 1.1;
    const h = size * 1.55;
    const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    box(ctx, left, y, w, h, size * 0.25);
    ctx.fillStyle = rgba(tier.color);
    ctx.fill();
    text(ctx, tier.label, left + w / 2, y + h * 0.72, { size, weight: 650, narrow: true, color: onColor(tier.color), align: "center" });
    return w;
  }
  // The site's mark: a ball with a slice through it (favicon.svg).
  function logo(ctx, cx, cy, r, color) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(cx - 0.92 * r, cy + 0.65 * r);
    ctx.lineTo(cx + 0.92 * r, cy - 0.65 * r);
    ctx.strokeStyle = c.bg;
    ctx.lineWidth = 0.27 * r;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }
  function cup(ctx, x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.stroke(new Path2D(trophy));
    ctx.restore();
  }

  // The card's ground: dark, a glow in its colour, faint slices across it at the logo's angle, the
  // region's stripe on top (as on the site).
  function ground(ctx, W, H, stripe, glow) {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    const reach = Math.max(W, H) * 0.75;
    const g = ctx.createRadialGradient(W * 0.88, H * 0.08, 0, W * 0.88, H * 0.08, reach);
    g.addColorStop(0, rgba(glow, 0.24));
    g.addColorStop(1, rgba(glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const low = ctx.createRadialGradient(W * 0.1, H, 0, W * 0.1, H, reach * 0.8);
    low.addColorStop(0, rgba(stripe, 0.08));
    low.addColorStop(1, rgba(stripe, 0));
    ctx.fillStyle = low;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.028)";
    ctx.lineWidth = 2;
    for (let x = -H * 1.4; x < W; x += 54) {
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x + H * 1.43, 0);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = stripe;
    ctx.fillRect(0, 0, W, 10);
  }
  function header(ctx, x, y, size, region, color, align = "left") {
    const r = size * 0.72;
    const name = "GENJI BALL RANKED";
    font(ctx, size, 700, true);
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${size * 0.06}px`;
    const nameW = ctx.measureText(name).width;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    font(ctx, size * 0.85, 600);
    const regionW = region ? ctx.measureText(region.toUpperCase()).width + size * 0.17 * region.length + size * 1.2 : 0;
    const total = r * 2 + size * 0.6 + nameW + regionW;
    let left = align === "center" ? x - total / 2 : x;
    logo(ctx, left + r, y - size * 0.36, r, color);
    left += r * 2 + size * 0.6;
    text(ctx, name, left, y, { size, weight: 700, narrow: true, spacing: size * 0.06 });
    if (region) caps(ctx, region, left + nameW + size * 1.2, y - size * 0.04, size * 0.85, color);
  }
  function footer(ctx, W, y, size, align = "left", x = 0) {
    text(ctx, "genjiball.us", align === "center" ? W / 2 : x, y, { size, weight: 600, color: c.muted, align, spacing: size * 0.05 });
  }

  // A rating line: `series` is `{ points: [{ rating, t }], color }` (a colour `rgba` reads), on one time axis when there are
  // several. The area under a single line fades out; its peak gets a dot, its last point a glow.
  function lines(ctx, series, x, y, w, h, { area = true, peak = true } = {}) {
    const all = series.flatMap((s) => s.points);
    if (all.length < 2) return;
    const byTime = series.length > 1;
    const lo = Math.min(...all.map((p) => p.rating));
    const hi = Math.max(...all.map((p) => p.rating));
    const t0 = Math.min(...all.map((p) => p.t));
    const t1 = Math.max(...all.map((p) => p.t));
    const py = (r) => y + h - ((r - lo) / (hi - lo || 1)) * h;
    for (const s of series) {
      if (!s.points.length) continue;
      const solid = rgba(s.color);
      const px = (p, i) => x + (byTime ? (p.t - t0) / (t1 - t0 || 1) : i / Math.max(1, s.points.length - 1)) * w;
      const pts = s.points.map((p, i) => [px(p, i), py(p.rating)]);
      ctx.beginPath();
      pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)));
      if (area && !byTime) {
        ctx.save();
        ctx.lineTo(pts.at(-1)[0], y + h);
        ctx.lineTo(pts[0][0], y + h);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, rgba(s.color, 0.3));
        g.addColorStop(1, rgba(s.color, 0));
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)));
      }
      ctx.strokeStyle = solid;
      ctx.lineWidth = Math.max(3, h / 40);
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.stroke();
      const [lx, ly] = pts.at(-1);
      ctx.save();
      ctx.shadowColor = solid;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(lx, ly, ctx.lineWidth * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = solid;
      ctx.fill();
      ctx.restore();
      if (peak && !byTime) {
        const top = s.points.reduce((best, p, i) => (p.rating > s.points[best].rating ? i : best), 0);
        const [tx, ty] = pts[top];
        if (top !== pts.length - 1) {
          ctx.beginPath();
          ctx.arc(tx, ty, ctx.lineWidth * 1.4, 0, Math.PI * 2);
          ctx.fillStyle = c.fg;
          ctx.fill();
        }
        const size = Math.max(16, h / 7);
        caps(ctx, `Peak ${s.points[top].rating}`, Math.min(Math.max(tx, x + size * 3), x + w - size * 3), ty - size * 0.9, size, c.soft, "center");
      }
    }
  }
  // Figures in a row: a small caps label over a big number, a line between them.
  function figures(ctx, list, x, y, w, size) {
    const cell = w / list.length;
    list.forEach(([label, value, color], i) => {
      const left = x + i * cell;
      if (i) {
        ctx.fillStyle = c.line;
        ctx.fillRect(left - size * 0.6, y - size * 1.2, 2, size * 2.1);
      }
      caps(ctx, label, left, y - size * 0.62, size * 0.36, c.muted);
      text(ctx, value, left, y + size * 0.52, { size, weight: 700, narrow: true, color: color ?? c.fg, max: cell - size * 0.9 });
    });
  }
  // Recent form: the last rated rounds, oldest first, each its place; a win in the accent colour.
  function form(ctx, results, x, y, size, color, align = "left") {
    const gap = size * 0.18;
    const total = results.length * (size + gap) - gap;
    let left = align === "center" ? x - total / 2 : x;
    for (const place of results) {
      box(ctx, left, y, size, size, size * 0.18);
      ctx.fillStyle = place === 1 ? color : c.raised;
      ctx.fill();
      text(ctx, place, left + size / 2, y + size * 0.7, { size: size * 0.5, weight: 700, narrow: true, color: place === 1 ? c.bg : c.soft, align: "center" });
      left += size + gap;
    }
  }

  // The cards

  function playerCard(ctx, W, H, d, tall) {
    const look = titleLooks[d.crown];
    const color = accent();
    ground(ctx, W, H, color, look?.color ?? d.tier?.color ?? color);
    const nameFill = look ? ["#fff", look.light, look.color] : null;
    const graph = d.points.length > 1 ? [{ points: d.points.map((rating, t) => ({ rating, t })), color: d.tier?.color ?? color }] : [];
    const stats = [
      ["Rated rounds", d.rounds ?? "–"],
      ["Rounds won", d.winRate ?? "–"],
      ["Peak", d.peak ?? "–"],
      ["Best streak", d.bestStreak ?? "–"],
    ];
    const rank = d.rank ? `#${d.rank} in ${d.region}` : d.rating ? "Not ranked yet" : `Not rated in ${d.region}`;
    if (!tall) {
      const pad = 64;
      header(ctx, pad, 74, 26, d.region, color);
      let y = 214;
      if (look) {
        caps(ctx, `${look.seal} · ${d.region} ${look.what}`, pad, 136, 20, look.color);
        y = 222;
      }
      text(ctx, d.name, pad, y, { size: 112, weight: 700, narrow: true, max: W - pad * 2 - 380, fill: nameFill });
      if (d.tier) chip(ctx, d.tier, pad, y + 26, 26);
      caps(ctx, "Rating", W - pad, 128, 20, c.muted, "right");
      text(ctx, d.rating ?? "–", W - pad, 252, { size: 140, weight: 700, narrow: true, align: "right", color: look ? look.light : c.fg });
      text(ctx, rank, W - pad, 296, { size: 28, weight: 500, color: c.soft, align: "right" });
      figures(ctx, stats, pad, 392, W - pad * 2, 54);
      if (graph.length) lines(ctx, graph, pad, 470, W - pad * 2, 90);
      footer(ctx, W, 600, 20, "left", pad);
      if (d.form.length) {
        const size = 30;
        const n = Math.min(d.form.length, 10);
        form(ctx, d.form.slice(-n), W - pad - n * (size * 1.18) + size * 0.18, 578, size, color);
      }
      return;
    }
    const pad = 80;
    header(ctx, W / 2, 140, 34, d.region, color, "center");
    if (look) caps(ctx, `${look.seal} · ${d.region} ${look.what}`, W / 2, 330, 28, look.color, "center");
    text(ctx, d.name, W / 2, 520, { size: 210, weight: 700, narrow: true, align: "center", max: W - pad * 2, fill: nameFill });
    if (d.tier) chip(ctx, d.tier, W / 2, 576, 46, "center");
    caps(ctx, "Rating", W / 2, 780, 32, c.muted, "center");
    text(ctx, d.rating ?? "–", W / 2, 1040, { size: 300, weight: 700, narrow: true, align: "center", color: look ? look.light : c.fg });
    text(ctx, rank, W / 2, 1116, { size: 48, weight: 500, color: c.soft, align: "center" });
    figures(ctx, stats.slice(0, 2), pad + 40, 1270, W - pad * 2 - 40, 84);
    figures(ctx, stats.slice(2), pad + 40, 1430, W - pad * 2 - 40, 84);
    if (d.form.length) form(ctx, d.form.slice(-10), W / 2, 1530, 72, color, "center");
    if (graph.length) lines(ctx, graph, pad, 1680, W - pad * 2, 130);
    footer(ctx, W, 1860, 30, "center");
  }

  function matchCard(ctx, W, H, d, tall) {
    const color = accent();
    ground(ctx, W, H, color, d.winners.length ? c.gold : color);
    const facts = [d.date, d.map, d.rounds, d.playerCount].filter(Boolean).join("  ·  ");
    const winner = d.winners.join(" & ");
    const pad = tall ? 80 : 64;
    const table = (x, y, w, rowH, size, max) => {
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
        ctx.fillStyle = p.place === 1 ? rgba(c.gold, 0.1) : i % 2 ? "rgba(255,255,255,.02)" : "rgba(255,255,255,.045)";
        ctx.fill();
        text(ctx, p.place, cols.place, base, { size, weight: 700, narrow: true, align: "center", color: p.place === 1 ? c.gold : c.soft });
        text(ctx, p.name, cols.name, base, { size, weight: 600, narrow: true, max: cols.won - cols.name - size * 1.6, shrink: 0.7 });
        text(ctx, p.won, cols.won, base, { size, weight: 600, narrow: true, align: "right", color: c.soft });
        text(ctx, p.kills, cols.kills, base, { size, weight: 600, narrow: true, align: "right", color: c.soft });
        const delta = p.after != null && p.before != null ? p.after - p.before : null;
        let right = cols.rating;
        if (delta) right -= text(ctx, `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`, right, base, { size: size * 0.8, weight: 700, narrow: true, align: "right", color: delta > 0 ? c.good : c.bad }) + size * 0.4;
        text(ctx, p.after ? p.after : "–", right, base, { size, weight: 700, narrow: true, align: "right", color: p.after ? c.fg : c.faint });
      });
    };
    if (!tall) {
      header(ctx, pad, 74, 26, d.region, color);
      caps(ctx, `Match #${d.id}${d.tourney ? ` · ${d.tourney}` : ""}`, pad, 150, 22, color);
      text(ctx, facts, pad, 190, { size: 24, color: c.soft, max: 520 });
      if (winner) {
        cup(ctx, pad, 252, 40, c.gold);
        caps(ctx, d.winners.length > 1 ? "Shared win" : "Winner", pad + 56, 284, 22, c.gold);
        text(ctx, winner, pad, 400, { size: 104, weight: 700, narrow: true, max: 520, fill: ["#fff", "#fff6d8", c.gold] });
        text(ctx, d.winnerLine, pad, 452, { size: 28, color: c.soft, max: 520 });
      }
      table(620, 150, W - 620 - pad, 76, 30, 5);
      footer(ctx, W, 600, 20, "left", pad);
      return;
    }
    header(ctx, W / 2, 140, 34, d.region, color, "center");
    caps(ctx, `Match #${d.id}`, W / 2, 300, 34, color, "center");
    if (d.tourney) text(ctx, d.tourney, W / 2, 354, { size: 36, weight: 600, align: "center", max: W - pad * 2 });
    text(ctx, facts, W / 2, d.tourney ? 408 : 360, { size: 32, color: c.soft, align: "center", max: W - pad * 2 });
    if (winner) {
      cup(ctx, W / 2 - 50, 500, 100, c.gold);
      caps(ctx, d.winners.length > 1 ? "Shared win" : "Winner", W / 2, 680, 32, c.gold, "center");
      text(ctx, winner, W / 2, 840, { size: 150, weight: 700, narrow: true, align: "center", max: W - pad * 2, fill: ["#fff", "#fff6d8", c.gold] });
      text(ctx, d.winnerLine, W / 2, 910, { size: 40, color: c.soft, align: "center", max: W - pad * 2 });
    }
    table(pad, 1030, W - pad * 2, 88, 40, 8);
    footer(ctx, W, 1860, 30, "center");
  }

  function compareCard(ctx, W, H, d, tall) {
    const color = accent();
    ground(ctx, W, H, color, d.players[0]?.color ?? color);
    const pad = tall ? 80 : 64;
    const n = d.players.length;
    const s = tall ? 1.45 : 1;
    const top = tall ? 400 : 160;
    const step = tall ? 54 : 38;
    const gap = 32 * s;
    const colW = (W - pad * 2 - gap * (n - 1)) / n;
    header(ctx, tall ? W / 2 : pad, tall ? 140 : 74, tall ? 34 : 26, d.region, color, tall ? "center" : "left");
    caps(ctx, n === 2 ? "Head to head" : n > 2 ? "Compare" : "Player", tall ? W / 2 : pad, top - 30 * s, 20 * s, c.muted, tall ? "center" : "left");
    const rows = [
      ["Rank", (p) => (p.rank ? `#${p.rank}` : "–"), (p) => p.rank, -1],
      ["Rounds won", (p) => p.winRate ?? "–", (p) => p.winShare, 1],
      ["Kills a round", (p) => p.killsPerRound?.toFixed(2) ?? "–", (p) => p.killsPerRound, 1],
      ["Peak", (p) => p.peak ?? "–", (p) => p.peak, 1],
    ];
    d.players.forEach((p, i) => {
      const x = pad + i * (colW + gap);
      box(ctx, x, top, colW, 8 * s, 4 * s);
      ctx.fillStyle = p.color;
      ctx.fill();
      text(ctx, p.name, x, top + 72 * s, { size: 54 * s, weight: 700, narrow: true, max: colW });
      if (p.tier) chip(ctx, p.tier, x, top + 92 * s, 22 * s);
      text(ctx, p.rating ?? "–", x, top + 220 * s, { size: 96 * s, weight: 700, narrow: true, color: p.rating ? c.fg : c.faint });
      rows.forEach(([label, show, value, better], j) => {
        const y = top + (262 + j * step) * s;
        const known = d.players.map(value).filter((v) => v != null);
        const best = n > 1 && known.length > 1 && value(p) != null && value(p) === (better > 0 ? Math.max(...known) : Math.min(...known));
        text(ctx, label, x, y, { size: 22 * s, color: c.muted, max: colW * 0.6 });
        text(ctx, show(p), x + colW, y, { size: 24 * s, weight: 700, narrow: true, align: "right", color: best ? p.color : c.soft });
      });
    });
    const series = d.players.filter((p) => p.points.length > 1).map((p) => ({ points: p.points, color: p.color }));
    if (tall) {
      if (series.length) {
        caps(ctx, "Rating over time", pad, 1200, 28, c.muted);
        lines(ctx, series, pad, 1250, W - pad * 2, 500, { area: series.length === 1 });
      }
      footer(ctx, W, 1860, 30, "center");
    } else footer(ctx, W, 600, 20, "left", pad);
  }

  const cards = { player: playerCard, match: matchCard, compare: compareCard };

  // Every name on the card, so the font's other subset (latin-ext) loads for names that need it.
  function words(card) {
    return [card.name, card.region, ...(card.winners ?? []), ...(card.rows ?? []).map((r) => r.name), ...(card.players ?? []).map((p) => p.name)].filter(Boolean).join(" ");
  }
  async function draw(card, format) {
    const { w, h } = formats[format];
    const sample = words(card) || "Genji Ball";
    await Promise.all([400, 600, 700].map((weight) => document.fonts?.load(`${weight} 40px Saira`, sample))).catch(() => {});
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    cards[card.kind](canvas.getContext("2d"), w, h, card, format === "story");
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));
  }

  // The sheet

  let current = null;
  // The size picked last time. Browser storage can throw (site.js, `remembered`).
  let format = (() => {
    try {
      const kept = localStorage.getItem(formatKey);
      return Object.hasOwn(formats, kept ?? "") ? kept : "wide";
    } catch {
      return "wide";
    }
  })();
  let sheet;
  let blob = null;
  let drawn = 0;
  let statusTimer;

  // Letters and digits of any script stay; the rest (spaces, slashes) become one dash.
  const fileName = () => `genjiball-${current.file.replace(/[^\p{L}\p{N}]+/gu, "-")}-${format}.png`;
  const file = () => new File([blob], fileName(), { type: "image/png" });
  const canShareFiles = () => {
    try {
      return Boolean(navigator.canShare?.({ files: [new File([""], "x.png", { type: "image/png" })] }));
    } catch {
      return false;
    }
  };
  const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  const icons = {
    share: '<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
    x: '<path d="M4 4l16 16M20 4 4 20" />',
    reddit: '<circle cx="12" cy="13.5" r="6.5"/><circle cx="9.5" cy="13" r=".8"/><circle cx="14.5" cy="13" r=".8"/><path d="M9.5 16.2c1.5 1 3.5 1 5 0M12 7l1.2-3.5 3.3.8"/><circle cx="17.8" cy="4.8" r="1.3"/>',
    bluesky: '<path d="M12 11C10 7 7 4.5 4.5 4.5c-1.5 0-1.5 2-1 4.5.5 2.3 2.5 3.4 4.7 3.1-3 .6-3.6 2.4-1.7 4.3 2.7 2.6 4.4-.4 5.5-3.4 1.1 3 2.8 6 5.5 3.4 1.9-1.9 1.3-3.7-1.7-4.3 2.2.3 4.2-.8 4.7-3.1.5-2.5.5-4.5-1-4.5C17 4.5 14 7 12 11Z"/>',
  };

  function status(message) {
    const p = sheet.querySelector(".share-status");
    p.textContent = message;
    clearTimeout(statusTimer);
    if (message) statusTimer = setTimeout(() => (p.textContent = ""), 4000);
  }

  function build() {
    sheet = document.createElement("dialog");
    sheet.className = "modal share-sheet";
    sheet.setAttribute("aria-labelledby", "share-title");
    const native = canShareFiles();
    const copyImage = Boolean(navigator.clipboard?.write && window.ClipboardItem);
    const button = (act, label, path, primary = false) =>
      `<button type="button" data-act="${act}"${primary ? ' class="primary"' : ""} disabled>${icon(path)}<span>${label}</span></button>`;
    sheet.innerHTML = `<div class="share-body">
      <div class="share-head"><h2 id="share-title">Share</h2>
        <div class="share-formats" role="group" aria-label="Image size">${Object.entries(formats)
          .map(([key, f]) => `<button type="button" data-format="${key}" title="${f.hint}">${f.label}</button>`)
          .join("")}</div>
        <button type="button" class="share-close" aria-label="Close">×</button></div>
      <figure class="share-preview" aria-busy="true"><img alt=""></figure>
      <div class="share-actions">
        ${native ? button("native", "Share…", icons.share, true) : ""}
        ${copyImage ? button("copy", "Copy image", icons.copy, !native) : ""}
        ${button("download", "Download", icons.download, !native && !copyImage)}
        ${button("link", "Copy link", icons.link)}
      </div>
      <div class="share-actions share-sites">
        ${button("x", "Post on X", icons.x)}${button("reddit", "Reddit", icons.reddit)}${button("bluesky", "Bluesky", icons.bluesky)}
      </div>
      <p class="share-status" role="status"></p>
    </div>`;
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet || e.target.closest(".share-close")) return sheet.close();
      const pick = e.target.closest("[data-format]");
      if (pick && pick.dataset.format !== format) {
        format = pick.dataset.format;
        try {
          localStorage.setItem(formatKey, format);
        } catch {
          // not kept
        }
        render();
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) actions[act]().catch((error) => error.name !== "AbortError" && status("That didn't work here. Try Download instead."));
    });
    sheet.addEventListener("close", () => clearTimeout(statusTimer));
    document.body.append(sheet);
  }

  const open = (url) => window.open(url, "_blank", "noopener");
  const actions = {
    async native() {
      await navigator.share({ files: [file()], title: current.title, text: `${current.text} ${current.url}` });
    },
    async copy() {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      status("Image copied. Paste it in Discord or anywhere else.");
    },
    async download() {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      status("Saved.");
    },
    async link() {
      await navigator.clipboard.writeText(current.url);
      status("Link copied. It shows a preview in Discord and X.");
    },
    async x() {
      open(`https://x.com/intent/post?text=${encodeURIComponent(current.text)}&url=${encodeURIComponent(current.url)}`);
    },
    async reddit() {
      open(`https://www.reddit.com/submit?url=${encodeURIComponent(current.url)}&title=${encodeURIComponent(current.title)}`);
    },
    async bluesky() {
      open(`https://bsky.app/intent/compose?text=${encodeURIComponent(`${current.text} ${current.url}`)}`);
    },
  };

  async function render() {
    const run = ++drawn;
    const figure = sheet.querySelector(".share-preview");
    const img = figure.querySelector("img");
    figure.setAttribute("aria-busy", "true");
    figure.dataset.format = format;
    for (const b of sheet.querySelectorAll("[data-format]")) b.setAttribute("aria-pressed", String(b.dataset.format === format));
    for (const b of sheet.querySelectorAll("[data-act]")) b.disabled = true;
    try {
      const made = await draw(current, format);
      if (run !== drawn) return;
      blob = made;
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(blob);
      img.alt = `Share image: ${current.title}`;
      for (const b of sheet.querySelectorAll("[data-act]")) b.disabled = false;
    } catch (error) {
      console.error("share image", error);
      if (run === drawn) status("The image didn't draw. The link still works.");
      for (const b of sheet.querySelectorAll('[data-act="link"], [data-act="x"], [data-act="reddit"], [data-act="bluesky"]')) b.disabled = false;
    } finally {
      if (run === drawn) figure.removeAttribute("aria-busy");
    }
  }

  return {
    /**
     * Puts a Share button at the end of `box` (once), for `card`: `{ kind, title, text, url, file, ... }`,
     * the rest what that kind's card draws. Again with a newer card (more loaded) updates it; null
     * hides the button.
     */
    attach(box, card) {
      let button = box.querySelector(".share-button");
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "share-button";
        button.setAttribute("aria-label", "Share");
        button.innerHTML = `${icon(icons.share)}<span>Share</span>`;
        button.addEventListener("click", () => {
          if (!sheet) build();
          status("");
          sheet.showModal();
          render();
        });
        box.append(button);
      }
      current = card;
      button.hidden = !card;
      if (card && sheet?.open) render();
    },
  };
})();
