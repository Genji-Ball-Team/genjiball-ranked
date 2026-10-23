// The 404 page (404.html, served by the Worker for any page that isn't there): what was asked for,
// a guess at what was meant, and a small Genji Ball to play while here. As in the game, a homing ball
// chases you and the only way to live is to deflect it. Loaded after site.js, whose helpers it uses.
"use strict";

// ---- What was meant ----

// The site's pages, with the other names people try for them.
const pages = [
  { href: "/", label: "Leaderboard", names: ["leaderboard", "leaderboards", "ladder", "board", "rankings", "ranking", "ranked", "rank", "home", "index", "players", "top"] },
  { href: "/live", label: "Live", names: ["live", "lobbies", "lobby", "now", "games"] },
  { href: "/records", label: "Records", names: ["records", "record", "stats", "statistics", "bests"] },
  { href: "/tourneys", label: "Tourneys", names: ["tourneys", "tourney", "tournaments", "tournament", "events", "cups"] },
  { href: "/compare", label: "Compare players", names: ["compare", "versus", "vs", "head-to-head", "h2h"] },
];

// Edits (insert, delete, swap a letter, or swap two neighbours) from a to b.
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function guesses(path) {
  const parts = path
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .map((part) => part.trim())
    .filter(Boolean);
  const first = (parts[0] ?? "").toLowerCase().replace(/\.html?$/, "");
  const out = [];
  // /player/Name, /u/Name and the like: someone looking for a player, not a page.
  const forPlayer = /^(player|players|profile|user|u|p)$/i.test(parts[0] ?? "") && parts.length > 1;

  // The closest page by name, if it's close enough to be a typo rather than a different word.
  let best;
  for (const page of forPlayer ? [] : pages) {
    for (const name of page.names) {
      const d = distance(first, name);
      if (d <= Math.max(1, Math.floor(name.length / 3)) && (!best || d < best.d)) best = { page, d };
    }
  }
  if (best) out.push(`Did you mean <a href="${best.page.href}">${esc(best.page.label)}</a>?`);

  // That, /@Name or just /Name: a player, most likely. Search the board for them.
  const name = forPlayer ? parts[1] : parts.length === 1 && !best ? parts[0].replace(/^@/, "") : null;
  if (name && name.length <= 32 && !/\.\w{2,4}$/.test(name)) {
    out.push(`<a href="/?q=${encodeURIComponent(name)}">Search for “${esc(name)}”</a>`);
  }
  return out;
}

{
  const path = location.pathname;
  $("lost-path").textContent = path.length > 60 ? `${path.slice(0, 57)}…` : path;
  $("lost-path").title = path;
  const list = guesses(path);
  if (list.length) {
    $("lost-guess").innerHTML = list.map((line) => `<li>${line}</li>`).join("");
    $("lost-guess").hidden = false;
  }
}

// ---- Survive the ball ----

// The feel. Distances in CSS pixels, times in seconds, angles in radians.
const tune = {
  playerRadius: 11,
  ballRadius: 13,
  // Reach of a deflect, beyond touching.
  deflectReach: 26,
  // As in the game: a deflect and its lockout take 0.8 s together.
  deflectTime: 0.3,
  deflectCooldown: 0.5,
  // The ball's start, and what each deflect adds.
  startSpeed: 190,
  speedGain: 1.075,
  maxSpeed: 900,
  startTurn: 2.4,
  turnGain: 1.04,
  maxTurn: 6,
  // After a deflect it flies straight for a moment before it homes in again.
  freeFlight: 0.42,
  // How fast you follow the pointer, and move on the arrow keys.
  playerSpeed: 640,
  keySpeed: 360,
  trail: 18,
};

const arena = $("arena");
const canvas = $("arena-canvas");
const ctx = canvas.getContext("2d");
const overlay = $("arena-overlay");
const bestKey = "lost:best";

let width = 0;
let height = 0;
let colors = {};
let state = "idle"; // idle, playing, paused, over
let best = Number(remembered("localStorage", bestKey)) || 0;
let deflects = 0;
let shake = 0;
let flash = 0;
let last = 0;
let frame = 0;
let onScreen = true;

const player = { x: 0, y: 0, tx: 0, ty: 0, deflect: 0, cooldown: 0, swing: 0 };
const ball = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, turn: 0, free: 0, trail: [] };
const keys = new Set();
let sparks = [];
let pops = [];

$("lost-best").textContent = best;

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  colors = { accent: get("--accent"), ball: get("--good"), bad: get("--bad"), fg: get("--fg"), soft: get("--soft"), line: get("--line"), border: get("--border"), bg: get("--bg"), panel: get("--panel") };
}

