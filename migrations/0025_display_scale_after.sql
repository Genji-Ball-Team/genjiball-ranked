-- Display scale 75 from the 800 start on (`displayScaleAfter`, `displayScaleAfterFrom` in src/config.ts).
-- See docs/rating.md, "Display rating and tiers".

-- A player's mu just before their first match from 2026-10-24 13:30 UTC on: the display shows mu up
-- to here at `displayScale` (70) and what they gained or lost since at `displayScaleAfter` (75).
-- NULL: no match since then, so all of it is at 70 and the shown number is as before.
ALTER TABLE ratings ADD COLUMN scale_base_mu REAL;
ALTER TABLE rating_history ADD COLUMN scale_base_mu REAL;

-- Re-rate from that moment on (the same as `staleFromStatement`, keeping an earlier start if a
-- region is already stale): the cron fills in `scale_base_mu` and the display of every match since.
-- Matches before it, and the players who haven't played since, stay exactly as they are.
UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stale_match_id = CASE WHEN stale_played_at IS NULL OR ('2026-10-24T13:30:00Z', 0) < (stale_played_at, stale_match_id)
    THEN 0 ELSE stale_match_id END,
  stale_played_at = CASE WHEN stale_played_at IS NULL OR ('2026-10-24T13:30:00Z', 0) < (stale_played_at, stale_match_id)
    THEN '2026-10-24T13:30:00Z' ELSE stale_played_at END;
