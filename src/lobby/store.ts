/**
 * The live lobbies' D1 queries (#11). One row per host in `live_lobbies`: a heartbeat is one upsert,
 * a close or the cron's cleanup one delete. The table holds at most one row per host, so a list
 * reads a handful of rows (docs/database.md, "Free tier").
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
  /** ISO: a lobby last seen after this is too soon for another heartbeat. */
  tooSoonAfter: string;
}

/**
 * Opens or refreshes the host's lobby. A lobby keeps its `opened_at` while its heartbeats go on in
 * one region; after a gap past the TTL, or in another region, it's a new lobby. Null, and nothing
 * written, when the last heartbeat was too recent (the rate limit).
 */
export async function upsertLobby(db: D1Database, h: Heartbeat): Promise<LiveLobby | null> {
  return db
    .prepare(
      `INSERT INTO live_lobbies (host_id, region, name, players, opened_at, seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (host_id) DO UPDATE SET
         opened_at = CASE WHEN live_lobbies.seen_at <= ?6 OR live_lobbies.region <> excluded.region
                          THEN excluded.opened_at ELSE live_lobbies.opened_at END,
         region = excluded.region, name = excluded.name, players = excluded.players, seen_at = excluded.seen_at
       WHERE live_lobbies.seen_at <= ?7
       RETURNING region, name, players, opened_at AS openedAt, seen_at AS seenAt`,
    )
    .bind(h.hostId, h.region, h.name, h.players, h.now, h.staleBefore, h.tooSoonAfter)
    .first<LiveLobby>();
}

/** Closes the host's lobby. Whether one was open (stale or not). */
export async function deleteLobby(db: D1Database, hostId: number): Promise<boolean> {
  const { meta } = await db.prepare("DELETE FROM live_lobbies WHERE host_id = ?").bind(hostId).run();
  return meta.changes > 0;
}

/** On the cron: deletes the lobbies last seen at or before `staleBefore`. How many. */
export async function deleteStaleLobbies(db: D1Database, staleBefore: string): Promise<number> {
  const { meta } = await db.prepare("DELETE FROM live_lobbies WHERE seen_at <= ?").bind(staleBefore).run();
  return meta.changes;
}

export interface LiveLobbyRow {
  hostName: string;
  name: string | null;
  players: number;
  openedAt: string;
  seenAt: string;
}

/** The region's lobbies seen after `staleBefore`, longest open first. A revoked host's aren't listed. */
export async function listLiveLobbies(db: D1Database, region: string, staleBefore: string): Promise<LiveLobbyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT h.name AS hostName, l.name, l.players, l.opened_at AS openedAt, l.seen_at AS seenAt
       FROM live_lobbies l JOIN hosts h ON h.id = l.host_id
       WHERE l.region = ?1 AND l.seen_at > ?2 AND h.trust <> 'revoked'
       ORDER BY l.opened_at, l.host_id`,
    )
    .bind(region, staleBefore)
    .all<LiveLobbyRow>();
  return results;
}