// A colour from the stylesheet (#rgb or #rrggbb), see-through by `alpha`.
function fade(hex, alpha) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function resize() {
  const box = arena.getBoundingClientRect();
  const was = { width, height };
  width = Math.round(box.width);
  height = Math.round(box.height);
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  // Keep everyone where they were, in proportion.
  if (was.width && was.height) {
    for (const thing of [player, ball]) {
      thing.x *= width / was.width;
      thing.y *= height / was.height;
    }
    player.tx = player.x;
    player.ty = player.y;
  } else {
    place();
  }
  if (state !== "playing") draw(0);
}

// Everyone back to the start: you in the middle, the ball in a far corner.
function place() {
  player.x = player.tx = width / 2;
  player.y = player.ty = height / 2;
  player.deflect = player.cooldown = player.swing = 0;
  const corner = Math.floor(Math.random() * 4);
  ball.x = corner % 2 ? width - 40 : 40;
  ball.y = corner > 1 ? height - 40 : 40;
  const angle = Math.atan2(player.y - ball.y, player.x - ball.x) + (Math.random() - 0.5) * 1.6;
  ball.speed = tune.startSpeed;
  ball.turn = tune.startTurn;
  ball.vx = Math.cos(angle) * ball.speed;
  ball.vy = Math.sin(angle) * ball.speed;
  ball.free = 0.6;
  ball.trail = [];
  sparks = [];
  pops = [];
}

function setDeflects(n) {
  deflects = n;
  $("lost-deflects").textContent = n;
}

function start() {
  place();
  setDeflects(0);
  state = "playing";
  overlay.hidden = true;
  arena.classList.add("playing");
  canvas.focus({ preventScroll: true });
  run();
}

function pause() {
  if (state !== "playing") return;
  state = "paused";
  show("Paused.", `${deflects} so far.`, "Resume");
}

function resume() {
  state = "playing";
  overlay.hidden = true;
  canvas.focus({ preventScroll: true });
  run();
}

function eliminated() {
  state = "over";
  arena.classList.remove("playing");
  burst(player.x, player.y, colors.bad, 46, 420);
  shake = calm() ? 0 : 14;
  flash = 1;
  const record = deflects > best;
  if (record) {
    best = deflects;
    remember("localStorage", bestKey, String(best));
    $("lost-best").textContent = best;
  }
  const said = `Eliminated. ${deflects} ${deflects === 1 ? "deflect" : "deflects"}.`;
  // Let the burst play out before the card covers it.
  setTimeout(() => show(said, record && deflects > 0 ? "New best!" : `Best: ${best}`, "Play again"), 650);
}

function show(title, sub, button) {
  $("arena-title").textContent = title;
  $("arena-sub").textContent = sub;
  $("arena-start").textContent = button;
  overlay.hidden = false;
  $("arena-start").focus({ preventScroll: true });
}

function deflect() {
  if (state !== "playing" || player.deflect > 0 || player.cooldown > 0) return;
  player.deflect = tune.deflectTime;
  player.swing = 1;
}

function burst(x, y, color, count, speed) {
  if (calm()) count = Math.ceil(count / 4);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.25 + Math.random() * 0.75);
    sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4 + Math.random() * 0.5, age: 0, color });
  }
}

