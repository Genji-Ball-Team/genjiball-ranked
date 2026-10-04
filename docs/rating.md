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

A full OpenSkill game moves a rating a lot, and a match has around 25 rounds. So each round moves mu by only 1/`ratingRoundsPerMatch` of what a full game would. `ratingTau`, the uncertainty that keeps old ratings movable, is spread the same way. With the default of 4, a match of 25 rounds moves mu about as much as 6 full games.

Sigma takes each round's full update. It used to be damped too, and then it never settled: a regular with 400 rounds still had a sigma near 6, almost a newcomer's. The engine stayed unsure of everyone, so it kept paying a strong player a lot for beating far weaker ones, and the top of the ladder kept climbing. On test.genjiball.us, match 198 gave a 2331 player +231 for 22 wins against two players at the 900 floor (about 5 points a win; now about 2). Replaying the v1.3.2 logs a second and third time took the top player from 2572 to 3111 and 3283; now it goes from about 2050 to 2440, and slows down.

## Per-match cap

After a match, nobody's display rating is more than `ratingMatchMaxChange` (150) points from where they started it, either way. It's a safety net for a long lobby against much weaker (or much stronger) players, and for a newcomer's lucky first match now that they show on the leaderboard after 3 rounds. On the v1.3.2 logs it changes prediction by less than 0.01. Tournaments have their own cap (below).

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

**The recompute** (`recomputeRatings`) re-rates from the first stale match on. It starts each player from their last `rating_history` row before it (a history row holds the whole rating), which gives exactly what a recompute from scratch would, and writes only the history and ratings rows that differ. A match that no longer counts loses its history, and a player left with no rated match loses their ratings row. One run re-rates at most `ratingMatchesPerRun` matches (100 by default, about 0.5 ms of CPU each) and moves the stale point past them, so a long recompute continues on the next run.

**The cron** (`[triggers]` in `wrangler.toml`, every 10 minutes) runs `updateRatings`: it rates the matches that became due (incomplete ones past their grace period, or any an upload failed to rate) and carries on the recompute while the ratings are stale. That's 144 runs a day. With the default of 100 matches a run, a full recompute of the v1.3.2 logs (220 matches) takes 3 runs.

The default fits the Workers Standard plan (30 s CPU an invocation; D1 includes 25 billion rows read and 50 million written a month). A day of recomputing at 100 a run reads about 3.6 million rows and writes up to about 230,000, far inside it. That would pass the free tier's 100,000 writes a day, so on the free plan set `RATING_MATCHES_PER_RUN = "10"` in `wrangler.toml`; the table below is for that setting, 1,440 re-rated matches a day. On the free tier:

| Cost | Nothing stale | Recomputing all day |
|---|---|---|
| Rows read | about 3 a run, 450 a day | about 2,500 a run, 360,000 a day (7% of 5 million) |
| Rows written | none | up to about 16 per match re-rated with indexes, 23,000 a day (23% of 100,000) |
| Invocations | 144 a day, out of 100,000 | the same |

Every 5 minutes would double the recompute speed but, during a long recompute on a busy day of uploads (about 44,500 rows written, docs/database.md), could pass the daily write limit. Every 10 minutes keeps the worst case under it.

**Concurrent writes.** Every rating write is one batch that starts by checking `rating_state.version` and moving it on. If another write landed since the data was read, the batch fails and writes nothing; the cron tries again.

## Display rating and tiers

The leaderboard shows an Elo-like number from the conservative rating, mu − `displayZ`·sigma. With `x = displayScale · (mu − displayZ · sigma − ratingMu)`:

```
x ≥ 0:  display = displayCenter + x
x < 0:  display = displayFloor + (displayCenter − displayFloor) · e^(x / (displayCenter − displayFloor))
```

