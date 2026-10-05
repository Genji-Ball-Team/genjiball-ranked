-- Rating history graph (#17) and records (#19). See docs/database.md, "Records".

-- Win streaks: rated rounds won in a row, kept with the rating in play order so a late upload or a
-- void is handled by the recompute like the rest of the rating. `best_streak`: the longest so far.
ALTER TABLE ratings ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ratings ADD COLUMN best_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rating_history ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rating_history ADD COLUMN best_streak INTEGER NOT NULL DEFAULT 0;
-- Highest rating ever: the region's top history row.
CREATE INDEX rating_history_board_display ON rating_history(board, display DESC, played_at, match_id);

-- The stored streaks are 0 until re-rated. This is `markAllStale`: the cron re-rates everything
-- from the first match and fills them in, `RATING_MATCHES_PER_RUN` matches a run (5 in
-- wrangler.toml; the writes are in docs/rating.md).
UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stale_played_at = '', stale_match_id = 0;

-- One row per accepted match: its bests, for the records, and what the activity counts. Derived
-- from `rounds`, `match_players` and `events` by the cron (src/records/), which follows the match
-- feed (`feed_seq`) from `records_state.feed_cursor`; a match leaving is dropped at once by a
-- trigger (below). Players are log ids of the match, so merging aliases needs no rewrite: they're
-- looked up in `match_players`.
CREATE TABLE match_stats (
  match_id         INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  region           TEXT NOT NULL,             -- matches.region, kept in step by a trigger
  line_count       INTEGER NOT NULL,          -- matches.line_count it was counted from
  host_id          INTEGER NOT NULL,
  played_at        TEXT NOT NULL,
  rated_rounds     INTEGER NOT NULL,
  round_deflects   INTEGER,                   -- most DEFLECTs by one player in one round
  round_deflects_by INTEGER,                  -- log id
  round_deflects_round INTEGER,
  fastest_deflect  REAL,                      -- highest DEFLECT speed
  fastest_deflect_by INTEGER,
  fastest_deflect_round INTEGER,
  match_kills      INTEGER,                   -- most KILLs by one player (not themselves)
  match_kills_by   INTEGER,
  match_wins       INTEGER,                   -- most rated rounds won by one player
  match_wins_by    INTEGER
);
-- Each record is the top of its index (ties: the earliest); the activity reads a window by date;
-- top hosts counts by host.
CREATE INDEX match_stats_round_deflects ON match_stats(region, round_deflects DESC, played_at, match_id);
CREATE INDEX match_stats_fastest_deflect ON match_stats(region, fastest_deflect DESC, played_at, match_id);
CREATE INDEX match_stats_match_kills ON match_stats(region, match_kills DESC, played_at, match_id);
CREATE INDEX match_stats_match_wins ON match_stats(region, match_wins DESC, played_at, match_id);
CREATE INDEX match_stats_played ON match_stats(region, played_at);
CREATE INDEX match_stats_host ON match_stats(region, host_id);

-- Where the cron has read the match feed up to. 0: rebuild every match's stats.
CREATE TABLE records_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  feed_cursor INTEGER NOT NULL DEFAULT 0
);
INSERT INTO records_state (id) VALUES (1);

-- Each region's records revision: goes up whenever what its records count changes (a match's stats
-- written or dropped, a match leaving or joining the region). Never goes down, so a rebuild that
-- read revision N can't hide a change made while it ran. `urgent`: the revision at which an
-- accepted match left the region's records; stored records older than it may name a match that
-- isn't public there any more, and are rebuilt on the next cron run.
CREATE TABLE records_revisions (
  region   TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  urgent   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO records_revisions (region) VALUES ('eu'), ('na');

-- The records page of each region, as served (`GET /api/records`), and the records revision and
-- `rating_state.version` it was made from.
CREATE TABLE records (
  region         TEXT PRIMARY KEY,
  body           TEXT NOT NULL,              -- JSON
  refreshed_at   TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  rating_version INTEGER NOT NULL
);

-- An accepted match that stops being accepted (voided, rejected, back in review with a longer copy)
-- or moves to the other region: in the same transaction, its stats go (or move along), and both
-- regions' revisions go up, the old one urgently.
CREATE TRIGGER match_stats_leave AFTER UPDATE OF status, region ON matches
WHEN OLD.status = 'accepted' AND (NEW.status IS NOT 'accepted' OR NEW.region IS NOT OLD.region)
BEGIN
  DELETE FROM match_stats WHERE match_id = NEW.id AND NEW.status IS NOT 'accepted';
  UPDATE match_stats SET region = NEW.region WHERE match_id = NEW.id;
  INSERT OR IGNORE INTO records_revisions (region) VALUES (OLD.region);
  UPDATE records_revisions SET revision = revision + 1, urgent = revision + 1 WHERE region = OLD.region;
  INSERT OR IGNORE INTO records_revisions (region) SELECT NEW.region WHERE NEW.region IS NOT OLD.region;
  UPDATE records_revisions SET revision = revision + 1 WHERE region = NEW.region AND NEW.region IS NOT OLD.region;
END;
