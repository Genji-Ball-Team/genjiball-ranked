// Tunes the rating config on real logs, offline (docs/rating.md, "Tuning"):
// `npm run tune:rating -- <log folder>` scores the current config, `npm run tune:rating -- <log folder> --grid`
// sweeps damping, beta and tau. Only legacy v1.3.2 logs for now. It replays the files through the real
// parser and engine, with the copies of a match left out as `npm run import:legacy` does, oldest first.
// Bundled by esbuild (see package.json), so it can import src/ directly.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defaults } from "../src/config";
import { parseLegacyLog } from "../src/parser/legacy";
import { displayRating, newRating, rateRound, type RatingConfig, type Ratings } from "../src/rating/engine";

/** Prediction is scored on the newest share of rounds only, so the ratings have had the older ones to learn from. */
const scoredShare = 0.4;
/** ...and only on rounds where every player had this many rated rounds before. */
const warmRounds = 20;
/** Movement is measured for players with at least this many rated rounds before the match. */
const regularRounds = 50;
/** The display scales the report compares, to see how many players each would put in every tier. */
const scalesToTry = [40, 50, 60, 70, 80, 90, 100];

const [dir, ...flags] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: npm run tune:rating -- <log folder> [--grid]");
  process.exit(1);
}

// --- The matches, as the server would rate them ---------------------------------------------------

const startedAt = (file: string) => {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(basename(file));
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime() : 0;
};
const killLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[\d+:\d{2}:\d{2}\] ?/, "").trim())
    .filter((line) => line.startsWith("KILL|"));

const logs = readdirSync(dir)
  .filter((name) => name.toLowerCase().endsWith(".txt"))
  .map((name) => {
    const text = readFileSync(join(dir, name), "utf8");
    return { text, started: startedAt(name), kills: killLines(text) };
  })
  .sort((a, b) => a.started - b.started);
const isCopy = (log: (typeof logs)[number]) =>
  logs.some(
    (other) =>
      other !== log &&
      (other.kills.length > log.kills.length || (other.kills.length === log.kills.length && logs.indexOf(other) > logs.indexOf(log))) &&
      log.kills.every((line, i) => other.kills[i] === line),
  );

const playerIds = new Map<string, number>();
const names: string[] = [];
const playerId = (name: string) => {
  const key = name.toLowerCase(); // nameKey in src/upload/plan.ts
  if (!playerIds.has(key)) playerIds.set(key, names.push(name) - 1);
  return playerIds.get(key)!;
};

/** Each match is its rated rounds' finishing orders, winner first. */
const matches: number[][][] = [];
for (const log of logs) {
  if (!log.kills.length || isCopy(log)) continue;
  const match = parseLegacyLog(log.text, {
    botNames: defaults.legacyBotNames,
    gameVersion: defaults.legacyGameVersion,
    roundGapSeconds: defaults.legacyRoundGapSeconds,
    resurrectSeconds: defaults.legacyResurrectSeconds,
  });
  if (!match) continue;
  const nameOf = new Map(match.players.map((p) => [p.id, p.name]));
  const rounds = match.rounds
    .filter((round) => round.finishingOrder && round.finishingOrder.length >= 2)
    .map((round) => round.finishingOrder!.map((id) => playerId(nameOf.get(id)!)));
  if (new Set(rounds.flat()).size >= defaults.minMatchPlayers) matches.push(rounds);
}
const totalRounds = matches.reduce((sum, rounds) => sum + rounds.length, 0);
console.log(`${matches.length} matches, ${totalRounds} rated rounds, ${new Set(matches.flat(2)).size} players\n`);

// --- Scoring a config -----------------------------------------------------------------------------

/** What the leaderboard shows, so movement is what a player sees (eased near the floor). */
const shown = (r: { mu: number; sigma: number }, c: RatingConfig) => displayRating(r, c);

/**
 * Replays every match. Before each round is rated, its finishing order is scored with the ratings so
 * far: the Plackett-Luce log-likelihood openskill's model gives it, minus that of a random order.
 * Higher `prediction` (nats per round) is better. `move` is how far a regular's display rating moves
 * in one match: the median and the 90th percentile.
 */
