import type { ActionLog } from "../admin/store";
import type { TourneyStatus } from "./store";

/**
 * Tourney sign-ups' D1 queries (#31, #24): a name signs up once per tourney (`name_key`, lower
 * case); an admin's removal keeps the row (`removed_at`). Counts leave removed ones out.
 */

/** What a sign-up needs to know, read in one query. */
export interface SignupState {
  status: TourneyStatus;
  /** Sign-ups not removed by an admin. */
  count: number;
  /** Every stored sign-up, removed ones included: bounded by `tourneySignupsMax`. */
  stored: number;
  /** The sum of the lobbies' capacities, each its own or `defaultCapacity`. */
  capacity: number;
  /** This name's sign-up, if it has one. */
  existing: { name: string; signedUpAt: string; removed: boolean } | null;
  /** The IP's sign-ups since the rate limit's window began, in any tourney. */
  recent: number;
}

/** The tourney's sign-up state for this name and IP, or null when there's no such tourney. */
export async function readSignupState(
  db: D1Database,
  tourneyId: number,
  nameKey: string,
  ipHash: string,
  since: string,
  defaultCapacity: number,
): Promise<SignupState | null> {
  const row = await db
    .prepare(
      `SELECT t.status,
         (SELECT count(*) FROM tourney_signups WHERE tourney_id = t.id AND removed_at IS NULL) AS count,
         (SELECT count(*) FROM tourney_signups WHERE tourney_id = t.id) AS stored,
         (SELECT coalesce(sum(coalesce(capacity, ?5)), 0) FROM tourney_lobbies WHERE tourney_id = t.id) AS capacity,
         s.name, s.signed_up_at AS signedUpAt, s.removed_at IS NOT NULL AS removed,
         (SELECT count(*) FROM tourney_signups WHERE ip_hash = ?3 AND signed_up_at > ?4) AS recent
       FROM tourneys t LEFT JOIN tourney_signups s ON s.tourney_id = t.id AND s.name_key = ?2
       WHERE t.id = ?1`,
    )
    .bind(tourneyId, nameKey, ipHash, since, defaultCapacity)
    .first<Omit<SignupState, "existing"> & { name: string | null; signedUpAt: string | null; removed: number | null }>();
  if (!row) return null;
  const { name, signedUpAt, removed, ...state } = row;
  return { ...state, existing: name === null ? null : { name, signedUpAt: signedUpAt!, removed: removed === 1 } };
}

/**
 * Stores the sign-up if, at that moment, the tourney is still `scheduled`, has fewer than `max`
 * stored sign-ups and the name hasn't signed up. Returns its time, or null when nothing was written.
 */
export async function insertSignup(
  db: D1Database,
  s: { tourneyId: number; name: string; nameKey: string; ipHash: string; at: string; max: number },
): Promise<string | null> {
  const row = await db
    .prepare(
      `INSERT INTO tourney_signups (tourney_id, name, name_key, ip_hash, signed_up_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM tourneys WHERE id = ?1 AND status = 'scheduled')
         AND (SELECT count(*) FROM tourney_signups WHERE tourney_id = ?1) < ?6
       ON CONFLICT (tourney_id, name_key) DO NOTHING
       RETURNING signed_up_at AS signedUpAt`,
    )
    .bind(s.tourneyId, s.name, s.nameKey, s.ipHash, s.at, s.max)
    .first<{ signedUpAt: string }>();
  return row?.signedUpAt ?? null;
}

/** Sign-ups not removed, per tourney (index `tourney_signups_name`). */
export async function countSignups(db: D1Database, tourneyIds: readonly number[]): Promise<Map<number, number>> {
  if (!tourneyIds.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT tourney_id AS tourneyId, count(*) AS n FROM tourney_signups
       WHERE tourney_id IN (SELECT value FROM json_each(?)) AND removed_at IS NULL GROUP BY tourney_id`,
    )
    .bind(JSON.stringify(tourneyIds))
    .all<{ tourneyId: number; n: number }>();
  return new Map(results.map((r) => [r.tourneyId, r.n]));
}

/** The names signed up for the tourney and not removed, first come first. */
export async function listSignupNames(db: D1Database, tourneyId: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM tourney_signups WHERE tourney_id = ? AND removed_at IS NULL ORDER BY signed_up_at, id")
    .bind(tourneyId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

/** A sign-up as the admin API shows it. Never its IP hash. */
export interface SignupRow {
  id: number;
  tourneyId: number;
  name: string;
  signedUpAt: string;
  removedAt: string | null;
  /** The admin who removed it. */
  removedBy: string | null;
}

const signupColumns = `s.id, s.tourney_id AS tourneyId, s.name, s.signed_up_at AS signedUpAt, s.removed_at AS removedAt, a.name AS removedBy`;
const signupFrom = "tourney_signups s LEFT JOIN admins a ON a.id = s.removed_by";

/** Every sign-up of the tourney, removed ones too, first come first. */
export async function listSignups(db: D1Database, tourneyId: number): Promise<SignupRow[]> {
  const { results } = await db
    .prepare(`SELECT ${signupColumns} FROM ${signupFrom} WHERE s.tourney_id = ? ORDER BY s.signed_up_at, s.id`)
    .bind(tourneyId)
    .all<SignupRow>();
  return results;
}

export async function findSignup(db: D1Database, id: number): Promise<SignupRow | null> {
  return db.prepare(`SELECT ${signupColumns} FROM ${signupFrom} WHERE s.id = ?`).bind(id).first<SignupRow>();
}

/**
 * Removes the sign-up (or restores it), with its `admin_actions` row, in one batch. The action is
 * logged only if the sign-up is still the other way, else NOT NULL fails the batch
 * (`isSignupChanged`): another admin got there first.
 */
export async function setSignupRemoved(db: D1Database, id: number, removed: boolean, log: ActionLog): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO admin_actions (admin_id, action, detail, at)
         VALUES (?1, CASE WHEN EXISTS (SELECT 1 FROM tourney_signups WHERE id = ?5 AND (removed_at IS NULL) = ?6) THEN ?2 END, ?3, ?4)`,
      )
      .bind(log.adminId, log.action, JSON.stringify(log.detail ?? null), log.at, id, removed ? 1 : 0),
    db
      .prepare("UPDATE tourney_signups SET removed_by = ?2, removed_at = ?3 WHERE id = ?1")
      .bind(id, removed ? log.adminId : null, removed ? log.at : null),
  ]);
}

/** Whether a sign-up removal or restore lost a race with another admin's. */
export function isSignupChanged(error: unknown): boolean {
  return /NOT NULL constraint failed: admin_actions\.action/.test(String(error));
}
