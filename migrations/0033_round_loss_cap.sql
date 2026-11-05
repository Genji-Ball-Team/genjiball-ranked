-- Per-round loss cap (`ratingRoundLossCap`, `ratingRoundLossCapFrom`, `ratingRoundLossCapFromByRegion`
-- in src/config.ts): in a rated round nobody loses more than 3.7 times what winning it would have
-- gained them. See docs/rating.md, "Per-round loss cap".

-- EU has it from the 800 start (2026-10-24 13:30 UTC): re-rate from there on (the same as
-- `staleFromStatement`, keeping an earlier start if EU is already stale). Matches before it stay as they are.
UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stale_match_id = CASE WHEN stale_played_at IS NULL OR ('2026-10-24T13:30:00Z', 0) < (stale_played_at, stale_match_id)
    THEN 0 ELSE stale_match_id END,
  stale_played_at = CASE WHEN stale_played_at IS NULL OR ('2026-10-24T13:30:00Z', 0) < (stale_played_at, stale_match_id)
    THEN '2026-10-24T13:30:00Z' ELSE stale_played_at END
  WHERE board = 'eu';

-- NA has it for every match: re-rate NA from the start.
UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stale_match_id = 0, stale_played_at = ''
  WHERE board = 'na';