function score(config: RatingConfig) {
  const ratings: Ratings = new Map();
  let gain = 0;
  let scored = 0;
  let index = 0;
  const moves: number[] = [];
  for (const rounds of matches) {
    const before = new Map<number, { display: number; rounds: number }>();
    for (const order of rounds) {
      const current = order.map((id) => ratings.get(id) ?? newRating(config));
      order.forEach((id, i) => {
        if (!before.has(id)) before.set(id, { display: shown(current[i]!, config), rounds: current[i]!.rounds });
      });
      if (index++ >= totalRounds * (1 - scoredShare) && current.every((r) => r.rounds >= warmRounds)) {
        const c = Math.sqrt(current.reduce((sum, r) => sum + r.sigma ** 2 + config.ratingBeta ** 2, 0));
        const strengths = current.map((r) => Math.exp(r.mu / c));
        let rest = strengths.reduce((a, b) => a + b, 0);
        for (let i = 0; i < strengths.length - 1; i++) {
          gain += Math.log(strengths[i]! / rest) + Math.log(strengths.length - i);
          rest -= strengths[i]!;
        }
        scored++;
      }
      rateRound(ratings, order, config);
    }
    for (const [id, was] of before) {
      if (was.rounds >= regularRounds) moves.push(Math.abs(shown(ratings.get(id)!, config) - was.display));
    }
  }
  moves.sort((a, b) => a - b);
  // "n/a" rather than NaN or 0 when too few rounds or regulars were measured.
  const at = (q: number) => (moves.length ? String(Math.round(moves[Math.floor(moves.length * q)]!)) : "n/a");
  return { ratings, prediction: scored ? (gain / scored).toFixed(3) : "n/a", scored, moveMedian: at(0.5), moveP90: at(0.9) };
}

const pad = (value: unknown, width: number) => String(value).padStart(width);

if (flags.includes("--grid")) {
  console.log(`  N   beta    tau  prediction  move median  move p90`);
  for (const ratingRoundsPerMatch of [1, 2, 3, 5, 7, 10, 15, 20])
    for (const ratingBeta of [25 / 12, 25 / 6, 25 / 3])
      for (const ratingTau of [0, 25 / 300, 25 / 100]) {
        const s = score({ ...defaults, ratingRoundsPerMatch, ratingBeta, ratingTau });
        console.log(
          `${pad(ratingRoundsPerMatch, 3)} ${pad(ratingBeta.toFixed(2), 6)} ${pad(ratingTau.toFixed(3), 6)} ${pad(s.prediction, 11)} ${pad(s.moveMedian, 12)} ${pad(s.moveP90, 9)}`,
        );
      }
  process.exit(0);
}

// --- The current config, and how the display scale changes the tiers ---------------------------------

const s = score(defaults);
console.log(
  `N ${defaults.ratingRoundsPerMatch}, beta ${defaults.ratingBeta.toFixed(2)}, tau ${defaults.ratingTau.toFixed(3)}: ` +
    `prediction ${s.prediction} over ${s.scored} rounds, move median ${s.moveMedian}, p90 ${s.moveP90}\n`,
);

const ranked = [...s.ratings.entries()]
  .filter(([, r]) => r.rounds >= defaults.minRankedRounds)
  .map(([id, r]) => ({ name: names[id]!, ...r }))
  .sort((a, b) => displayRating(b, defaults) - displayRating(a, defaults));

/** Players in each tier (not "at or above"), highest tier first. */
const tiersHighFirst = [...defaults.tiers].reverse();
const counts = (config: RatingConfig) => {
  const shownRatings = ranked.map((p) => displayRating(p, config));
  return tiersHighFirst.map((tier, i) => {
    const next = tiersHighFirst[i - 1]?.threshold ?? Infinity;
    return shownRatings.filter((d) => d >= tier.threshold && d < next).length;
  });
};

const row = (label: string, n: (number | string)[]) =>
  console.log(`${label.padEnd(36)}${n.map((v, i) => pad(v, tiersHighFirst[i]!.label.length + 2)).join("")}`);
console.log(`Players with ${defaults.minRankedRounds}+ rated rounds: ${ranked.length}, in each tier`);
row("", tiersHighFirst.map((t) => t.label));
row(`scale ${defaults.displayScale} (config)`, counts(defaults));
for (const displayScale of scalesToTry) row(`scale ${displayScale}`, counts({ ...defaults, displayScale }));

console.log(`\nTop 30 with the config's display rating:`);
ranked.slice(0, 30).forEach((p, i) => {
  console.log(
    `${pad(i + 1, 3)}  ${p.name.padEnd(18)}${pad(displayRating(p, defaults), 6)}   mu ${p.mu.toFixed(1)} ± ${p.sigma.toFixed(1)}, ${p.rounds} rounds, ${Math.round((100 * p.wins) / p.rounds)}% won`,
  );
});
