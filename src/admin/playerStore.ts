import { staleFromPlayersStatement } from "../rating/store";

/**
 * The D1 queries for merging and naming players (#8, docs/database.md, "Merging players"). Like the
 * other admin writes, each change and its `admin_actions` row are one `db.batch`, guarded by the
 * state the handler read: if it changed in between, the guard fails the batch (`isStale` in
 * `./store.ts`, on `players.name`) and nothing is written.
 */

/**
 * Every column that holds a player id, and what a merge does with it. A migration that adds a
 * column referencing `players(id)` adds it here too: test/players.test.ts fails until it does.
 *
 * - `aliases`: the names. A merge moves the merged player's to the other; an undo moves those back.
 * - `matchPlayers`: who played a match (`match_players`). A merge moves the merged player's rows; an
 *   undo moves back the rows played under one of the aliases it gives back (`match_players.alias_id`), so
 *   matches uploaded since the merge go back too.
 * - `perMatch`: another row about a player in one match, found again by its match (`matchOf`) and
 *   log id (`logOf`). A merge moves the merged player's rows; an undo moves back the rows whose
 *   `match_players` row went back.
 * - `derived`: rebuilt from the match rows by the rating recompute. A merge deletes the merged
 *   player's rows and makes the ratings stale from their first rated match in each region, so the
 *   recompute writes the merged player's; an undo makes them stale from the same match again. A
 *   table of totals that the rating recompute doesn't rebuild (head-to-head totals, records) needs
 *   its own rebuild of both players, in the same batch.
 * - `merge`: the merges' own bookkeeping, which a merge doesn't move.
 */
export type PlayerIdColumn =
  | { table: string; column: string; kind: "aliases" | "matchPlayers" | "derived" | "merge" }
  | { table: string; column: string; kind: "perMatch"; matchOf: string; logOf: string };

export const playerIdColumns: readonly PlayerIdColumn[] = [
  { table: "aliases", column: "player_id", kind: "aliases" },
  { table: "match_players", column: "player_id", kind: "matchPlayers" },
  {
    table: "round_players",
    column: "player_id",
    kind: "perMatch",
    matchOf: "(SELECT r.match_id FROM rounds r WHERE r.id = round_players.round_id)",
    logOf: "round_players.log_id",
  },
  { table: "ratings", column: "player_id", kind: "derived" },
  { table: "rating_history", column: "player_id", kind: "derived" },
  { table: "players", column: "merged_into", kind: "merge" },
  { table: "player_merges", column: "from_id", kind: "merge" },
  { table: "player_merges", column: "into_id", kind: "merge" },
];

export interface AliasRow {
  id: number;
  name: string;
  /** When a log last showed it. Empty for a name an admin gave that no log has shown yet. */
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PlayerRatingRow {
  region: string;
  rating: number;
  rounds: number;
  wins: number;
  lastPlayedAt: string | null;
}

export interface AdminPlayer {
  id: number;
  name: string;
  /** An admin set the display name: uploads don't change it. */
  nameFixed: boolean;
  /** The player this one was merged into, or null. */
  mergedInto: number | null;
  createdAt: string;
  /** Newest seen first. */
  aliases: AliasRow[];
  ratings: PlayerRatingRow[];
  /** Matches they played (any status). */
  matches: number;
}

export interface MergeRow {
  id: number;
  from: { id: number; name: string };
  into: { id: number; name: string };
  /** The names the merge moved. */
  aliases: string[];
  mergedBy: string;
  mergedAt: string;
  undoneBy: string | null;
  undoneAt: string | null;
}

/** The newest-seen alias of a player (`idSql`): the display name when no admin set one. */
const latestAlias = (idSql: string) =>
  `(SELECT a.name FROM aliases a WHERE a.player_id = ${idSql} ORDER BY a.last_seen_at DESC, a.id DESC LIMIT 1)`;

const json = (value: unknown) => JSON.stringify(value);

export async function findPlayers(db: D1Database, ids: readonly number[]): Promise<Map<number, AdminPlayer>> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.name_fixed AS nameFixed, p.merged_into AS mergedInto, p.created_at AS createdAt,
         (SELECT json_group_array(json_object('id', id, 'name', name, 'firstSeenAt', first_seen_at, 'lastSeenAt', last_seen_at))
          FROM (SELECT * FROM aliases a WHERE a.player_id = p.id ORDER BY a.last_seen_at DESC, a.id DESC)) AS aliases,
         (SELECT json_group_array(json_object('region', board, 'rating', display, 'rounds', rounds, 'wins', wins,
            'lastPlayedAt', last_played_at)) FROM (SELECT * FROM ratings r WHERE r.player_id = p.id ORDER BY r.board)) AS ratings,
         (SELECT COUNT(*) FROM match_players mp WHERE mp.player_id = p.id) AS matches
       FROM players p WHERE p.id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(json(ids))
    .all<Omit<AdminPlayer, "nameFixed" | "aliases" | "ratings"> & { nameFixed: number; aliases: string; ratings: string }>();
  return new Map(
    results.map((row) => [
      row.id,
      {
        ...row,
        nameFixed: row.nameFixed === 1,
        aliases: JSON.parse(row.aliases) as AliasRow[],
        ratings: JSON.parse(row.ratings) as PlayerRatingRow[],
      },
    ]),
  );
}