function update(dt) {
  // You: towards the pointer, or along the arrow keys.
  const kx = (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
  const ky = (keys.has("ArrowDown") ? 1 : 0) - (keys.has("ArrowUp") ? 1 : 0);
  if (kx || ky) {
    const n = Math.hypot(kx, ky);
    player.tx = player.x + (kx / n) * tune.keySpeed * dt;
    player.ty = player.y + (ky / n) * tune.keySpeed * dt;
  }
  const pad = tune.playerRadius + 4;
  player.tx = Math.min(width - pad, Math.max(pad, player.tx));
  player.ty = Math.min(height - pad, Math.max(pad, player.ty));
  const dx = player.tx - player.x;
  const dy = player.ty - player.y;
  const gap = Math.hypot(dx, dy);
  const step = Math.min(gap, tune.playerSpeed * dt);
  if (gap > 0) {
    player.x += (dx / gap) * step;
    player.y += (dy / gap) * step;
  }

  if (player.deflect > 0) {
    player.deflect -= dt;
    if (player.deflect <= 0) player.cooldown = tune.deflectCooldown;
  } else if (player.cooldown > 0) {
    player.cooldown = Math.max(0, player.cooldown - dt);
  }
  player.swing = Math.max(0, player.swing - dt * 3.2);

  // The ball: homing in on you, turning at most `turn` a second.
  const toX = player.x - ball.x;
  const toY = player.y - ball.y;
  const apart = Math.hypot(toX, toY);
  if (ball.free > 0) {
    ball.free -= dt;
  } else {
    const heading = Math.atan2(ball.vy, ball.vx);
    let wanted = Math.atan2(toY, toX) - heading;
    wanted = Math.atan2(Math.sin(wanted), Math.cos(wanted));
    const turned = heading + Math.max(-ball.turn * dt, Math.min(ball.turn * dt, wanted));
    ball.vx = Math.cos(turned) * ball.speed;
    ball.vy = Math.sin(turned) * ball.speed;
  }
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  // Off the walls.
  const r = tune.ballRadius;
  if (ball.x < r || ball.x > width - r) {
    ball.vx *= -1;
    ball.x = Math.min(width - r, Math.max(r, ball.x));
    burst(ball.x, ball.y, colors.border, 5, 120);
  }
  if (ball.y < r || ball.y > height - r) {
    ball.vy *= -1;
    ball.y = Math.min(height - r, Math.max(r, ball.y));
    burst(ball.x, ball.y, colors.border, 5, 120);
  }
  ball.trail.unshift({ x: ball.x, y: ball.y });
  ball.trail.length = Math.min(ball.trail.length, tune.trail);

  // A deflect in time sends it back where it came from, faster. Too late, and you're out.
  const touch = tune.playerRadius + tune.ballRadius;
  if (player.deflect > 0 && apart < touch + tune.deflectReach && ball.free <= 0.3) {
    const away = Math.atan2(-toY, -toX) + (Math.random() - 0.5) * 0.7;
    ball.speed = Math.min(tune.maxSpeed, ball.speed * tune.speedGain);
    ball.turn = Math.min(tune.maxTurn, ball.turn * tune.turnGain);
    ball.vx = Math.cos(away) * ball.speed;
    ball.vy = Math.sin(away) * ball.speed;
    ball.free = tune.freeFlight;
    // A clean deflect gives the cooldown back at once, as a reward.
    player.deflect = 0;
    player.cooldown = 0.12;
    setDeflects(deflects + 1);
    burst(ball.x, ball.y, colors.accent, 22, 320);
    pops.push({ x: ball.x, y: ball.y - 18, age: 0, text: `+${deflects}` });
    shake = calm() ? 0 : 5;
    flash = 0.5;
  } else if (apart < touch) {
    eliminated();
  }
}

function age(dt) {
  for (const s of sparks) {
    s.age += dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx *= 1 - 2.5 * dt;
    s.vy *= 1 - 2.5 * dt;
  }
  sparks = sparks.filter((s) => s.age < s.life);
  for (const p of pops) p.age += dt;
  pops = pops.filter((p) => p.age < 0.8);
  shake = Math.max(0, shake - dt * 40);
  flash = Math.max(0, flash - dt * 2.5);
}

// The ball as the site's mark: the green disc with its slice, the slice along the way it's going.
function drawBall(x, y, angle, alpha = 1) {
  const r = tune.ballRadius;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.shadowColor = colors.ball;
  ctx.shadowBlur = state === "playing" ? 18 : 10;
  ctx.fillStyle = colors.ball;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineWidth = r * 0.27;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-r * 1.2, 0);
  ctx.lineTo(r * 1.2, 0);
  ctx.stroke();
  ctx.restore();
}

