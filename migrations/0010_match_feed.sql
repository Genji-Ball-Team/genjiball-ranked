-- The feed of public matches (GET /api/matches?after=, #59): `feed_seq` goes up each time a match
-- changes in a way a post about it should show, so a reader asking "what changed after N" also sees
-- late changes: accepted from review, a longer copy, voided or unvoided, rated, linked to a tourney.
ALTER TABLE matches ADD COLUMN feed_seq INTEGER;
CREATE UNIQUE INDEX matches_feed ON matches(feed_seq);

-- The public matches already stored, in upload order.
UPDATE matches SET feed_seq = id WHERE status IN ('accepted', 'void');

-- Writes serialize in D1, so max + 1 is never handed out twice; a multi-row UPDATE runs the trigger
-- row by row, each seeing the last.
CREATE TRIGGER matches_feed_insert AFTER INSERT ON matches
WHEN NEW.status IN ('accepted', 'void')
BEGIN
  UPDATE matches SET feed_seq = (SELECT coalesce(max(feed_seq), 0) + 1 FROM matches) WHERE id = NEW.id;
END;

-- A match leaving the public statuses (unvoided back to rejected) is listed once more, so a post
-- about it can be taken down.
CREATE TRIGGER matches_feed_update AFTER UPDATE OF status, line_count, rated_at, tournament ON matches
WHEN (NEW.status IN ('accepted', 'void') OR OLD.status IN ('accepted', 'void'))
  AND (NEW.status IS NOT OLD.status OR NEW.line_count IS NOT OLD.line_count
    OR (OLD.rated_at IS NULL AND NEW.rated_at IS NOT NULL) OR NEW.tournament IS NOT OLD.tournament)
BEGIN
  UPDATE matches SET feed_seq = (SELECT coalesce(max(feed_seq), 0) + 1 FROM matches) WHERE id = NEW.id;
END;
