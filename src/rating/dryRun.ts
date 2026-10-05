import { findRegion, type Config } from "../config";
import { diffRatings, type RatingDiff } from "./diff";
import { displayRating, recompute, type RatingConfig } from "./engine";
import type { StoredRating } from "./plan";
import { candidateColumns, groupRounds, ratingMatches, roundsSql, toCandidate, type CandidateMatch, type CandidateRow, type RoundRow } from "./store";
import { counts } from "./update";

/**
 * The dry-run recompute (#33): what a recompute of a region from scratch would change, compared
 * with its stored ratings. It runs outside the Worker, in `npm run ratings:dry-run`
 * (`scripts/ratings-dry-run.ts`), because a whole region doesn't fit a Worker's CPU time on the
 * free plan. The script runs these read-only queries through `wrangler d1 execute` (which takes no
 * bound parameters, so values are written into the SQL: the region is checked against the config,
 * ids are numbers) and these functions on what they return. Which matches count, their order and
 * the tournament weighting are the recompute's own (`counts`, `ratingMatches`, `recompute`).
 */

/** The region id, safe to write into SQL: one of the config's `regions`. */
export function sqlRegion(regions: Config["regions"], id: string): string {
  const region = findRegion(regions, id);
  if (!region || !/^[a-z]+$/.test(region.id)) throw new Error(`region must be one of ${regions.map((r) => r.id).join(", ")}`);
  return region.id;
}

const idList = (ids: readonly number[]) => {
  if (!ids.every((id) => Number.isSafeInteger(id))) throw new Error("ids must be integers");
  return `SELECT value FROM json_each('${JSON.stringify(ids)}')`;
};

/** The read-only queries, for a region already checked with `sqlRegion`. */
export const dryRunSql = {
  /** Where the region's ratings are stale from; no row for a region never rated. */
  stale: (region: string) => `SELECT stale_played_at AS playedAt, stale_match_id AS id FROM rating_state WHERE board = '${region}'`,
  /** The region's accepted matches, in play order (index `matches_region_status_played`). */
  matches: (region: string) =>
    `SELECT ${candidateColumns} FROM matches WHERE region = '${region}' AND status = 'accepted' ORDER BY played_at, id`,
  /** The rated finishing orders of these matches (`roundsSql`, as the recompute reads them). */
  rounds: (matchIds: readonly number[]) => roundsSql(idList(matchIds)),
  /** The region's stored ratings. */
  ratings: (region: string) =>
    `SELECT player_id AS playerId, mu, sigma, display, rounds, wins, last_played_at AS lastPlayedAt FROM ratings WHERE board = '${region}'`,
  names: (playerIds: readonly number[]) => `SELECT id, name FROM players WHERE id IN (${idList(playerIds)})`,
};

/** The accepted matches that count now, as the recompute decides: complete, or past the grace period. */
export function countedMatches(rows: readonly CandidateRow[], config: Pick<Config, "ratingIncompleteGraceHours">, now: Date): CandidateMatch[] {
  return rows.map(toCandidate).filter((m) => counts(m, config, now));
}

/** Rates `counted` from scratch and compares with the stored ratings. */
export function dryRunDiff(
  counted: readonly CandidateMatch[],
  roundRows: readonly RoundRow[],
  stored: readonly (StoredRating & { playerId: number })[],
  config: RatingConfig & Pick<Config, "minRankedRounds">,
): RatingDiff {
  const rounds = groupRounds(counted.map((m) => m.id), roundRows);
  const after = new Map<number, StoredRating>(
    [...recompute(ratingMatches(counted, rounds), config).ratings].map(([id, rating]) => [id, { ...rating, display: displayRating(rating, config) }]),
  );
  const before = new Map(stored.map(({ playerId, ...rating }) => [playerId, rating]));
  return diffRatings(before, after, config.minRankedRounds);
}
