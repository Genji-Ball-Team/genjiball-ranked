-- A player's first `ratingUnratedRounds` (3) rounds in a region are no longer rated: the round is
-- rated without them, so every rating is stale. This is `markAllStale` for every region: the cron
-- re-rates everything from the first match (docs/rating.md, "What is rated").
UPDATE rating_state SET version = version + 1, stale_since = coalesce(stale_since, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stale_played_at = '', stale_match_id = 0;
