-- The display rating got a new curve (a new player shows 1000, weak players ease toward 900), six
-- tiers, and a damping of 6 instead of 5, so every rating is stale. This is `markAllStale`: the
-- cron re-rates everything from the first match. A later change to the rating config needs the same.
UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stale_played_at = '', stale_match_id = 0
WHERE board = 'ranked';
