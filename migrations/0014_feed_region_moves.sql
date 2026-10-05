-- The match feed and moved matches (#47, #59): an admin moving a match to another region
-- (POST /api/admin/matches/:id/region) lists it again, and `feed_left_regions` remembers every region
-- it left (`,eu,na,`), so a reader of such a region's feed (`?region=`) gets it as removed and takes
-- its post down, even after the match moved on again before that reader asked. A match that was
-- public before (feed_seq is set) keeps its removal even when it moves after leaving public.
ALTER TABLE matches ADD COLUMN feed_left_regions TEXT;

CREATE TRIGGER matches_feed_region AFTER UPDATE OF region ON matches
WHEN NEW.region IS NOT OLD.region
  AND (OLD.feed_seq IS NOT NULL OR NEW.status IN ('accepted', 'void') OR OLD.status IN ('accepted', 'void'))
BEGIN
  UPDATE matches SET
    feed_left_regions = CASE WHEN instr(coalesce(feed_left_regions, ','), ',' || OLD.region || ',') > 0 THEN feed_left_regions
      ELSE coalesce(feed_left_regions, ',') || OLD.region || ',' END,
    feed_seq = (SELECT coalesce(max(feed_seq), 0) + 1 FROM matches)
  WHERE id = NEW.id;
END;
