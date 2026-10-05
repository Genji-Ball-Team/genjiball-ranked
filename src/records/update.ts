import type { QueryBudget } from "../budget";
import type { Logger } from "../log";
import { isoSeconds } from "../time";
import { activityStart, matchStats, recordsView, type RecordsConfig } from "./stats";
import {
  isCursorConflict,
  readFeedChanges,
  readMatchCounts,
  readRecordsInput,
  readRecordsState,
  syncStatements,
  writeRecordsStatement,
  type RecordsState,
} from "./store";

/**
 * Keeps the records pages up to date (#19, docs/database.md "Records"), on the cron after the
 * ratings:
 *
 * - `syncMatchStats` follows the match feed: a match that's accepted gets its `match_stats` row
 *   (re)computed, any other loses it. At most `recordsMatchesPerRun` matches a run; resetting
 *   `records_state.feed_cursor` to 0 rebuilds them all from the stored rounds and events. A match
 *   that stops being accepted, or moves region, is handled at once by a trigger (0015).
 * - `refreshRecords` rebuilds one region's stored page a run: at once after a match left its
 *   records, else when its stats or ratings changed or a new day started, at most every
 *   `recordsRefreshMinutes`.
 */

const minuteMs = 60 * 1000;

/** The most D1 queries a `syncMatchStats` makes: the feed, 4 counts, a batch of 5. */
export const syncQueries = 10;
/** The most a `refreshRecords` makes: the regions' state, 3 reads, the write. */
export const refreshQueries = 5;

/** Returns how many feed changes it handled; 0 when there were none, or another run came first. */
export async function syncMatchStats(db: D1Database, config: RecordsConfig, log: Logger): Promise<number> {
  const { cursor, matches } = await readFeedChanges(db, config.recordsMatchesPerRun);
  if (!matches.length) return 0;
  const accepted = matches.filter((m) => m.status === "accepted");
  const counts = await readMatchCounts(db, accepted.map((m) => m.id));
  const stats = matchStats(accepted, counts);
  const changed = matches.map((m) => m.id);
  const regions = [...new Set(matches.map((m) => m.region))];
  const to = matches.at(-1)!.seq;
  try {
    await db.batch(syncStatements(db, cursor, to, changed, stats, regions));
  } catch (error) {
    if (!isCursorConflict(error)) throw error;
    log.info("match stats: another run moved the cursor first", { from: cursor });
    return 0;
  }
  log.info("match stats", { counted: stats.length, changed: changed.length, cursor: to });
  return matches.length;
}

/** Whether a region's stored records should be rebuilt now. */
export function isDue(state: RecordsState, config: Pick<RecordsConfig, "recordsRefreshMinutes">, now: Date): boolean {
  if (state.refreshedAt === null || state.builtRevision === null) return true;
  // A match the page may name left the region's records: no waiting.
  if (state.builtRevision < state.urgent) return true;
  if (now.getTime() - Date.parse(state.refreshedAt) < config.recordsRefreshMinutes * minuteMs) return false;
  const newDay = state.refreshedAt.slice(0, 10) !== isoSeconds(now).slice(0, 10);
  return state.builtRevision < state.revision || state.ratingVersion !== state.version || newDay;
}

/** Rebuilds the stored records of the region that's waited longest. Returns its id, or null. */
export async function refreshRecords(db: D1Database, config: RecordsConfig, now: Date, log: Logger): Promise<string | null> {
  const states = await readRecordsState(db, config.regions.map((r) => r.id));
  const urgent = (s: RecordsState) => (s.builtRevision === null || s.builtRevision < s.urgent ? 0 : 1);
  const due = states
    .filter((s) => isDue(s, config, now))
    .sort((a, b) => urgent(a) - urgent(b) || (a.refreshedAt ?? "").localeCompare(b.refreshedAt ?? ""))[0];
  if (!due) return null;
  await rebuildRecords(db, config, due.region, due.revision, due.version, now);
  log.info("records refreshed", { region: due.region, revision: due.revision });
  return due.region;
}

/**
 * Rebuilds one region's stored records page now, from `revision` and `ratingVersion`, read before
 * the data: a change made meanwhile has a newer revision, so the page stays due.
 */
export async function rebuildRecords(
  db: D1Database,
  config: RecordsConfig,
  region: string,
  revision: number,
  ratingVersion: number,
  now: Date,
): Promise<void> {
  const input = await readRecordsInput(db, region, activityStart(now, config.recordsActivityDays), config.recordsTopHosts);
  await writeRecordsStatement(db, region, recordsView(input, config, now), isoSeconds(now), revision, ratingVersion).run();
}

/**
 * The cron's records work: the match stats, then one region's page. With `queries`, each step runs
 * only if it fits in what's left of the invocation's D1 queries; the rest waits for the next run.
 */
export async function updateRecords(db: D1Database, config: RecordsConfig, now: Date, log: Logger, queries?: QueryBudget): Promise<void> {
  const fits = (most: number) => !queries || queries.left() >= most;
  if (!fits(syncQueries)) {
    log.info("records deferred: out of D1 queries for this run");
    return;
  }
  await syncMatchStats(db, config, log);
  if (!fits(refreshQueries)) {
    log.info("records refresh deferred: out of D1 queries for this run");
    return;
  }
  await refreshRecords(db, config, now, log);
}