function draw(dt) {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  if (shake) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

  // The floor: a faint grid, brighter round you.
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const cell = 32;
  for (let x = (width % cell) / 2; x < width; x += cell) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = (height % cell) / 2; y < height; y += cell) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();
  const glow = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, 180);
  glow.addColorStop(0, fade(colors.accent, 0.1));
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Its lock on you: a dashed line while it homes in.
  if (state === "playing" && ball.free <= 0) {
    ctx.save();
    ctx.setLineDash([4, 7]);
    ctx.lineDashOffset = -performance.now() / 30;
    ctx.strokeStyle = fade(colors.bad, 0.45);
    ctx.beginPath();
    ctx.moveTo(ball.x, ball.y);
    ctx.lineTo(player.x, player.y);
    ctx.stroke();
    ctx.restore();
  }

  // Trail, then the ball.
  const heading = Math.atan2(ball.vy, ball.vx);
  ball.trail.forEach((t, i) => {
    const k = 1 - i / tune.trail;
    ctx.fillStyle = fade(colors.ball, k * 0.35);
    ctx.beginPath();
    ctx.arc(t.x, t.y, tune.ballRadius * (0.35 + 0.6 * k), 0, Math.PI * 2);
    ctx.fill();
  });
  drawBall(ball.x, ball.y, heading);

  // You, unless you've just been eliminated.
  if (state !== "over") {
    const r = tune.playerRadius;
    // The deflect: a bright shield, and the blade's sweep.
    if (player.deflect > 0) {
      ctx.save();
      ctx.shadowColor = colors.accent;
      ctx.shadowBlur = 20;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(player.x, player.y, r + tune.deflectReach * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (player.swing > 0) {
      const a = heading + Math.PI + (1 - player.swing) * Math.PI * 1.6 - 0.8;
      ctx.save();
      ctx.globalAlpha = player.swing;
      ctx.strokeStyle = colors.fg;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(player.x, player.y, r + tune.deflectReach * 0.55, a - 1.1, a);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = colors.panel;
    ctx.strokeStyle = colors.fg;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(player.x, player.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // The visor: a little line facing the ball.
    const look = Math.atan2(ball.y - player.y, ball.x - player.x);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(player.x, player.y, r * 0.5, look - 0.7, look + 0.7);
    ctx.stroke();
    // The cooldown, filling back up round you.
    if (player.cooldown > 0) {
      ctx.strokeStyle = colors.border;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(player.x, player.y, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - player.cooldown / tune.deflectCooldown));
      ctx.stroke();
    }
  }

  for (const s of sparks) {
    ctx.globalAlpha = 1 - s.age / s.life;
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
  ctx.font = "700 18px Saira, system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const p of pops) {
    ctx.globalAlpha = 1 - p.age / 0.8;
    ctx.fillStyle = colors.accent;
    ctx.fillText(p.text, p.x, p.y - p.age * 40);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  if (flash) {
    ctx.fillStyle = fade(state === "over" ? colors.bad : colors.accent, flash * 0.12);
    ctx.fillRect(0, 0, width, height);
  }
  if (dt) age(dt);
}

// Before a game: the ball drifts about the arena on its own.
function idle(dt) {
  ball.free = 1;
  ball.x += ball.vx * dt * 0.4;
  ball.y += ball.vy * dt * 0.4;
  const r = tune.ballRadius;
  if (ball.x < r || ball.x > width - r) ball.vx *= -1;
  if (ball.y < r || ball.y > height - r) ball.vy *= -1;
  ball.x = Math.min(width - r, Math.max(r, ball.x));
  ball.y = Math.min(height - r, Math.max(r, ball.y));
  ball.trail.unshift({ x: ball.x, y: ball.y });
  ball.trail.length = Math.min(ball.trail.length, tune.trail);
}

function tick(now) {
  frame = 0;
  // A long gap (a stalled tab) counts as one short step, not a jump through the walls.
  const dt = Math.min(0.033, (now - (last || now)) / 1000);
  last = now;
  if (state === "playing") update(dt);
  else if (state === "idle" && !calm()) idle(dt);
  draw(dt);
  if (onScreen && !document.hidden && (state === "playing" || (state === "idle" && !calm()) || sparks.length || shake || flash)) {
    frame = requestAnimationFrame(tick);
  }
}

// Start drawing again after a stop: the first frame measures no time, so nothing jumps.
function run() {
  if (frame) return;
  last = 0;
  frame = requestAnimationFrame(tick);
}

// ---- Input ----

function aim(e) {
  const box = canvas.getBoundingClientRect();
  player.tx = e.clientX - box.left;
  player.ty = e.clientY - box.top;
}
canvas.addEventListener("pointermove", (e) => {
  if (state === "playing") aim(e);
});
canvas.addEventListener("pointerdown", (e) => {
  if (state !== "playing") return;
  // A tap on a phone moves you there and deflects; a click only deflects.
  if (e.pointerType !== "mouse") aim(e);
  deflect();
});
canvas.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    if (state === "playing") deflect();
    else $("arena-start").click();
  } else if (e.key.startsWith("Arrow")) {
    e.preventDefault();
    keys.add(e.key);
  } else if (e.key === "Escape" || e.key === "p") {
    pause();
  }
});
canvas.addEventListener("keyup", (e) => keys.delete(e.key));
canvas.addEventListener("blur", () => keys.clear());
$("arena-start").addEventListener("click", () => (state === "paused" ? resume() : start()));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});
new IntersectionObserver(([entry]) => {
  onScreen = entry.isIntersecting;
  if (!onScreen) pause();
  else run();
}).observe(arena);
new ResizeObserver(resize).observe(arena);
// The region's colour is the deflect's: EU green, NA gold.
site.watch(() => {
  readColors();
  if (state !== "playing") draw(0);
});

readColors();
document.fonts?.ready.then(() => state !== "playing" && draw(0));
run();