rounded. A new player shows `displayCenter` (1000). Above it the number rises `displayScale` (70) per point of mu. Below it the curve eases toward `displayFloor` (900) and never reaches it, with the same slope at the center, so a weak player settles in the 900s and climbs again as they improve. `displayZ` is 0: the number follows mu alone, so it doesn't drift up as sigma shrinks. Someone who stops playing keeps their number.

The tiers are Apprentice 1300, Master 1600, Grandmaster 1900, Ascendant 2200, Champion 2500 and God 2800. A player shows on the leaderboard, and gets a tier, from `minRankedRounds` (3) rated rounds: someone who drops into one lobby sees themselves there. The per-match cap keeps a lucky first match from putting them high. The labels and colours are those of GenjiBall-CE `src/features/rank-tags.opy`, plus Apprentice (bronze), which that file needs a sixth list for.

## Tuning

`npm run tune:rating -- <log folder>` replays real logs (legacy v1.3.2 files for now) through the parser and the engine, offline, with the config in `src/config.ts`. It prints:

- **Prediction:** before each round is rated, how likely the ratings so far made its finishing order, against a random order (Plackett-Luce log-likelihood, nats per round). Higher is better. Only the newest 40% of rounds count, and only rounds where every player already had 20 rated rounds.
- **Movement:** how far a regular's (50+ rounds) display rating moves in one match: median and 90th percentile. Lower is a steadier leaderboard.

It also prints how many players each tier holds with the config's display scale and with a few others (40 to 100), to pick `displayScale`. `--grid` sweeps `ratingRoundsPerMatch`, `ratingBeta` and `ratingTau` instead.

On the 306 v1.3.2 files of Sep 22 to Oct 3, 2026 (220 matches, 2,728 rated rounds), with sigma undamped, the per-match cap and display scale 70:

| `ratingRoundsPerMatch` | Prediction | Move median | Move p90 |
|---|---|---|---|
| 1 | 0.86 | 48 | 150 |
| 2 | 0.85 | 17 | 109 |
| 3 | 0.84 | 10 | 74 |
| 4 | 0.82 | 8 | 55 |
| 5 | 0.81 | 6 | 44 |
| 10 | 0.73 | 3 | 22 |

Damping is the setting that matters: higher is steadier but predicts worse, and makes the ratings slower to learn, so players keep climbing toward their real level for longer. The default is **4**: it predicts as well as the old setup (damping 6 with sigma damped too, 0.83) and moves a regular about 40% less a match (median 8 and p90 55, against 14 and 93; the v1.3.2 rating system moved regulars a median of 21 and a p90 of 73). Beta and tau barely change anything.

With those settings, 329 players have 3+ rated rounds: 18 are Apprentice, 7 Master, 2 Grandmaster and none higher. The top two are MauMau (2084) and DrunkenWiz (2043). Scale 80 would add one Ascendant, 100 one Champion; 70 leaves room at the top while the ladder fills with v1.3.3R matches.

- Re-run it when there are a few weeks of v1.3.3R logs, and refit `displayScale` if the tiers fill faster or slower than wanted.
- The host of these lobbies (Fealthy, in every file) comes last: many of their lines are deaths with no attacker, probably rounds they weren't really playing. Check how hosts show up in v1.3.3R logs.
- After changing the rating config, add a migration that marks every rating stale (like `migrations/0007_rating_convergence.sql`), so the cron recomputes them.

## Tournaments

`POST /api/admin/matches/:id/tournament` marks a match. Its rounds are damped `tournamentWeight` (3) times less, so it counts that many times as much. Afterwards nobody's display rating is more than `tournamentMaxChange` (200) points from where they started it, either way. The cap is the same both ways, so tournaments don't add points to the ladder.

There is one leaderboard. Tourney matches are on it with ranked ones; they only count more. A match is a tournament once an admin links it to a tourney lobby (`POST /api/admin/lobbies/:id`, [api.md](api.md)), or marks it by hand with the route above. Unlinking it, or deleting the lobby, makes it a normal match again. Either way the ratings are recomputed from it.
