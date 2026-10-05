-- The match feed and moved matches (#47, #59): an admin moving a match to another region
-- (POST /api/admin/matches/:id/region) lists it again, and `feed_left_region` remembers the region it
-- left, so a reader of that region's feed (`?region=`) gets it as removed and takes its post down.
ALTER TABLE matches ADD COLUMN feed_left_region TEXT;

CREATE TRIGGER matches_feed_region AFTER UPDATE OF region ON matches
WHEN NEW.region IS NOT OLD.region AND (NEW.status IN ('accepted', 'void') OR OLD.status IN ('accepted', 'void'))
BEGIN
  UPDATE matches SET feed_left_region = OLD.region, feed_seq = (SELECT coalesce(max(feed_seq), 0) + 1 FROM matches)
  WHERE id = NEW.id;
END;
