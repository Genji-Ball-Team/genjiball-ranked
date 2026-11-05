-- Duels (docs/database.md, "Duels"; docs/rating.md, "Duels"): 1v1s that an admin enters by hand,
-- with no log. Each duel is a `matches` row (`duel` = 1) in its region, so the ratings rate it in
-- play order with everything else (a recompute keeps it), with two `match_players` rows: log id 1 is
-- the winner and 2 the loser, so a player merge moves them like any match. Its score is in `duels`.
-- A duel has no rounds, events, stats or head-to-head rows, and it's never in the match feed.

ALTER TABLE matches ADD COLUMN duel INTEGER NOT NULL DEFAULT 0 CHECK (duel IN (0, 1));

-- The score of a duel match. `rated` = 0: past `duelPairDailyRatedLimit` for the pair that day, so it
-- lists but doesn't change ratings (decided when it was entered).
CREATE TABLE duels (
  match_id      INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  winner_score  INTEGER NOT NULL CHECK (winner_score > 0),
  loser_score   INTEGER NOT NULL CHECK (loser_score >= 0 AND loser_score < winner_score),
  rated         INTEGER NOT NULL DEFAULT 1 CHECK (rated IN (0, 1)),
  admin_id      INTEGER REFERENCES admins(id)
);

-- The Duels tab: a region's accepted duels, newest first.
CREATE INDEX matches_duels ON matches(region, played_at) WHERE duel = 1 AND status = 'accepted';

-- A match needs a host and an upload: duels share one of each, made by the first save
-- (src/duels/store.ts), which no one can upload with (the token hash isn't a SHA-256, and the host is
-- revoked) and whose log is empty.

-- The match feed lists no duels: the same triggers, for matches that aren't duels.
DROP TRIGGER matches_feed_insert;
CREATE TRIGGER matches_feed_insert AFTER INSERT ON matches
WHEN NEW.status IN ('accepted', 'void') AND NEW.duel = 0
BEGIN
  UPDATE matches SET feed_seq = (SELECT coalesce(max(feed_seq), 0) + 1 FROM matches) WHERE id = NEW.id;
END;

DROP TRIGGER matches_feed_update;
CREATE TRIGGER matches_feed_update AFTER UPDATE OF status, line_count, rated_at, tournament ON matches
WHEN NEW.duel = 0 AND (NEW.status IN ('accepted', 'void') OR OLD.status IN ('accepted', 'void'))
  AND (NEW.status IS NOT OLD.status OR NEW.line_count IS NOT OLD.line_count
    OR (OLD.rated_at IS NULL AND NEW.rated_at IS NOT NULL) OR NEW.tournament IS NOT OLD.tournament)
BEGIN
  UPDATE matches SET feed_seq = (SELECT coalesce(max(feed_seq), 0) + 1 FROM matches) WHERE id = NEW.id;
END;

DROP TRIGGER matches_feed_region;
CREATE TRIGGER matches_feed_region AFTER UPDATE OF region ON matches
WHEN NEW.duel = 0 AND NEW.region IS NOT OLD.region
  AND (OLD.feed_seq IS NOT NULL OR NEW.status IN ('accepted', 'void') OR OLD.status IN ('accepted', 'void'))
BEGIN
  UPDATE matches SET
    feed_left_regions = CASE WHEN instr(coalesce(feed_left_regions, ','), ',' || OLD.region || ',') > 0 THEN feed_left_regions
      ELSE coalesce(feed_left_regions, ',') || OLD.region || ',' END,
    feed_seq = (SELECT coalesce(max(feed_seq), 0) + 1 FROM matches)
  WHERE id = NEW.id;
END;
