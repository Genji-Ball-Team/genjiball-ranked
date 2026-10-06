# Database

The server stores everything in one D1 database (SQLite). The schema is in [`migrations/`](../migrations), and follows GenjiBall-CE [`docs/ranked-log.md`](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md) (format 1).

## Tables

| Table | One row per | Notes |
|---|---|---|
| `players` | player account | `name` is the alias seen most recently, unless an admin set it (`name_fixed`). `merged_into`: the player an admin merged this one into ([below](#merging-players)); a merged player keeps their row but has no aliases or ratings |
| `aliases` | name seen for a player | A name (ignoring case) belongs to one player. Admins merge players (#8). A name an admin gave that no log has shown yet has empty seen times |
| `player_merges` | merge of two players | `from_id` merged into `into_id`, the ids of the aliases it moved (JSON), who and when; `undone_at` once undone |
| `hosts` | host | Only the SHA-256 of the token. `trust`: `trusted`, `untrusted` or `revoked`. `region`: home region, where uploads without `X-Region` go (`NULL`: none) |
| `uploads` | uploaded file | The raw log, gzipped, and its SHA-256 (the same file is stored once) |
| `matches` | match | `status`: `accepted`, `review`, `rejected`, `void`. One per host + `match_key`. `rated_at`: when it went into the ratings. `region`: where it was hosted, kept by later copies. `feed_seq`: its place in the match feed, set by triggers ([below](#the-match-feed)). `host_afk`: the rounds the host was AFK in (JSON array, `NULL`: none), the union of every upload's `X-Host-Afk` ([api.md](api.md)) |
| `match_players` | player in a match | By the per-match log id from `JOIN`; `alias_id` keeps the alias used, regardless of spelling or merges. `kills`: their `KILL` lines in the match, for stats |
| `rounds` | round | `rated` = a `WIN` round that isn't broken |
| `round_players` | player in a round | `position` in the rated finishing order (1 = winner), `left_round` for leavers, `afk` for the host dropped as AFK (no `position`), `killer_id` from `ELIM`; for stats `kills` and `deflects` in the round (`deflects` `NULL` for legacy: unknown) |
| `match_pairs` | ordered pair of players in a match | Derived at upload: rated rounds both finished, rounds `ahead`, and `KILL` lines between them (`kills`, `deaths`). Both directions ([below](#match-stats-and-head-to-head)) |
| `pair_stats` | ordered pair of players per region | The sum of `match_pairs` over the region's `accepted` matches, kept by triggers. Derived ([below](#match-stats-and-head-to-head)) |
| `events` | `KILL` or `DEFLECT` line | For stats. Ids are log ids; join through `match_players` for players |
| `ratings` | player per region | `board` is the region id (`eu`, `na`): each region is its own leaderboard, tourney matches included (marked `matches.tournament`). `streak`, `best_streak`: rated rounds won in a row now, and the longest ever |
| `rating_history` | player per match | On the board of the match's region (`h.board = m.region`). The whole rating after each match (mu, sigma, rounds, wins, streaks): for the graph (`/api/players/:id/history`), and where a recompute starts |
| `admins` | admin | Only the SHA-256 of the token. `revoked_at` set: the token doesn't work |
| `admin_actions` | admin action | Who, what, when, which match or host, and a JSON `detail`. Only ever inserted ([api.md](api.md), "Admin") |
| `tourneys` | tourney | `status`: `scheduled`, `live`, `done`, `cancelled`. `starts_at` in UTC. `region`: its lobbies' matches are from there |
| `tourney_lobbies` | lobby of a tourney | Its match (`match_id`, unique: a match is in one lobby) and verify screenshot (`screenshot_key` in R2, `verified_by`/`verified_at`). Linking a match sets `matches.tournament`. `host_id`: the assigned host (`NULL`: none). `round_limit`: `NULL` is `tourneyRoundLimit`. `lobby_key`: the server's random id for the lobby in the game's tourney rule (unique) |
| `host_actions` | host API change | A host's own screenshot upload or delete, like `admin_actions`: who, what, when, which lobby (no foreign key: the log outlives the lobby). Only ever inserted |
| `screenshot_deletions` | screenshot awaiting R2 deletion | Keeps its key and byte count until R2 deletion succeeds; failed deletes remain accounted for and are retried |
| `live_lobbies` | host with a lobby open or just closed | From the host tool's heartbeats (#11): `region`, `name`, `players`, `opened_at`, `seen_at` (last heartbeat), `closed_at` (closed by the host; the row stays for the rate limit). Not listed once closed or `seen_at` is `lobbyTtlSeconds` old; the cron deletes it once that's past the TTL. Indexed by `region` only, and a heartbeat in the same region doesn't SET it: one row written ([below](#live-lobbies)) |
| `match_stats` | accepted match | Its bests for the records (deflects in a round, fastest deflect, kills, wins) and its rated rounds. Derived by the cron ([below](#records)); players are log ids |
| `records` | region | The records page as served (`/api/records`), JSON, when it was made and from which revision |
| `records_revisions` | region | `revision`: goes up when what its records count changes; `urgent`: when a match last left them |
| `records_state` | (one row) | `feed_cursor`: how far the cron has read the match feed for `match_stats` |
| `match_stats_recount` | match queued for a recount | By a player merge or undo, which the feed doesn't list ([below](#records)). Deleted once counted |
| `rating_state` | region | Whether the region's ratings are stale, and from which match. `version` guards rating writes ([rating.md](rating.md)). A region added to the config gets its row the first time it's rated |

Player fields inside a match (`winner_id`, `killer_id`, `actor_id`, `target_id`) are **log ids**, not player ids, exactly as in the log. `match_players` maps them to players, so merging two aliases only touches `match_players`, `round_players` and the ratings, never the events.

## Rules for code that writes

- **Keep the raw log.** Ratings, stats and players can always be rebuilt from `uploads.raw_log`. When the parser or the rating engine changes, re-run it over the stored logs. The one input that isn't in the log is the host's AFK rounds (`matches.host_afk`): a re-parse applies them again from there, and the match row is updated, never deleted, so they stay.
- **Copies of one match.** The same match can arrive in several files (see "One match in several files" in the spec). The upload endpoint (`src/upload/`, [api.md](api.md)) looks up `(host_id, match_key)`. A shorter stored copy is replaced: the match's rounds, players and events are deleted and the new ones inserted under the same match id. A copy with the same line count isn't rewritten; the match just points at the new upload. A longer stored copy wins and the new one isn't written. An upload no match points at any more is deleted: it was the start of a longer one. If no match in a file is new or longer, nothing is written at all, unless it brings new host AFK rounds.
- **Host AFK** (`X-Host-Afk`, [api.md](api.md)). The upload drops the host from the AFK rounds before it writes the rows, and stores the union of the rounds in `matches.host_afk`. A copy that isn't longer, or the same file again, with rounds that drop the host from the stored copy is a `refresh`: the stored match's rows are rewritten in the upload's batch exactly like a longer copy, from this file when it's as long, else from the stored copy's log (one more query, a read of that upload's `raw_log`), and the match stays in its upload (no file is stored for it). The ratings go stale from it, and its records recount is queued (`match_stats_recount`), since a refresh doesn't move the match feed. It costs what a longer copy does; each one needs a new round to drop the host from, so a match is refreshed at most once per round. A refresh doesn't count against `maxUploadsPerHour`, which counts stored files.
- **Every player has at least one alias**, except a merged one (`merged_into` set). A new name creates a player and its alias in the same batch; the upload finds the new players as those without an alias that aren't merged.
- **Bulk inserts.** The free plan allows 50 queries per Worker invocation and 100 bound parameters per query, and one match has hundreds of events. Insert the rows of a table in one statement from a JSON parameter:

  ```sql
  INSERT INTO events (match_id, seq, type, round, time, actor_id, target_id, speed)
  SELECT ?1, e.value ->> 'seq', e.value ->> 'type', e.value ->> 'round', e.value ->> 'time',
         e.value ->> 'actor', e.value ->> 'target', e.value ->> 'speed'
  FROM json_each(?2) AS e
  ```

  An upload is about 20 statements whatever the number of matches in the file, plus one per `insertChunkBytes` (1 MB) of JSON rows of a table, all in one `db.batch` (a transaction). With its reads before and the rating after (`rateNewMatchesMaxQueries`, 14), it must stay within `queriesPerRequest` (50): the upload counts its queries before writing, and leaves the rating to the cron (within 10 minutes) when what's left can't hold it. A file that can't be written in what's left is refused (`413 too_large`) and nothing is written; the densest file `maxUploadBytes` allows (rounds of 10 players and nothing else) is about 17 MB of rows, about 20 statements. A one-rated-round, 5,000-ABORT-round log takes 36 queries, rating included (`test/stats.test.ts`).
- **BLOBs come back as arrays.** D1 returns a `BLOB` column (`raw_log`) as an array of byte values, not an `ArrayBuffer`: wrap it in `new Uint8Array(...)` before gunzipping.

## Merging players

An admin merges two names that are one player (#8, [api.md](api.md), "Merging players"). Code: `src/admin/players.ts` and `src/admin/playerStore.ts`. A merge, and its undo, is one `db.batch` with its `admin_actions` row. The merge rechecks the shared-round refusal inside the batch. Undo selects match rows by the persisted alias ids in that batch, so a concurrent upload of a new spelling goes back too. Before migration 0016 each player has one alias; the migration backfills existing match rows from that alias, including Unicode case variants.

**Every column that holds a player id is listed in one place, `playerIdColumns` in `src/admin/playerStore.ts`**, with what a merge does to it. `test/players.test.ts` reads the schema and fails when a column referencing `players(id)` isn't listed, so a branch that adds a table with player ids (head-to-head totals, per-match stats, records) adds its entry there:

| Kind | Columns now | Merge | Undo |
|---|---|---|---|
| `aliases` | `aliases.player_id` | Moved to the player who stays; their ids are kept in `player_merges.aliases` | Those aliases move back |
| `matchPlayers` | `match_players.player_id` | Moved | The rows whose persisted `alias_id` is in the merge move back, matches uploaded since the merge too |
| `perMatch` (a row about a player in one match, with the match and log id) | `round_players.player_id` | Moved | The rows whose `match_players` row went back move back |
| `derived` (rebuilt from the match rows) | `ratings`, `rating_history` | The merged player's rows are deleted, and each region's ratings go stale from the merged player's first rated match there | Stale from the same match again: the recompute rebuilds both players |
| `pairs` (head-to-head, [below](#match-stats-and-head-to-head)) | `match_pairs.player_id`, `opponent_id`; `pair_stats.player_id`, `opponent_id` | The pairs of the merged player's matches are deleted before the rows move and derived again after (`src/upload/pairs.ts`): two pairs against one opponent become one, a pair of the player with themselves (a shared match, never a shared round) goes. The triggers take the old pairs out of `pair_stats` and add the new | The same for the matches that went back |
| `merge` | `players.merged_into`, `player_merges.from_id`, `into_id` | Bookkeeping | |

A per-match table with one row per player (`match_stats`) is a `perMatch` entry: it follows `match_players` both ways with no other code. `match_pairs` isn't one, since a row holds two players and sums their rounds; it and its totals are re-derived (`pairs`). A table of totals across matches (records) is `derived`, but the rating recompute doesn't rebuild it: its branch adds the rebuild of both players' rows to the merge and undo batches.

Events hold log ids, never player ids, so a merge doesn't touch them. Nothing is lost by deleting the merged player's ratings: they're rebuilt from the matches, so after an undo and its recompute every rating and history row is what it was before the merge.

**Cost.** A merge is about 13 statements whatever the player's size, an undo about 12, a name change 3. A merged player with `m` matches and `r` rounds writes about 2 rows (with the index) per alias, match and round moved, plus the ratings and history rows deleted: for 20 matches of 25 rounds, about 1,100 rows, what one uploaded match costs. The two-names-in-one-round check reads the merged player's `round_players` rows, an undo reads the other player's `match_players` rows. Then the ratings are recomputed from the merged player's first rated match in each region, like a late upload from that day ([rating.md](rating.md)): up to 16 rows written per match re-rated, `ratingMatchesPerRun` matches a cron run. Merging a name first seen months ago re-rates every later match of its region, so merge soon after a name change and avoid merging and undoing back and forth.

**Head-to-head cost.** Re-deriving the pairs costs what a longer copy does, per match of the merged player (the matches that move): about 280 rows written and 2,700 read for 8 players ([below](#match-stats-and-head-to-head)). For 20 matches, about 5,600 rows written on top of the 1,100 above; a merged player with a few hundred matches is a large part of a day's writes.

**Queries per request.** A merge reads the admin, the two players and the shared-round check (3), then writes its batch (13): 16 queries. An undo reads the admin and merge (2), then writes its batch (12): 14 queries. Both answer `ratingsStale: true`; all rating computation runs in the cron, keeping round replay out of the free plan's 10 ms request CPU budget. A merged player page follows the whole merge chain in one recursive query, then reads the canonical page (at most 7 queries with its head-to-head rivals, independent of chain length).

## The match feed

`GET /api/matches?after=` ([api.md](api.md)) lists public matches by `matches.feed_seq`, a change number. Two triggers (`migrations/0010_match_feed.sql`) give a match the next number (`max(feed_seq) + 1`, through the unique index `matches_feed`) when it's inserted as `accepted` or `void`, and when, while public or on leaving public, its `status`, `line_count` or `tournament` changes or `rated_at` goes from `NULL` to a time. A third (`migrations/0014_feed_region_moves.sql`) does the same when a match that is or was public moves to another region, and adds the region it left to `feed_left_regions` (`,eu,na,`), so the feed of every region it left lists it as removed, even after several moves or a move after leaving public. So code that writes `matches` doesn't have to know about the feed, and a recompute (which only stamps `rated_at` on newly rated matches) doesn't re-list old ones. Each change costs one more row written, about three a match.

## Records

`GET /api/records` ([api.md](api.md)) shows a region's records, activity and top hosts. Counting them from `events` and `round_players` on every view would read every event ever stored, so they're derived, by the cron after the ratings (`src/records/`), and rebuildable from the stored rounds and events (themselves from the logs):

- **`match_stats`**: one row per accepted match, its bests (by log id, so merging aliases rewrites nothing), its rated rounds and the `line_count` it was counted from. The cron follows the match feed (`feed_seq`, [below](#the-match-feed)) from `records_state.feed_cursor`, at most `recordsMatchesPerRun` (10) matches a run: a match that changed is recounted if it's accepted. Counts are grouped by match once, then each match's own rows scanned: work grows with the input rows, not matches times rows. Its write is one batch that first moves the cursor from where it was read and fails whole if another run moved it; it writes a match's row only if the match is still accepted with the same copy, in the region it's in then. **Rebuild**: `UPDATE records_state SET feed_cursor = 0`; the cron recounts every public match over the next runs.
- **A match that stops counting** (voided, rejected, back in review with a longer copy) or moves to the other region: trigger `match_stats_leave` (`migrations/0015_records.sql`), in the same transaction, deletes or moves its row and raises the regions' `records_revisions.revision`, the old region's as `urgent` too.
- **Bots** (`legacyBotNames`: `Genji Bot` and `zSh4d0Ws bozo`, AI players in legacy lobbies) are players with `bot = 1`, set when an upload first sees the name (migration 0018 marked the ones already stored, took their head-to-head pairs out and queued their matches for a recount). Their rounds are never rated ([legacy.md](legacy.md)). They stay in the match's player list, but hold no record, their kills and the kills of them aren't counted, and the activity doesn't count them as players.
- **A player merge or undo** (#8) moves `match_players` rows without touching the feed (a feed change would make the Discord bot repost the matches). In its own transaction it queues the moved player's matches in `match_stats_recount` and makes every region's records urgent. The cron recounts queued matches with the feed's changes, sharing `recordsMatchesPerRun`, and deletes the queue rows it read: a match queued again meanwhile keeps its newer row. Until the urgent rebuild, a view also shows each record's holder as the player they were merged into.
- **Win streaks** are order-dependent, so they're part of the rating: `streak`/`best_streak` in `ratings` and `rating_history`, recomputed with it ([rating.md](rating.md)). **Highest rating** is the top of `rating_history` through `rating_history_board_display`.
- **`records`**: the page each region serves, so a view reads one row, with the revision and rating version it was made from. Every rebuild reads only matches accepted in the region now. **Cadence**: one region a cron run (every 10 minutes). A region with an urgent revision newer than its page is rebuilt at the next run; until then a view checks the page's match records against the matches and its holders against merges (one more batch of 2 queries, a few rows) and leaves out any match no longer public there (its counts in the activity and top hosts wait for the rebuild). Otherwise a page is rebuilt when its revision or `rating_state.version` moved or a new UTC day started, once `recordsRefreshMinutes` (60) have passed since the last: so 60 to 70 minutes after a change, more when both regions are due or the cron is short of queries. The revision only goes up and a page is only stored over an older one, so a change made during a rebuild keeps the page due.
- **CPU and backlog**: the free plan allows 10 ms CPU per request and cron invocation. A local Node benchmark of 10 matches × 100 rounds × 12 players took 4.4 ms cold, 0.7 ms median and 1.4 ms p95 for `matchStats` alone; the rest of the cron shares the budget. The regression counts input scans because the Workers test clock freezes between I/O. The sync takes 10 changed matches a run, at most 1,440 a day. A rebuild from 0 of a year at 40 matches a day (14,600 matches; the feed keeps only each match's latest change) takes 1,460 runs, about 10 days, during which pages show the matches counted so far. The cron does the records only when `syncQueries` (12) and then `refreshQueries` (5) still fit in its queries ([rating.md](rating.md), "Queries an invocation"): during a long recompute of both regions they wait.

## Match stats and head-to-head

The match page's stats (#15, [api.md](api.md) "Site") are counted at upload into columns of rows it already reads: `match_players.kills` and `round_players.kills` (`KILL` lines with the player as attacker, not a self-kill, as the tourney standings count them: in the whole match, and in the round, where, in a new log, a `KILL` logged after the `ROUND_END` in the same tick counts in the round of its `ELIM`), and `round_players.deflects`. Wins and streaks come from `position` and the winner. So the page reads no `events`: that would be about 575 more rows a view. Migration 0017 filled the columns of the matches already stored from their `events`, counting only the kills that have a round there: a match stored before it (the test server's) may count one kill fewer in a round when the `KILL` came after the round's `ROUND_END`. Its match total is right.

Head-to-head records (#18) are kept as totals, because counting them at read time grows with a player's history: "most eliminated" would read every round the player was in and each of its 8 players, about 8 rows a round, 200,000 rows a view for someone with a year of 2 or 3 matches a day.

- **`match_pairs`**: written in the upload's batch, one `INSERT … SELECT` (`src/upload/pairs.ts`) after the rounds and events: `rounds` and `ahead` from the rated rounds both finished, `kills` and `deaths` from every `KILL` line between them, in or out of a round. One row per ordered pair (both directions), so a player's records read only their own rows; a pair with kills but no rated round together has one too. Deleted with the match's rounds when a longer copy replaces it. A bot (`players.bot`, below) is in no pair.
- **`pair_stats`**: keyed by region, player, opponent. Triggers (`migrations/0017_match_stats.sql`) keep it equal to the sum of `match_pairs` over `accepted` matches in their region: a pair inserted or deleted while its match is accepted is added or taken out; a match whose `status` or `region` changes (accepted from review, voided, unvoided, moved to the other region) is taken out of the old totals and added to the new; a deleted match takes its pairs out first. A row whose counts all reach 0 is deleted. Every trigger write goes through the primary key, one per pair of the match: the region's other rows aren't read. Code that writes `matches` doesn't have to know about it.
- **Rebuild**, a range at a time (`src/upload/pairs.ts`); `npm run rebuild:head-to-head` writes the range's SQL and prints the `wrangler d1 execute` command. Each range is right once it ran, so a rebuild can stop after any range and go on another day.
  - After a fix to how pairs are counted: `-- <first match id> <last match id>` deletes those matches' pairs (taking them out of the totals) and inserts them again.
  - When the totals themselves went wrong: `-- --totals <first player id> <last player id>` deletes those players' `pair_stats` rows and sums them again from `match_pairs`. A player's rows depend only on their own pairs, so the other players' are untouched.

| Cost (8 players, 25 rounds) | Rows written | Rows read |
|---|---|---|
| Upload of a new match | 56 `match_pairs`, and 56 `pair_stats` once accepted (no secondary index on either) | About 2,600: the pair insert joins each round's players (25 × 64), reads the match's events once (575) and looks up both players of each kill (400) |
| Longer copy of an accepted match | About 280: the old pairs out (56 deletes, 56 updates, up to 56 rows reaching 0 deleted), the new in (56 + 56) | As an upload |
| Accept, unvoid | 56 | 56 `match_pairs`, 56 `pair_stats` by key |
| Void, reject | Up to 112: 56 updates, up to 56 rows reaching 0 deleted | Twice that |
| Region move | Up to 168: out of the old region's totals (up to 112) and into the new (56) | About 250 |
| Rebuild of a range | About 280 a match, as a longer copy | About 2,700 a match |
| Totals of a player range (`--totals`) | Twice their `pair_stats` rows (about 50 per regular player) | All of `match_pairs` (56 a match) and `pair_stats`, whatever the range |
| Player page | | One `pair_stats` row per opponent met in the region (about 300 for a regular after a year), plus the shown names |
| `/api/head-to-head` | | One `pair_stats` row and the two players |

So a rebuild has to run in chunks: at 280 rows a match, the 100,000 rows written a day allow about 350 matches, and about 175 on a busy day of uploads (49,000 rows, [below](#a-busy-week)). The 193 legacy matches fit in one run; past that, run a range of about 150 matches a day. A `--totals` run reads all of `match_pairs` and `pair_stats` whatever its range, since neither is indexed by player (an index would cost writes on every upload): about 150,000 rows at 2,000 matches. So use ranges as big as the day's writes allow: 500 players write about 50,000 rows.

## Screenshots in R2

Tourney verify screenshots aren't in D1: they're in the R2 bucket bound as `PROOFS` (`genjiball-proofs`, `genjiball-proofs-test` for the test server). R2's free tier holds 10 GB, about 5,000 screenshots of 2 MB. A screenshot's key is random and never reused: replacing one writes a new object and deletes the old. Browsers may cache an image for `screenshotCacheSeconds` (1 h); removal stops origin access immediately, while already cached copies may remain until that time passes.

Screenshots expire so the bucket stays inside the free tier (`src/tourney/expiry.ts`). After each upload, the oldest are deleted past `screenshotsKept` (3000) or `screenshotStorageMaxBytes` (8 GB, counted from the newest), and the cron deletes those older than `screenshotKeepDays` when that's set (0, off, by default). The lobby keeps its result and verified mark, with `screenshot_expired_at` set, and the site says the screenshot is no longer kept.

Removing, replacing or expiring a screenshot queues its R2 deletion in the same D1 transaction that removes the lobby's reference. Pending keys and their bytes still count against the storage caps. Cleanup retries up to `screenshotExpiryBatch` keys after uploads, removals and on every cron, even when age expiry is off. A failed R2 delete stays queued until a later attempt succeeds, and pending images cannot be fetched from the public API.

Uploads reserve their random key and bytes in `screenshot_deletions` before writing to R2. The reservation cannot be cleaned up for `screenshotUploadGraceSeconds` (15 minutes), and attaching it removes that record atomically. Once the grace ends, attachment is rejected so cleanup can never delete a newly attached image. A failed or interrupted upload therefore leaves a key the cron can clean up, even if D1 failed after R2 stored it. When pending or staged keys remain, new uploads cannot reserve space past the storage caps; retry after cleanup succeeds.

`tourney_lobbies.version` increases on edits, screenshot changes, expiry and longer-copy uploads. Admin and host writes check their snapshot version atomically (the `admin_actions` or `host_actions` row is written only if it still matches, else the batch fails); a host's write also needs, at that moment, the lobby still assigned to them and unverified, their token not revoked, and the tourney not cancelled and still in the region checked (tourney edits don't change lobby versions). Verification also requires the version displayed to the admin, and a longer match log clears verification even when the match id stays the same.

## Free tier

The Workers Free plan has 10 ms CPU per request and cron invocation. Its D1 limits (checked 2026-10-03, [limits](https://developers.cloudflare.com/d1/platform/limits/), [pricing](https://developers.cloudflare.com/d1/platform/pricing/)):

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
| `rating_history` | 8 | 24 |
| `rating_state` | 1 | 1 |
| `match_stats` (about 3 feed changes a match) | 3 | 21 |
| `match_pairs` | 56 | 56 |
| `pair_stats` | 56 | 56 |
| **Total** | | **≈ 1,250** |

40 matches a day is **≈ 50,000 rows written a day, 50% of the limit**. The records add the `match_stats` rows (6 indexes) and the `rating_history_board_display` index, about 30 a match, and a `records` row (2 with its key) per refresh: at most 48 a day per region. Without the "drop a copy that isn't longer" rule above, a match uploaded in 3 files would cost up to 3 times that, and a busy day would go over the limit. So the upload endpoint must check the line count before it writes anything, and the host tool should upload a file only once it has stopped growing.

`events` is the biggest table. If writes get tight, deflects can be stored as per-player counts per match instead of rows: the raw log keeps the detail.

**Storage.** A log line is about 35 bytes, so a match is about 28 KB of text, about 7 KB gzipped (gzip shrinks even the tiny spec example 2.6×; long logs shrink more). The rows add about 1,100 rows × ~40 bytes ≈ 45 KB a match. Together about **50 KB a match, 2 MB a day, 14 MB a week, 730 MB a year** at this rate. That passes the 500 MB database limit after about 8 months of every day being this busy. Before that: drop `events` rows for old matches (stats can be kept as totals, the raw log stays), or move raw logs to R2 (10 GB free).

**Regions** (#47) split the same matches and players between two leaderboards: the writes above don't change, and a player who plays in both regions has two `ratings` rows. The rating reads a region's matches through `matches_region_status_played`, `matches_unrated` and `matches_rated` (all keyed by region first), and the cron's `ratingMatchesPerRun` is shared between the regions, so a recompute costs what it did with one leaderboard.

**Rows read.** Pages read through the indexes: a leaderboard page reads its 50 rows, a player page the player's matches and rounds and one `pair_stats` row per opponent, head-to-head one `pair_stats` row and the two players ([above](#match-stats-and-head-to-head)). Even 10,000 page views a day stay far under 5 million; the most a page reads is a regular's player page, about 300 `pair_stats` rows for their rivals (10,000 of those would be 3 million). If player pages get that many views, indexes on `pair_stats(region, player_id, kills)` and `(region, player_id, deaths)` would cut it to `playerRivalsLimit` rows each, for 112 more rows written a match. The exception is the **name search** (`/api/players?search=`, for the Discord bot's autocomplete): a "contains" match can't use an index, so each search reads every alias once, plus the players and ratings of the hits. The v1.3.2 logs hold about 1,450 names, so a search reads about 1,500 rows: 1,000 searches a day is 1.5 million, 30% of the limit. The bot waits for a pause in typing before it asks, and `playerSearchMinLength` can go up if searches get too many. The **match feed** reads through `matches_feed`: a bot asking every 2 minutes while nothing changed reads about one row a time, 720 a day; each listed match reads its rounds and players, a few hundred rows. The cost to watch is a **rating recompute** (#6): it reads every rated `round_players` row of the matches it re-rates, about 200 a match, and a full one would read about 3 million rows after a year at this rate, most of a day's reads. So a new match is rated incrementally, and a recompute starts at the first changed match, from the players' `rating_history` just before it, not from scratch. It re-rates `ratingMatchesPerRun` matches a run (about 2,000 rows read) and writes only the history and ratings rows that changed, so a late upload only rewrites the later matches of the players it moved ([rating.md](rating.md), "Ratings in the database"). The dry-run recompute (`npm run ratings:dry-run`, run by hand) does read a whole region from scratch, about 225 rows a match, writing nothing ([api.md](api.md), "Debug tools").

| Records, at 40 matches a day | Rows read |
|---|---|
| Counting a match (`match_stats`): its events twice, rounds and players | about 1,200, about 3 times a match (each feed change): 144,000 a day (3%) |
| Rebuilding a region's page: the records (tens), its ratings 3 times (one row per rated player), the activity window twice (about 12 rows a match in it, its match checked: 1,120 matches in 28 days) and top hosts (two rows per match in the region: its stats and its match) | after a year of one region: about 9,000 + 27,000 + 30,000 ≈ 66,000 |
| Rebuilds a day: when changed, at most every hour per region, plus one per match leaving | about 9 on a day with evening play, 600,000 (12%); 24 at most, 1.6 million (32%) |

A view of a page made before a match left reads 5 more rows. Top hosts and the ratings scans grow with the region's history: past a year, raise `recordsRefreshMinutes`, or keep per-host counts. The cost to watch is a **rating recompute** (#6): it reads every rated `round_players` row of the matches it re-rates, about 200 a match, and a full one would read about 3 million rows after a year at this rate, most of a day's reads. So a new match is rated incrementally, and a recompute starts at the first changed match, from the players' `rating_history` just before it, not from scratch. It re-rates `ratingMatchesPerRun` matches a run (about 2,000 rows read) and writes only the history and ratings rows that changed, so a late upload only rewrites the later matches of the players it moved ([rating.md](rating.md), "Ratings in the database"). The dry-run recompute (`npm run ratings:dry-run`, run by hand) does read a whole region from scratch, about 225 rows a match, writing nothing ([api.md](api.md), "Debug tools").

### Live lobbies

`live_lobbies` (#11) has one row per host, written by the host tool's heartbeat (`PUT /api/host/lobby`, [api.md](api.md)). Settings in `src/config.ts`: `lobbyHeartbeatSeconds` (60), `lobbyHeartbeatMinSeconds` (30), `lobbyTtlSeconds` (180).

Rows written, as D1 reports them (`meta.rows_written`, checked in `test/lobbies.test.ts`):

| Operation | Rows |
|---|---|
| Heartbeat of an open lobby, same region (an `UPDATE` that doesn't SET `region`) | 1 |
| Heartbeat that opens a lobby: first one, after a close or the TTL, or in another region (the upsert, which rewrites the `region` index) | 2 |
| Close (`closed_at` set, row kept) | 1 |
| Cron delete of a stale or closed row | 1 |

SQLite rewrites an index entry for every indexed column a `SET` names, even to the same value, so the refresh mustn't name `region`.

- **Writes.** A lobby open an hour is 2 + 59 + 1 ≈ 62 rows. Busy week (above): 10 lobbies a day, 4 hours each, is **about 2,400 rows a day, 2.4% of the limit**, about 51% with the uploads. A heartbeat less than `lobbyHeartbeatMinSeconds` after the last heartbeat or close gets `429` and writes nothing. A close keeps the row (and its time), so closing and reopening doesn't get round it: per 30 s a host writes at most a heartbeat (2 rows when it reopens) and a close (1), **6 rows a minute, 8,640 a day (8.6%)**. A tool that only sends heartbeats too fast writes 2 a minute, 2,880 a day. Revoke a token that misbehaves.
- **Cleanup.** A closed lobby, or one past `lobbyTtlSeconds`, isn't listed. The cron (every 10 minutes) deletes the rows whose last heartbeat or close is past the TTL (by then past the rate limit's window too): one statement that reads the table (one row per host) and writes one row per deleted lobby. A host's next heartbeat reuses its row anyway, so the table never holds more rows than there are hosts.
- **Reads.** `GET /api/lobbies?region=` reads the region's rows through the index and a host each: about 10 rows with 5 lobbies open. A browser polling every `lobbiesCacheSeconds` (15 s) is 240 reads an hour, about 2,400 rows: 100 hours of the page open a day is 240,000 rows, 5% of the limit. A heartbeat reads the host and its row (twice when it opens a lobby).