/** The other names of these players, newest seen first. */
export async function listAliasNames(db: D1Database, ids: readonly number[]): Promise<Map<number, string[]>> {
  if (!ids.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT player_id AS id, json_group_array(name) AS names
       FROM (SELECT * FROM aliases WHERE player_id IN (SELECT value FROM json_each(?1)) ORDER BY last_seen_at DESC, id DESC)
       GROUP BY player_id`,
    )
    .bind(json(ids))
    .all<{ id: number; names: string }>();
  return new Map(results.map((row) => [row.id, JSON.parse(row.names) as string[]]));
}

/** Who owns this name (a `nameKey`), if anyone. */
export async function aliasOwner(db: D1Database, key: string): Promise<number | null> {
  const row = await db.prepare("SELECT player_id AS id FROM aliases WHERE name_key = ?").bind(key).first<{ id: number }>();
  return row?.id ?? null;
}

/** A round both players were in at once, if any: then they're two people, not one. */
export async function sharedRound(db: D1Database, a: number, b: number): Promise<{ matchId: number; round: number } | null> {
  return db
    .prepare(
      `SELECT r.match_id AS matchId, r.number AS round
       FROM round_players x JOIN round_players y ON y.round_id = x.round_id AND y.player_id = ?2 JOIN rounds r ON r.id = x.round_id
       WHERE x.player_id = ?1 LIMIT 1`,
    )
    .bind(a, b)
    .first<{ matchId: number; round: number }>();
}

const mergeColumns = `pm.id, pm.from_id AS fromId, f.name AS fromName, pm.into_id AS intoId, i.name AS intoName,
  (SELECT json_group_array(a.name) FROM aliases a WHERE a.id IN (SELECT value FROM json_each(pm.aliases))) AS aliases,
  (SELECT json_group_array(a.name_key) FROM aliases a WHERE a.id IN (SELECT value FROM json_each(pm.aliases))) AS aliasKeys,
  (SELECT COUNT(*) FROM aliases a WHERE a.id IN (SELECT value FROM json_each(pm.aliases)) AND a.player_id != pm.into_id) AS aliasesMoved,
  mb.name AS mergedBy, pm.merged_at AS mergedAt, ub.name AS undoneBy, pm.undone_at AS undoneAt`;
const mergeJoins = `player_merges pm JOIN players f ON f.id = pm.from_id JOIN players i ON i.id = pm.into_id
  JOIN admins mb ON mb.id = pm.merged_by LEFT JOIN admins ub ON ub.id = pm.undone_by`;

interface RawMerge {
  id: number;
  fromId: number;
  fromName: string;
  intoId: number;
  intoName: string;
  aliases: string;
  aliasKeys: string;
  aliasesMoved: number;
  mergedBy: string;
  mergedAt: string;
  undoneBy: string | null;
  undoneAt: string | null;
}

/** A merge, and what its undo needs: the keys of the names it moved, and whether another merge moved them since. */
export interface StoredMerge extends MergeRow {
  aliasKeys: string[];
  /** Some of its names belong to another player now: the player it went into was merged since. */
  movedSince: boolean;
}

function toMerge({ fromId, fromName, intoId, intoName, aliases, aliasKeys, aliasesMoved, ...m }: RawMerge): StoredMerge {
  return {
    ...m,
    from: { id: fromId, name: fromName },
    into: { id: intoId, name: intoName },
    aliases: JSON.parse(aliases) as string[],
    aliasKeys: JSON.parse(aliasKeys) as string[],
    movedSince: aliasesMoved > 0,
  };
}

/** Merges, newest first: every one, or those of one player (merged away or into). */
export async function listMerges(db: D1Database, playerId: number | null, limit: number): Promise<MergeRow[]> {
  const { results } = await db
    .prepare(`SELECT ${mergeColumns} FROM ${mergeJoins} WHERE ?1 IS NULL OR ?1 IN (pm.from_id, pm.into_id) ORDER BY pm.id DESC LIMIT ?2`)
    .bind(playerId, limit)
    .all<RawMerge>();
  return results.map((row) => publicMerge(toMerge(row)));
}

export async function findMerge(db: D1Database, id: number): Promise<StoredMerge | null> {
  const row = await db.prepare(`SELECT ${mergeColumns} FROM ${mergeJoins} WHERE pm.id = ?`).bind(id).first<RawMerge>();
  return row ? toMerge(row) : null;
}

/** A merge as the API shows it. */
export function publicMerge(m: StoredMerge): MergeRow {
  return {
    id: m.id,
    from: m.from,
    into: m.into,
    aliases: m.aliases,
    mergedBy: m.mergedBy,
    mergedAt: m.mergedAt,
    undoneBy: m.undoneBy,
    undoneAt: m.undoneAt,
  };
}

/** The merge the player was merged away in and that isn't undone, if any. */
export async function activeMergeOf(db: D1Database, playerId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM player_merges WHERE from_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1")
    .bind(playerId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export interface MergeWrite {
  from: number;
  into: number;
  adminId: number;
  at: string;
  /** For `admin_actions.detail`; the merge's id is added. */
  detail: Record<string, unknown>;
}

/**
 * Merges `from` into `into` in one transaction, if neither was merged meanwhile. Returns the merge's
 * id. About 11 statements, whatever the number of matches (docs/database.md, "Merging players").
 */
export async function writeMerge(db: D1Database, w: MergeWrite): Promise<number> {
  const statements: D1PreparedStatement[] = [
    // NULL when either was merged or a shared round arrived meanwhile: NOT NULL fails the batch (isStale).
    db
      .prepare(
        `UPDATE players SET merged_into = ?2, name = CASE WHEN merged_into IS NULL
           AND EXISTS (SELECT 1 FROM players p WHERE p.id = ?2 AND p.merged_into IS NULL)
           AND NOT EXISTS (SELECT 1 FROM round_players x JOIN round_players y
             ON y.round_id = x.round_id AND y.player_id = ?2 WHERE x.player_id = ?1) THEN name END
         WHERE id = ?1`,
      )
      .bind(w.from, w.into),
    db
      .prepare(
        `INSERT INTO player_merges (from_id, into_id, aliases, merged_by, merged_at)
         SELECT ?1, ?2, json_group_array(id), ?3, ?4 FROM (SELECT id FROM aliases WHERE player_id = ?1 ORDER BY id)
         RETURNING id`,
      )
      .bind(w.from, w.into, w.adminId, w.at),
    // Before the rows move: the first rated match `from` played in each region.
    staleFromPlayersStatement(db, [w.from], w.at),
    // A rating run that read `from`'s rows before this batch fails instead of writing them back.
    db.prepare("UPDATE rating_state SET version = version + 1"),
  ];
  for (const c of playerIdColumns) {
    if (c.kind === "aliases" || c.kind === "matchPlayers" || c.kind === "perMatch") {
      statements.push(db.prepare(`UPDATE ${c.table} SET ${c.column} = ?2 WHERE ${c.column} = ?1`).bind(w.from, w.into));
    } else if (c.kind === "derived") {
      statements.push(db.prepare(`DELETE FROM ${c.table} WHERE ${c.column} = ?1`).bind(w.from));
    }
  }
  statements.push(
    db.prepare(`UPDATE players SET name = coalesce(${latestAlias("?1")}, name) WHERE id = ?1 AND name_fixed = 0`).bind(w.into),
    mergeActionStatement(db, w.adminId, "player_merge", w.detail, w.at, "(SELECT max(id) FROM player_merges)"),
  );
  const results = await db.batch<{ id: number }>(statements);
  return results[1]!.results[0]!.id;
}

export interface UndoWrite {
  merge: StoredMerge;
  /** `into`'s display name was one of the names going back: it follows the logs again. */
  unfixInto: boolean;
  adminId: number;
  at: string;
}

/**
 * Undoes a merge in one transaction, if it's still in place: its names, and the match rows played
 * under them, go back to the merged player, and the ratings are stale from their first rated match
 * in each region. About 10 statements.
 */
export async function writeUndo(db: D1Database, w: UndoWrite): Promise<void> {
  const { id, from, into } = w.merge;
  const moved = "SELECT value FROM json_each((SELECT aliases FROM player_merges WHERE id = ?3))";
  const statements: D1PreparedStatement[] = [
    // NULL when it was undone meanwhile, or `into` was merged on: NOT NULL fails the batch (isStale).
    db
      .prepare(
        `UPDATE players SET merged_into = NULL, name = CASE WHEN merged_into = ?2
           AND (SELECT undone_at FROM player_merges WHERE id = ?3) IS NULL
           AND NOT EXISTS (SELECT 1 FROM aliases WHERE id IN (${moved}) AND player_id != ?2) THEN name END
         WHERE id = ?1`,
      )
      .bind(from.id, into.id, id),
    db.prepare("UPDATE player_merges SET undone_by = ?2, undone_at = ?3 WHERE id = ?1").bind(id, w.adminId, w.at),
  ];
  for (const c of playerIdColumns) {
    if (c.kind === "aliases") {
      statements.push(db.prepare(`UPDATE ${c.table} SET ${c.column} = ?1 WHERE id IN (${moved})`).bind(from.id, into.id, id));
    } else if (c.kind === "matchPlayers") {
      statements.push(
        db
          .prepare(`UPDATE ${c.table} SET ${c.column} = ?1 WHERE ${c.column} = ?2 AND alias_id IN (${moved})`)
          .bind(from.id, into.id, id),
      );
    }
  }
  // After `match_players`, which they follow.
  for (const c of playerIdColumns) {
    if (c.kind !== "perMatch") continue;
    statements.push(
      db
        .prepare(
          `UPDATE ${c.table} SET ${c.column} = ?1 WHERE ${c.column} = ?2 AND EXISTS (SELECT 1 FROM match_players mp
             WHERE mp.match_id = ${c.matchOf} AND mp.log_id = ${c.logOf} AND mp.player_id = ?1)`,
        )
        .bind(from.id, into.id),
    );
  }
  statements.push(
    // After the rows moved back: the first rated match `from` played in each region.
    staleFromPlayersStatement(db, [from.id], w.at),
    db.prepare("UPDATE rating_state SET version = version + 1"),
    db.prepare("UPDATE players SET name_fixed = 0 WHERE id = ?1 AND ?2 = 1").bind(into.id, w.unfixInto ? 1 : 0),
    db
      .prepare(`UPDATE players SET name = coalesce(${latestAlias("players.id")}, name) WHERE id IN (?1, ?2) AND name_fixed = 0`)
      .bind(from.id, into.id),
    mergeActionStatement(db, w.adminId, "player_unmerge", { merge: id, from: from.id, into: into.id }, w.at, "NULL"),
  );
  await db.batch(statements);
}

/** `admin_actions` row of a player action; `mergeIdSql` (SQL) is added to the detail as `merge`. */
function mergeActionStatement(
  db: D1Database,
  adminId: number,
  action: string,
  detail: Record<string, unknown>,
  at: string,
  mergeIdSql: string,
): D1PreparedStatement {
  const withId = mergeIdSql === "NULL" ? "?3" : `json_set(?3, '$.merge', ${mergeIdSql})`;
  return db
    .prepare(`INSERT INTO admin_actions (admin_id, action, detail, at) VALUES (?1, ?2, ${withId}, ?4)`)
    .bind(adminId, action, json(detail), at);
}

/**
 * Sets a player's display name, if they still aren't merged and nobody else took the name. A name
 * that isn't theirs yet becomes an alias with no seen time, so searches find it and a log with it
 * counts for them. `null`: the display name follows the logs again (the name seen most recently).
 */
export async function writeName(
  db: D1Database,
  playerId: number,
  name: { name: string; key: string } | null,
  log: { adminId: number; detail: Record<string, unknown>; at: string },
): Promise<void> {
  const statements = name
    ? [
        db
          .prepare(
            `INSERT INTO aliases (player_id, name, name_key, first_seen_at, last_seen_at)
             SELECT ?1, ?2, ?3, '', '' WHERE NOT EXISTS (SELECT 1 FROM aliases WHERE name_key = ?3)`,
          )
          .bind(playerId, name.name, name.key),
        // NULL when the player was merged meanwhile, or the name is another player's: NOT NULL fails the batch (isStale).
        db
          .prepare(
            `UPDATE players SET name_fixed = 1, name = CASE WHEN merged_into IS NULL
               AND NOT EXISTS (SELECT 1 FROM aliases WHERE name_key = ?3 AND player_id != ?1) THEN ?2 END
             WHERE id = ?1`,
          )
          .bind(playerId, name.name, name.key),
      ]
    : [
        db
          .prepare(
            `UPDATE players SET name_fixed = 0, name = CASE WHEN merged_into IS NULL THEN coalesce(${latestAlias("?1")}, name) END
             WHERE id = ?1`,
          )
          .bind(playerId),
      ];
  await db.batch([...statements, mergeActionStatement(db, log.adminId, "player_name", log.detail, log.at, "NULL")]);
}
