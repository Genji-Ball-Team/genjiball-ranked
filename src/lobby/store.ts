/**
 * The live lobbies' D1 queries (#11). One row per host in `live_lobbies`. A heartbeat of an open
 * lobby is one guarded `UPDATE` that doesn't touch `region` (so not its index): one row written. A
 * close sets `closed_at` and keeps the row, so it still holds the time of the last write for the
 * rate limit. The table holds at most one row per host, so a list reads a handful of rows
 * (docs/database.md, "Free tier").
 */

export interface LiveLobby {
  region: string;
  name: string | null;
  players: number;
  openedAt: string;
  seenAt: string;
}

export interface Heartbeat {
  hostId: number;
  region: string;
  name: string | null;
  players: number;
  /** ISO, the heartbeat's time. */
  now: string;
  /** ISO: a lobby last seen at or before this is gone, and this heartbeat opens a new one. */
  staleBefore: string;
  /** ISO: a heartbeat or close after this is too recent for another heartbeat. */
  tooSoonAfter: string;
}

const returning = "RETURNING region, name, players, opened_at AS openedAt, seen_at AS seenAt";

/**
 * Opens or refreshes the host's lobby, and the rows D1 billed as written. `lobby` null, and nothing
 * written, when the last heartbeat or close
 * was too recent (the rate limit).
 *
 * The common case, an open lobby in the same region, is an `UPDATE` that doesn't SET `region`:
 * SQLite rewrites an index entry for every indexed column in the SET, even to the same value, and D1
 * bills that as a row written. Only when that changes nothing (no row, closed, stale, another region
 * or too soon) does the upsert run, which opens a new lobby (`opened_at` starts again) unless it's
 * too soon.
 */
export async function upsertLobby(db: D1Database, h: Heartbeat): Promise<{ lobby: LiveLobby | null; rowsWritten: number }> {
  const refreshed = await db
    .prepare(
      `UPDATE live_lobbies SET name = ?3, players = ?4, seen_at = ?5
       WHERE host_id = ?1 AND region = ?2 AND closed_at IS NULL AND seen_at > ?6 AND seen_at <= ?7
       ${returning}`,
    )
    .bind(h.hostId, h.region, h.name, h.players, h.now, h.staleBefore, h.tooSoonAfter)
    .run<LiveLobby>();
  if (refreshed.results.length) return { lobby: refreshed.results[0]!, rowsWritten: refreshed.meta.rows_written };
  const opened = await db
    .prepare(
      `INSERT INTO live_lobbies (host_id, region, name, players, opened_at, seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (host_id) DO UPDATE SET
         region = excluded.region, name = excluded.name, players = excluded.players,
         opened_at = excluded.opened_at, seen_at = excluded.seen_at, closed_at = NULL
       WHERE coalesce(live_lobbies.closed_at, live_lobbies.seen_at) <= ?6
       ${returning}`,
    )
    .bind(h.hostId, h.region, h.name, h.players, h.now, h.tooSoonAfter)
    .run<LiveLobby>();
  return { lobby: opened.results[0] ?? null, rowsWritten: refreshed.meta.rows_written + opened.meta.rows_written };
}

/** Closes the host's lobby, keeping the row. Whether one was open (stale or not). */
export async function closeLobby(db: D1Database, hostId: number, now: string): Promise<boolean> {
  const { meta } = await db
    .prepare("UPDATE live_lobbies SET closed_at = ?2 WHERE host_id = ?1 AND closed_at IS NULL")
    .bind(hostId, now)
    .run();
  return meta.changes > 0;
}

/**
 * On the cron: deletes the lobbies whose last heartbeat or close was at or before `staleBefore`. They
 * aren't listed, and are past the rate limit's window. How many.
 */
export async function deleteStaleLobbies(db: D1Database, staleBefore: string): Promise<number> {
  const { meta } = await db.prepare("DELETE FROM live_lobbies WHERE coalesce(closed_at, seen_at) <= ?").bind(staleBefore).run();
  return meta.changes;
}

export interface LiveLobbyRow {
  hostName: string;
  name: string | null;
  players: number;
  openedAt: string;
  seenAt: string;
}

/** The region's open lobbies seen after `staleBefore`, longest open first. A revoked host's aren't listed. */
export async function listLiveLobbies(db: D1Database, region: string, staleBefore: string): Promise<LiveLobbyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT h.name AS hostName, l.name, l.players, l.opened_at AS openedAt, l.seen_at AS seenAt
       FROM live_lobbies l JOIN hosts h ON h.id = l.host_id
       WHERE l.region = ?1 AND l.seen_at > ?2 AND l.closed_at IS NULL AND h.trust <> 'revoked'
       ORDER BY l.opened_at, l.host_id`,
    )
    .bind(region, staleBefore)
    .all<LiveLobbyRow>();
  return results;
}
