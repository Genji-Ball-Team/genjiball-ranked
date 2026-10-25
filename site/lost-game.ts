// "Survive the ball", the small game on the 404 page (pages/lost.ts). As in the game, a homing ball
// chases you and the only way to live is to deflect it. Distances are in CSS pixels, times in seconds,
// angles in radians. The colours are read from the library's tokens, so nothing here is hard-coded.
import "@genji-ball-team/ui/button.js";
import { byId } from "./lib/html";

// The feel.
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
  // The floor's grid cells.
  cell: 32,
};

type State = "idle" | "playing" | "paused" | "over";
type Palette = Record<"green" | "down" | "fg" | "soft" | "line" | "border" | "panel", string>;
interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number; color: string }
interface Pop { x: number; y: number; age: number; text: string }

const bestKey = "lost:best";

/** Whether motion should be kept small: reduced motion is asked for. */
const calm = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

// The best score, kept in this browser. Storage can be off (private mode), and then it isn't kept.
function remembered(): number {
  try {
    return Number(localStorage.getItem(bestKey)) || 0;
  } catch {
    return 0;
  }
}
function remember(value: number): void {
  try {
    localStorage.setItem(bestKey, String(value));
  } catch {
    // not kept
  }
}

/** A colour from the tokens, see-through by `alpha` (canvas takes any CSS colour, `oklch()` too). */
const fade = (color: string, alpha: number): string => `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;

/** Sets up the game on the page's `#arena` and the score line above it. */
export function playLost(): void {
  const arena = byId("arena");
  const canvas = byId<HTMLCanvasElement>("arena-canvas");
  const overlay = byId("arena-overlay");
  const startButton = byId("arena-start");
  const title = byId("arena-title");
  const sub = byId("arena-sub");
  const deflectsOut = byId("lost-deflects");
  const bestOut = byId("lost-best");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let width = 0;
  let height = 0;
  let colors: Palette = { green: "", down: "", fg: "", soft: "", line: "", border: "", panel: "" };
  let state: State = "idle";
  let best = remembered();
  let deflects = 0;
  let shake = 0;
  let flash = 0;
  let last = 0;
  let frame = 0;
  let onScreen = true;

  const player = { x: 0, y: 0, tx: 0, ty: 0, deflect: 0, cooldown: 0, swing: 0 };
  const ball = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, turn: 0, free: 0, trail: [] as { x: number; y: number }[] };
  const keys = new Set<string>();
  let sparks: Spark[] = [];
  let pops: Pop[] = [];

  bestOut.textContent = String(best);

  function readColors(): void {
    const css = getComputedStyle(document.documentElement);
    const get = (name: string) => css.getPropertyValue(`--${name}`).trim();
    colors = { green: get("green"), down: get("down"), fg: get("fg"), soft: get("soft"), line: get("line"), border: get("border"), panel: get("panel") };
  }

  function resize(): void {
    const box = arena.getBoundingClientRect();
    const was = { width, height };
    width = Math.round(box.width);
    height = Math.round(box.height);
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
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
  function place(): void {
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

  function setDeflects(n: number): void {
    deflects = n;
    deflectsOut.textContent = String(n);
  }

  function begin(): void {
    place();
    setDeflects(0);
    bestOut.removeAttribute("data-record");
    state = "playing";
    overlay.hidden = true;
    arena.classList.add("playing");
    canvas.focus({ preventScroll: true });
    run();
  }

  function pause(): void {
    if (state !== "playing") return;
    state = "paused";
    arena.classList.remove("playing");
    keys.clear();
    show("Paused.", `${deflects} so far.`, "Resume");
  }

  function resume(): void {
    state = "playing";
    overlay.hidden = true;
    arena.classList.add("playing");
    canvas.focus({ preventScroll: true });
    run();
  }

  function eliminated(): void {
    state = "over";
    arena.classList.remove("playing");
    burst(player.x, player.y, colors.down, 46, 420);
    shake = calm() ? 0 : 14;
    flash = 1;
    const record = deflects > best;
    if (record) {
      best = deflects;
      remember(best);
      bestOut.textContent = String(best);
      // A new best is earned, so it's gold.
      bestOut.setAttribute("data-record", "");
    }
    const said = `Eliminated. ${deflects} ${deflects === 1 ? "deflect" : "deflects"}.`;
    // Let the burst play out before the card covers it.
    setTimeout(() => show(said, record && deflects > 0 ? "New best!" : `Best: ${best}`, "Play again", record && deflects > 0), 650);
    run();
  }

  function show(heading: string, text: string, button: string, record = false): void {
    title.textContent = heading;
    sub.textContent = text;
    sub.toggleAttribute("data-record", record);
    startButton.textContent = button;
    overlay.hidden = false;
    startButton.focus({ preventScroll: true });
  }

  function deflect(): void {
    if (state !== "playing" || player.deflect > 0 || player.cooldown > 0) return;
    player.deflect = tune.deflectTime;
    player.swing = 1;
  }

  function burst(x: number, y: number, color: string, count: number, speed: number): void {
    if (calm()) count = Math.ceil(count / 4);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.25 + Math.random() * 0.75);
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4 + Math.random() * 0.5, age: 0, color });
    }
  }

  function update(dt: number): void {
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
      burst(ball.x, ball.y, colors.green, 22, 320);
      pops.push({ x: ball.x, y: ball.y - 18, age: 0, text: `+${deflects}` });
      shake = calm() ? 0 : 5;
      flash = 0.5;
    } else if (apart < touch) {
      eliminated();
    }
  }

  function age(dt: number): void {
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

  // The ball as the logo: a disc with its slice, the slice along the way it's going. Plain `fg`, so
  // the green stays for you and your deflect.
  function drawBall(c: CanvasRenderingContext2D, x: number, y: number, angle: number): void {
    const r = tune.ballRadius;
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.fillStyle = colors.fg;
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = "destination-out";
    c.lineWidth = r * 0.27;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(-r * 1.2, 0);
    c.lineTo(r * 1.2, 0);
    c.stroke();
    c.restore();
  }

  function draw(dt: number): void {
    const c = ctx;
    if (!c) return;
    c.save();
    c.clearRect(0, 0, width, height);
    if (shake) c.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

    // The floor: a faint grid, a little brighter round you.
    c.strokeStyle = colors.line;
    c.lineWidth = 1;
    c.beginPath();
    for (let x = (width % tune.cell) / 2; x < width; x += tune.cell) {
      c.moveTo(x + 0.5, 0);
      c.lineTo(x + 0.5, height);
    }
    for (let y = (height % tune.cell) / 2; y < height; y += tune.cell) {
      c.moveTo(0, y + 0.5);
      c.lineTo(width, y + 0.5);
    }
    c.stroke();
    const glow = c.createRadialGradient(player.x, player.y, 0, player.x, player.y, 180);
    glow.addColorStop(0, fade(colors.green, 0.08));
    glow.addColorStop(1, "transparent");
    c.fillStyle = glow;
    c.fillRect(0, 0, width, height);

    // Its lock on you: a dashed line while it homes in, in `down` like the danger it is.
    if (state === "playing" && ball.free <= 0) {
      c.save();
      c.setLineDash([4, 7]);
      c.lineDashOffset = calm() ? 0 : -performance.now() / 30;
      c.strokeStyle = fade(colors.down, 0.55);
      c.beginPath();
      c.moveTo(ball.x, ball.y);
      c.lineTo(player.x, player.y);
      c.stroke();
      c.restore();
    }

    // Trail, then the ball.
    const heading = Math.atan2(ball.vy, ball.vx);
    ball.trail.forEach((t, i) => {
      const k = 1 - i / tune.trail;
      c.fillStyle = fade(colors.fg, k * 0.25);
      c.beginPath();
      c.arc(t.x, t.y, tune.ballRadius * (0.35 + 0.6 * k), 0, Math.PI * 2);
      c.fill();
    });
    drawBall(c, ball.x, ball.y, heading);

    // You, unless you've just been eliminated.
    if (state !== "over") {
      const r = tune.playerRadius;
      // The deflect: a bright shield, and the blade's sweep.
      if (player.deflect > 0) {
        c.save();
        c.shadowColor = colors.green;
        c.shadowBlur = 16;
        c.strokeStyle = colors.green;
        c.lineWidth = 3;
        c.beginPath();
        c.arc(player.x, player.y, r + tune.deflectReach * 0.8, 0, Math.PI * 2);
        c.stroke();
        c.restore();
      }
      if (player.swing > 0) {
        const a = heading + Math.PI + (1 - player.swing) * Math.PI * 1.6 - 0.8;
        c.save();
        c.globalAlpha = player.swing;
        c.strokeStyle = colors.fg;
        c.lineWidth = 2.5;
        c.lineCap = "round";
        c.beginPath();
        c.arc(player.x, player.y, r + tune.deflectReach * 0.55, a - 1.1, a);
        c.stroke();
        c.restore();
      }
      c.fillStyle = colors.panel;
      c.strokeStyle = colors.soft;
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(player.x, player.y, r, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      // The visor: a little line facing the ball.
      const look = Math.atan2(ball.y - player.y, ball.x - player.x);
      c.strokeStyle = colors.green;
      c.lineWidth = 3;
      c.lineCap = "round";
      c.beginPath();
      c.arc(player.x, player.y, r * 0.5, look - 0.7, look + 0.7);
      c.stroke();
      // The cooldown, filling back up round you.
      if (player.cooldown > 0) {
        c.strokeStyle = colors.border;
        c.lineWidth = 3;
        c.beginPath();
        c.arc(player.x, player.y, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - player.cooldown / tune.deflectCooldown));
        c.stroke();
      }
    }

    for (const s of sparks) {
      c.globalAlpha = 1 - s.age / s.life;
      c.fillStyle = s.color;
      c.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
    }
    c.globalAlpha = 1;
    c.font = "700 18px Saira, system-ui, sans-serif";
    c.textAlign = "center";
    for (const p of pops) {
      c.globalAlpha = 1 - p.age / 0.8;
      c.fillStyle = colors.green;
      c.fillText(p.text, p.x, p.y - p.age * 40);
    }
    c.globalAlpha = 1;
    c.restore();

    if (flash) {
      c.fillStyle = fade(state === "over" ? colors.down : colors.green, flash * 0.1);
      c.fillRect(0, 0, width, height);
    }
    if (dt) age(dt);
  }

  // Before a game: the ball drifts about the arena on its own.
  function idle(dt: number): void {
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

  function tick(now: number): void {
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
  function run(): void {
    if (frame) return;
    last = 0;
    frame = requestAnimationFrame(tick);
  }

  // ---- Input ----

  function aim(e: PointerEvent): void {
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
      else startButton.click();
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      keys.add(e.key);
    } else if (e.key === "Escape" || e.key === "p") {
      pause();
    }
  });
  canvas.addEventListener("keyup", (e) => keys.delete(e.key));
  canvas.addEventListener("blur", () => keys.clear());
  startButton.addEventListener("click", () => (state === "paused" ? resume() : begin()));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
    if (!onScreen) pause();
    else run();
  }).observe(arena);
  new ResizeObserver(resize).observe(arena);

  readColors();
  void document.fonts?.ready.then(() => state !== "playing" && draw(0));
  run();
}
