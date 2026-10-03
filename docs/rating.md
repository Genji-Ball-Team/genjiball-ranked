# Rating

The rating engine is `src/rating/engine.ts`. It's pure: it takes rounds and returns ratings, and doesn't touch the database. Its tunables are the `rating…`, `display…` and `tiers` entries in `src/config.ts`.

The priority is a **stable leaderboard**: one round, one lucky streak or one bad night shouldn't move anyone far.

## What is rated

Each rated round is one game of [OpenSkill](https://github.com/philihp/openskill.js) (Plackett-Luce), ranked by its finishing order. What counts as a rated round comes from GenjiBall-CE [`docs/ranked-log.md`](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md), "How the server rates a round":

- Only `WIN` rounds that aren't broken. The order is the winner, then the `ELIM`s from last out to first.
- A player who left during the round is dropped from it: their rating doesn't change, and the others are rated on their order without them. Leaving is never punished.
- A round needs at least 2 players after that.

The parser builds the finishing order. The engine gets it with player ids (`players.id`) instead of log ids.

## Damping

A full OpenSkill game moves a rating a lot, and a match has around 25 rounds. So each round moves mu, and shrinks the variance, by only 1/`ratingRoundsPerMatch` of what a full game would. `ratingTau`, the uncertainty that keeps old ratings movable, is spread the same way. With the default of 10, a match of 25 rounds counts about as much as 2.5 full games.

## Recompute

Ratings are always rebuildable from scratch: `recompute` rates the matches that count (accepted, not void, legacy included) in play order (`played_at`, then id), starting everyone at `ratingMu` ± `ratingSigma`. The same matches always give the same ratings. Rating a new match as it arrives (`rateMatch`) gives exactly what a recompute would, as long as it's the newest match. A void or a late upload of an older match needs a recompute.

## Ratings in the database

`src/rating/update.ts` keeps `ratings` and `rating_history` up to date. `src/rating/plan.ts` decides what to write (pure, like the engine) and `src/rating/store.ts` holds the queries.

**Which matches count:** accepted ones (`status`), complete (with `MATCH_END`), or incomplete and started more than `ratingIncompleteGraceHours` ago: until then a longer copy may still arrive. `matches.rated_at` says which matches are in the ratings now.

**A new match.** After an upload stores an accepted match, `rateNewMatches` looks at the matches that count and aren't rated yet:

- After the newest rated match, in play order (`played_at`, then id): rated on top of the current ratings, writing `ratings`, `rating_history` and `rated_at`. This is what a recompute would give.
- Before it (a late upload, or an incomplete match whose grace period just ended): the ratings are **stale** from that match on. It's left for the recompute.

A longer copy that replaces a rated match makes the ratings stale from it too, in the upload's own batch. For whatever else changes a rated match (a void or un-void, accepting a match from the review queue, #7), call `markMatchesChanged`; after a change to the rating config or the engine, `markAllStale`.

**Stale ratings** are recorded in `rating_state`: the first match to re-rate. New matches are still rated on top in the meantime, so the leaderboard keeps moving; the recompute redoes them.

**The recompute** (`recomputeRatings`) re-rates from the first stale match on. It starts each player from their last `rating_history` row before it (a history row holds the whole rating), which gives exactly what a recompute from scratch would, and writes only the history and ratings rows that differ. A match that no longer counts loses its history, and a player left with no rated match loses their ratings row. One run re-rates at most `ratingMatchesPerRun` matches (about 0.5 ms of CPU each; the free plan allows 10 ms an invocation) and moves the stale point past them, so a long recompute continues on the next run.

**The cron** (`[triggers]` in `wrangler.toml`, daily) runs `updateRatings`: it rates the matches that became due (incomplete ones past their grace period, or any an upload failed to rate) and carries on the recompute while the ratings are stale.

**Concurrent writes.** Every rating write is one batch that starts by checking `rating_state.version` and moving it on. If another write landed since the data was read, the batch fails and writes nothing; the cron tries again.

## Display rating and tiers

The leaderboard shows an Elo-like number from the conservative rating, mu − `displayZ`·sigma:

```
display = displayCenter + displayScale · (mu − displayZ · sigma − ratingMu)
```

rounded and never below `displayFloor`. A new player has a large sigma, so they start at the floor and climb as the server gets surer of them. Someone who stops playing keeps their number.

The tiers (Master 1300, Grandmaster 1600, Ascendant 1900, Champion 2300, God 2600) are the v1.3.2 ones, with the labels and colours of GenjiBall-CE `src/features/rank-tags.opy`.

**The scale isn't calibrated yet.** The defaults were checked on simulated lobbies only: the stronger regulars reach Master and Grandmaster, and newcomers sit at the floor for their first few matches. Once the old logs are imported (#13), set `displayCenter` and `displayScale` so the tiers hold about as many players as they did in v1.3.2.
