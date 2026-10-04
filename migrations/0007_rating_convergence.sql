-- Sigma now takes each round's full update (only mu is damped), damping is 4 instead of 6, and a
-- match moves no one more than ratingMatchMaxChange display points, so every rating is stale. This
-- is `markAllStale`: the cron re-rates everything from the first match.
UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stale_played_at = '', stale_match_id = 0
WHERE board = 'ranked';
