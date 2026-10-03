-- Ratings in D1: which matches are rated, when the ratings are stale, and enough history to resume
-- a recompute part way through. See docs/rating.md, "Ratings in the database".

-- When the match went into the ratings. NULL: not rated (yet, or any more).
-- Matches stored before this migration start unrated: nothing wrote ratings or history yet, so
-- rating them in play order from new ratings (rateNewMatches) is the same as a recompute.
ALTER TABLE matches ADD COLUMN rated_at TEXT;
-- Matches waiting to be rated: accepted, and new or incomplete within the grace period.
CREATE INDEX matches_unrated ON matches(played_at) WHERE status = 'accepted' AND rated_at IS NULL;
-- The newest rated match: a match after it can be rated on top of the current ratings.
CREATE INDEX matches_rated ON matches(played_at) WHERE rated_at IS NOT NULL;

-- A history row is the player's whole rating after the match, so a recompute can start from it.
ALTER TABLE rating_history ADD COLUMN rounds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rating_history ADD COLUMN wins INTEGER NOT NULL DEFAULT 0;
-- A recompute rewrites the history of the matches it re-rates.
CREATE INDEX rating_history_match ON rating_history(match_id);

-- One row per leaderboard. `version` goes up on every rating write, so a write that started from
-- older data fails instead of overwriting newer ratings.
CREATE TABLE rating_state (
  board           TEXT PRIMARY KEY,
  version         INTEGER NOT NULL DEFAULT 0,
  -- Stale from this match on, in play order (played_at, then id): it and every later match must be
  -- re-rated. NULL when the ratings are up to date; '' and 0 to recompute everything.
  stale_played_at TEXT,
  stale_match_id  INTEGER,
  stale_since     TEXT,                       -- when the ratings went stale
  recomputed_at   TEXT                        -- last recompute run
);
INSERT INTO rating_state (board) VALUES ('ranked');
