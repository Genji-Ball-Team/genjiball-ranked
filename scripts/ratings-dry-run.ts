// Dry-run recompute (#33, docs/api.md "Debug tools"): what recomputing a region's ratings from scratch
// would change, writing nothing.
//
//   npm run ratings:dry-run -- --region eu [--local | --remote] [--env test] [--limit 50] [--json diff.json]
//
// It reads the region's accepted matches, their rated rounds and the stored ratings with read-only
// SELECTs through `wrangler d1 execute` (local D1 by default, `--remote` for the deployed one), rates
// them from scratch here with the engine and the config in this checkout, and prints who would move.
// The queries and the logic are the server's (src/rating/dryRun.ts). Bundled by esbuild (see
// package.json), so it can import src/ directly.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defaults } from "../src/config";
import type { PlayerDiff } from "../src/rating/diff";
import { countedMatches, dryRunDiff, dryRunSql, sqlRegion } from "../src/rating/dryRun";
import type { StoredRating } from "../src/rating/plan";
import type { CandidateRow, RoundRow } from "../src/rating/store";

/**
 * Matches whose rounds one query reads: about 225 rows each (rounds and placed players), so 200 is
 * about 45,000 rows and a few MB of JSON per `wrangler d1 execute`.
 */
const defaultChunk = 200;
/** Players printed, the biggest moves first. `--json` writes all of them. */
const defaultLimit = 50;

const usage =
  "Usage: npm run ratings:dry-run -- --region <region> [--local | --remote] [--env <name>] [--limit <n>] [--chunk <n>] [--json <file>]";

function args(argv: string[]) {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[arg.slice(2)] = next;
      i++;
    } else out[arg.slice(2)] = true;
  }
  return out;
}

function positive(value: string | true | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function setup() {
  try {
    const opts = args(process.argv.slice(2));
    if (typeof opts.region !== "string") throw new Error("--region is required");
    if (opts.local && opts.remote) throw new Error("Use --local or --remote, not both");
    return { opts, region: sqlRegion(defaults.regions, opts.region) };
  } catch (error) {
    return die(`${error instanceof Error ? error.message : String(error)}
${usage}`);
  }
}

const { opts, region } = setup();
let chunk: number;
let limit: number;
try {
  chunk = positive(opts.chunk, defaultChunk, "chunk");
  limit = positive(opts.limit, defaultLimit, "limit");
} catch (error) {
  die(`${error instanceof Error ? error.message : String(error)}
${usage}`);
}

// The installed wrangler's CLI (its package exports only package.json, not bin/).
const wranglerPackage = createRequire(import.meta.url).resolve("wrangler/package.json");
const wrangler = join(dirname(wranglerPackage), "bin", "wrangler.js");
const target = [opts.remote ? "--remote" : "--local", ...(typeof opts.env === "string" ? ["--env", opts.env] : [])];
let queries = 0;
/** D1 reports rows read for the remote database; the local one doesn't (stays null). */
let rowsRead: number | null = null;

/** One read-only query through wrangler. */
function query<T>(sql: string): T[] {
  queries++;
  let out: string;
  try {
    out = execFileSync(process.execPath, [wrangler, "d1", "execute", "DB", ...target, "--json", "--command", sql], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    return die(e.stdout || e.stderr || String(error));
  }
  const answer = JSON.parse(out) as { results: T[]; meta?: { rows_read?: number } }[];
  const read = answer[0]?.meta?.rows_read;
  if (read !== undefined) rowsRead = (rowsRead ?? 0) + read;
  return answer[0]?.results ?? [];
}

const now = new Date();
const stale = query<{ playedAt: string | null; id: number | null }>(dryRunSql.stale(region))[0] ?? null;
const accepted = query<CandidateRow>(dryRunSql.matches(region));
const counted = countedMatches(accepted, defaults, now);
const rounds: RoundRow[] = [];
for (let i = 0; i < counted.length; i += chunk) {
  rounds.push(...query<RoundRow>(dryRunSql.rounds(counted.slice(i, i + chunk).map((m) => m.id))));
}
const stored = query<StoredRating & { playerId: number }>(dryRunSql.ratings(region));
const diff = dryRunDiff(counted, rounds, stored, defaults);

const names = new Map<number, string>();
for (let i = 0; i < diff.players.length; i += chunk) {
  const ids = diff.players.slice(i, i + chunk).map((p) => p.playerId);
  for (const p of query<{ id: number; name: string }>(dryRunSql.names(ids))) names.set(p.id, p.name);
}
const players = diff.players.map((p) => ({ ...p, name: names.get(p.playerId) ?? null }));

const report = {
  region,
  database: opts.remote ? "remote" : "local",
  env: typeof opts.env === "string" ? opts.env : null,
  at: now.toISOString(),
  staleFrom: stale?.playedAt == null ? null : { playedAt: stale.playedAt, id: stale.id },
  matches: { accepted: accepted.length, counted: counted.length, unrated: counted.filter((m) => !m.rated).length },
  cost: { queries, rowsRead },
  summary: diff.summary,
  players,
};

const fmtStanding = (s: PlayerDiff["before"]) => (s ? `${s.display} (${s.rank === null ? "unranked" : `#${s.rank}`})` : "none");
console.log(`Dry-run recompute of ${region} (${report.database}${report.env ? `, env ${report.env}` : ""}): nothing was written.`);
console.log(
  `${counted.length} of ${accepted.length} accepted matches count (${report.matches.unrated} not rated yet).` +
    (!report.staleFrom
      ? ""
      : report.staleFrom.playedAt === ""
        ? " Ratings are stale from the start (the cron is recomputing them)."
        : ` Ratings are stale from match ${report.staleFrom.id} (${report.staleFrom.playedAt}).`),
);
const s = diff.summary;
console.log(
  s.identical
    ? `All ${s.players} ratings are exactly what a recompute gives.`
    : `${s.changed} of ${s.players} players would change: ${s.up} up, ${s.down} down, ${s.added} gain a rating, ${s.removed} lose it. ` +
        `Biggest gain ${s.biggestGain}, biggest loss ${s.biggestLoss}.`,
);
if (!s.identical && !s.changed) console.log("(Only mu, sigma or last played moved, not what the leaderboard shows.)");
for (const p of players.slice(0, limit)) {
  const change = p.change === null ? "" : ` ${p.change > 0 ? "+" : ""}${p.change}`;
  const rank = p.rankChange ? `, ${p.rankChange > 0 ? "up" : "down"} ${Math.abs(p.rankChange)}` : "";
  console.log(`  ${(p.name ?? `#${p.playerId}`).padEnd(24)} ${fmtStanding(p.before)} -> ${fmtStanding(p.after)}${change}${rank}`);
}
if (players.length > limit) console.log(`  ... and ${players.length - limit} more (--limit, or --json for all).`);
console.log(`${queries} queries, ${rowsRead === null ? "rows read not reported (local D1)" : `${rowsRead} rows read`}.`);
if (typeof opts.json === "string") {
  writeFileSync(opts.json, JSON.stringify(report, null, 2));
  console.log(`Written to ${opts.json}`);
}
