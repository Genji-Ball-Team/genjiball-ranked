-- Regions (#47): EU and NA play apart. A match belongs to the region it was hosted in, and each
-- region is its own leaderboard: `ratings.board`, `rating_history.board` and `rating_state.board`
-- are the region id. Players and aliases stay shared. The region list is `regions` in src/config.ts.

-- A host's home region, set by an admin. NULL: every upload must say its region (`X-Region`).
ALTER TABLE hosts ADD COLUMN region TEXT;
-- The region the match was hosted in. A longer copy keeps it.
ALTER TABLE matches ADD COLUMN region TEXT;
ALTER TABLE tourneys ADD COLUMN region TEXT;

-- Everything stored before regions was played in EU, and the one leaderboard becomes EU's.
UPDATE hosts SET region = 'eu';
UPDATE matches SET region = 'eu';
UPDATE tourneys SET region = 'eu';
UPDATE ratings SET board = 'eu' WHERE board = 'ranked';
UPDATE rating_history SET board = 'eu' WHERE board = 'ranked';
UPDATE rating_state SET board = 'eu' WHERE board = 'ranked';
INSERT INTO rating_state (board) VALUES ('na');

-- The rating reads a region's matches in play order: accepted ones, unrated ones, the newest rated.
CREATE INDEX matches_region_status_played ON matches(region, status, played_at);
DROP INDEX matches_unrated;
CREATE INDEX matches_unrated ON matches(region, played_at) WHERE status = 'accepted' AND rated_at IS NULL;
DROP INDEX matches_rated;
CREATE INDEX matches_rated ON matches(region, played_at) WHERE rated_at IS NOT NULL;
-- Tourneys page: a region's upcoming tourneys by start, past ones newest first.
DROP INDEX tourneys_status_starts;
CREATE INDEX tourneys_region_status_starts ON tourneys(region, status, starts_at);
