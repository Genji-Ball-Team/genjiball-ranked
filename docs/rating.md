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

A full OpenSkill game moves a rating a lot, and a match has around 25 rounds. So each round moves mu, and shrinks the variance, by only 1/`ratingRoundsPerMatch` of what a full game would. `ratingTau`, the uncertainty that keeps old ratings movable, is spread the same way. With the default of 5, a match of 25 rounds counts about as much as 5 full games.

## Recompute

Ratings are always rebuildable from scratch: `recompute` rates the matches that count (accepted, not void, legacy included) in play order (`played_at`, then id), starting everyone at `ratingMu` ± `ratingSigma`. The same matches always give the same ratings. Rating a new match as it arrives (`rateMatch`) gives exactly what a recompute would, as long as it's the newest match. A void or a late upload of an older match needs a recompute.

## Ratings in the database

`src/rating/update.ts` keeps `ratings` and `rating_history` up to date. `src/rating/plan.ts` decides what to write (pure, like the engine) and `src/rating/store.ts` holds the queries.

**Which matches count:** accepted ones (`status`), complete (with `MATCH_END`), or incomplete and started more than `ratingIncompleteGraceHours` ago: until then a longer copy may still arrive. `matches.rated_at` says which matches are in the ratings now.

**A new match.** After an upload stores an accepted match, `rateNewMatches` looks at the matches that count and aren't rated yet:

- After the newest rated match, in play order (`played_at`, then id): rated on top of the current ratings, writing `ratings`, `rating_history` and `rated_at`. This is what a recompute would give.
- Before it (a late upload, or an incomplete match whose grace period just ended): the ratings are **stale** from that match on. It's left for the recompute.

A longer copy that replaces a rated match makes the ratings stale from it too, in the upload's own batch. For whatever else changes a rated match, call `markMatchesChanged` (or put `staleFromMatchesStatement` in the batch that changes it); after a change to the rating config or the engine, `markAllStale`.

**Admin actions** ([api.md](api.md), "Admin"). A void marks the ratings stale from the match in the same batch as the status change. Accepting from the review queue and un-voiding make the match accepted and unrated, so `rateNewMatches` treats it like a new upload: rated on top if it's the newest, stale from it if it's late. After each of them the admin API runs `updateRatings` once, like a cron run, so a short tail is recomputed straight away and the cron finishes a longer one.

**Stale ratings** are recorded in `rating_state`: the first match to re-rate. New matches are still rated on top in the meantime, so the leaderboard keeps moving; the recompute redoes them.

**The recompute** (`recomputeRatings`) re-rates from the first stale match on. It starts each player from their last `rating_history` row before it (a history row holds the whole rating), which gives exactly what a recompute from scratch would, and writes only the history and ratings rows that differ. A match that no longer counts loses its history, and a player left with no rated match loses their ratings row. One run re-rates at most `ratingMatchesPerRun` matches (about 0.5 ms of CPU each; the free plan allows 10 ms an invocation) and moves the stale point past them, so a long recompute continues on the next run.

**The cron** (`[triggers]` in `wrangler.toml`, every 10 minutes) runs `updateRatings`: it rates the matches that became due (incomplete ones past their grace period, or any an upload failed to rate) and carries on the recompute while the ratings are stale. That's 144 runs and up to 1,440 re-rated matches a day. On the free tier:

| Cost | Nothing stale | Recomputing all day |
|---|---|---|
| Rows read | about 3 a run, 450 a day | about 2,500 a run, 360,000 a day (7% of 5 million) |
| Rows written | none | up to about 16 per match re-rated with indexes, 23,000 a day (23% of 100,000) |
| Invocations | 144 a day, out of 100,000 | the same |

Every 5 minutes would double the recompute speed but, during a long recompute on a busy day of uploads (about 44,500 rows written, docs/database.md), could pass the daily write limit. Every 10 minutes keeps the worst case under it.

**Concurrent writes.** Every rating write is one batch that starts by checking `rating_state.version` and moving it on. If another write landed since the data was read, the batch fails and writes nothing; the cron tries again.

## Display rating and tiers

The leaderboard shows an Elo-like number from the conservative rating, mu − `displayZ`·sigma:

```
display = displayCenter + displayScale · (mu − displayZ · sigma − ratingMu)
```

rounded and never below `displayFloor`. A new player has a large sigma, so they start low (about 630) and an average player climbs as the server gets surer of them. Someone who stops playing keeps their number.

The tiers (Master 1300, Grandmaster 1600, Ascendant 1900, Champion 2300, God 2600) are the v1.3.2 ones, with the labels and colours of GenjiBall-CE `src/features/rank-tags.opy`.

The scale is fitted to the v1.3.2 logs (see "Tuning" below).

## Tuning

`npm run tune:rating -- <log folder>` replays real logs (legacy v1.3.2 files for now) through the parser and the engine, offline, with the config in `src/config.ts`. It prints:

- **Prediction:** before each round is rated, how likely the ratings so far made its finishing order, against a random order (Plackett-Luce log-likelihood, nats per round). Higher is better. Only the newest 40% of rounds count, and only rounds where every player already had 20 rated rounds.
- **Movement:** how far a regular's (50+ rounds) display rating moves in one match: median and 90th percentile. Lower is a steadier leaderboard.
- How many players reach each tier, against how many v1.3.2 tagged (`rank1_names`... in GenjiBall-CE `original/genjiball-v1.3.2-ranked.txt`: 17 Master, 4 Grandmaster, 3 Ascendant), and the `displayCenter` and `displayScale` that fit those counts best.

`--grid` sweeps `ratingRoundsPerMatch`, `ratingBeta` and `ratingTau` instead.

On the 306 v1.3.2 files of Sep 22 to Oct 3, 2026 (192 matches, 2,560 rated rounds):

| `ratingRoundsPerMatch` | Prediction | Move median | Move p90 |
|---|---|---|---|
| 1 | 0.85 | 44 | 166 |
| 3 | 0.85 | 31 | 124 |
| **5** | **0.84** | **27** | **99** |
| 10 | 0.80 | 17 | 66 |
| 20 | 0.74 | 11 | 40 |

Damping is the setting that matters: up to 5 predicts about as well as rating every round in full, and moves half as much; past it, prediction drops. Beta and tau barely change anything (tau 25/100 is a little better than 25/300). The fitted display scale is center 1780, scale 46: 24 players at Master or above, 9 at Grandmaster, 2 at Ascendant. The top of the board is the players v1.3.2 tagged.

- Re-run it when there are a few weeks of v1.3.3R logs. Regulars' sigma is still shrinking after 11 days, so their display rating will rise and the tiers will fill: refit `displayCenter` and `displayScale` then.
- The host of these lobbies (Fealthy, in every file) comes last: many of their lines are deaths with no attacker, probably rounds they weren't really playing. Check how hosts show up in v1.3.3R logs.
- After changing the rating config, add a migration that marks every rating stale (like `migrations/0004_rating_tuning.sql`), so the cron recomputes them.
