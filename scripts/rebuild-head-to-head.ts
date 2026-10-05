// Rebuilds the head-to-head records (#18), a range at a time (docs/database.md, "Match stats and
// head-to-head"). Uploads and admin actions keep them up to date; this is for fixes:
//   npm run rebuild:head-to-head -- <first match id> <last match id>
//     re-derives those matches' pairs from their rounds and events, after a fix to how pairs are
//     counted. The totals follow through the triggers.
//   npm run rebuild:head-to-head -- --totals <first player id> <last player id>
//     recomputes those players' totals from the stored pairs, when the totals went wrong. Every run
//     reads all of match_pairs and pair_stats whatever the range (neither is indexed by player), so
//     use ranges as big as the day's writes allow: two rows written per pair_stats row of the range.
// Each run is one range, right once it ran, so a rebuild can stop and resume at any range. Writes the
// SQL to a file and prints the wrangler command to run it, as `admin:token` does. Bundled by esbuild
// (see package.json), so it can import src/.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildPairsStatements, rebuildTotalsStatements } from "../src/upload/pairs";

const args = process.argv.slice(2);
const totals = args[0] === "--totals";
const range = totals ? args.slice(1) : args;
if (range.length !== 2 || !range.every((a) => /^[1-9]\d{0,15}$/.test(a)) || Number(range[0]) > Number(range[1])) {
  console.error(
    "Usage: npm run rebuild:head-to-head -- <first match id> <last match id>\n" +
      "       npm run rebuild:head-to-head -- --totals <first player id> <last player id>\n" +
      "         (each --totals run reads all of match_pairs and pair_stats: use big ranges)",
  );
  process.exit(1);
}
const [from, to] = range.map(Number) as [number, number];
const statements = totals ? rebuildTotalsStatements(from, to) : rebuildPairsStatements(from, to);

const file = join(tmpdir(), `genjiball-head-to-head-${totals ? "totals" : "matches"}-${from}-${to}.sql`);
writeFileSync(file, statements.map((s) => `${s};\n`).join(""));
console.log("Run it (--local for npm run dev, --remote --env test for the test server, --remote for production):\n");
console.log(`  npx wrangler d1 execute DB --remote --file "${file}"\n`);
