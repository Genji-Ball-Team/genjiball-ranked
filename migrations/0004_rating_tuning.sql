-- The rating config was tuned on the v1.3.2 logs (docs/rating.md, "Tuning"): damping, tau and the
-- display scale changed, so every rating is stale. This is `markAllStale`: the cron re-rates
-- everything from the first match. A later change to the rating config needs the same.
UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stale_played_at = '', stale_match_id = 0
WHERE board = 'ranked';
