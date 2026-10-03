# Database

The server stores everything in one D1 database (SQLite). The schema is in [`migrations/`](../migrations), and follows GenjiBall-CE [`docs/ranked-log.md`](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md) (format 1).

## Tables

| Table | One row per | Notes |
|---|---|---|
| `players` | player account | `name` is the alias seen most recently |
| `aliases` | name seen for a player | A name (ignoring case) belongs to one player. Admins merge them (#8) |
| `hosts` | host | Only the SHA-256 of the token. `trust`: `trusted`, `untrusted` or `revoked` |
| `uploads` | uploaded file | The raw log, gzipped, and its SHA-256 (the same file is stored once) |
| `matches` | match | `status`: `accepted`, `review`, `rejected`, `void`. One per host + `match_key`. `rated_at`: when it went into the ratings |
| `match_players` | player in a match | By the per-match log id from `JOIN` |
| `rounds` | round | `rated` = a `WIN` round that isn't broken |
| `round_players` | player in a round | `position` in the rated finishing order (1 = winner), `left_round` for leavers |
| `events` | `KILL` or `DEFLECT` line | For stats. Ids are log ids; join through `match_players` for players |
| `ratings` | player per leaderboard | `board` is `ranked` now; `tourney` and `global` come with #26 |
| `rating_history` | player per match | The whole rating after each match (mu, sigma, rounds, wins): for the graph, and where a recompute starts |
| `admins` | admin | Only the SHA-256 of the token. `revoked_at` set: the token doesn't work |
| `admin_actions` | admin action | Who, what, when, which match or host, and a JSON `detail`. Only ever inserted ([api.md](api.md), "Admin") |
| `rating_state` | leaderboard | Whether the ratings are stale, and from which match. `version` guards rating writes ([rating.md](rating.md)) |

Player fields inside a match (`winner_id`, `killer_id`, `actor_id`, `target_id`) are **log ids**, not player ids, exactly as in the log. `match_players` maps them to players, so merging two aliases only touches `match_players`, `round_players` and the ratings, never the events.

## Rules for code that writes

- **Keep the raw log.** Ratings, stats and players can always be rebuilt from `uploads.raw_log`. When the parser or the rating engine changes, re-run it over the stored logs.
- **Copies of one match.** The same match can arrive in several files (see "One match in several files" in the spec). The upload endpoint (`src/upload/`, [api.md](api.md)) looks up `(host_id, match_key)`. A shorter stored copy is replaced: the match's rounds, players and events are deleted and the new ones inserted under the same match id. A copy with the same line count isn't rewritten; the match just points at the new upload. A longer stored copy wins and the new one isn't written. An upload no match points at any more is deleted: it was the start of a longer one. If no match in a file is new or longer, nothing is written at all.
- **Every player has at least one alias.** A new name creates a player and its alias in the same batch; the upload finds the new players as those without an alias. Merging players (#8) must keep that true.
- **Bulk inserts.** The free plan allows 50 queries per Worker invocation and 100 bound parameters per query, and one match has hundreds of events. Insert the rows of a table in one statement from a JSON parameter:

  ```sql
  INSERT INTO events (match_id, seq, type, round, time, actor_id, target_id, speed)
  SELECT ?1, e.value ->> 'seq', e.value ->> 'type', e.value ->> 'round', e.value ->> 'time',
         e.value ->> 'actor', e.value ->> 'target', e.value ->> 'speed'
  FROM json_each(?2) AS e
  ```

  An upload is about 15 statements whatever the number of matches in the file, plus one per `insertChunkRows` rows of a big table, all in one `db.batch` (a transaction).
- **BLOBs come back as arrays.** D1 returns a `BLOB` column (`raw_log`) as an array of byte values, not an `ArrayBuffer`: wrap it in `new Uint8Array(...)` before gunzipping.

## Free tier

The Workers Free plan limits for D1 (checked 2026-10-03, [limits](https://developers.cloudflare.com/d1/platform/limits/), [pricing](https://developers.cloudflare.com/d1/platform/pricing/)):

| Limit | Free plan |
|---|---|
| Database size | 500 MB (5 GB across all databases) |
| Rows read | 5 million / day |
| Rows written | 100,000 / day. An index on a written column counts as one more row |
| Queries per Worker invocation | 50 |
| Row, string or BLOB size | 2 MB |
| Statement length / bound parameters | 100 KB / 100 |

Past a daily limit, every query fails until the next day, so the site and uploads stop. These are the numbers to watch.

### A busy week

Assumed: **40 matches a day, every day**, 8 players, 25 rounds a match. From the spec example, a round with 5 players logs about 6 deflects and 4 kills; with 8 players, say 15 deflects and 8 kills. That's about 575 events and 800 log lines a match.

**Rows written per match**, counting index rows:

| Table | Rows | With indexes |
|---|---|---|
| `uploads` | 1 | 3 |
| `matches` | 1 | 5 |
| `match_players` | 8 | 16 |
| `aliases` (last seen) | 8 | 8 |
| `rounds` | 25 | 50 |
| `round_players` | 200 | 400 |
| `events` | 575 | 575 |
| `ratings` | 8 | 16 |
| `rating_history` | 8 | 16 |
| `rating_state` | 1 | 1 |
| **Total** | | **≈ 1,110** |

40 matches a day is **≈ 44,500 rows written a day, 45% of the limit**. Without the "drop a copy that isn't longer" rule above, a match uploaded in 3 files would cost up to 3 times that, and a busy day would go over the limit. So the upload endpoint must check the line count before it writes anything, and the host tool should upload a file only once it has stopped growing.

`events` is the biggest table. If writes get tight, deflects can be stored as per-player counts per match instead of rows: the raw log keeps the detail.

**Storage.** A log line is about 35 bytes, so a match is about 28 KB of text, about 7 KB gzipped (gzip shrinks even the tiny spec example 2.6×; long logs shrink more). The rows add about 1,100 rows × ~40 bytes ≈ 45 KB a match. Together about **50 KB a match, 2 MB a day, 14 MB a week, 730 MB a year** at this rate. That passes the 500 MB database limit after about 8 months of every day being this busy. Before that: drop `events` rows for old matches (stats can be kept as totals, the raw log stays), or move raw logs to R2 (10 GB free).

**Rows read.** Pages read through the indexes: a leaderboard page reads its 50 rows, a player page the player's matches and rounds, head-to-head the two players' rounds. Even 10,000 page views a day stay far under 5 million. The cost to watch is a **rating recompute** (#6): it reads every rated `round_players` row of the matches it re-rates, about 200 a match, and a full one would read about 3 million rows after a year at this rate, most of a day's reads. So a new match is rated incrementally, and a recompute starts at the first changed match, from the players' `rating_history` just before it, not from scratch. It re-rates `ratingMatchesPerRun` matches a run (about 2,000 rows read) and writes only the history and ratings rows that changed, so a late upload only rewrites the later matches of the players it moved ([rating.md](rating.md), "Ratings in the database").
