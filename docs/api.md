# API

What the server offers the host tool ([genjiball-host-tool](https://github.com/Genji-Ball-Team/genjiball-host-tool)), admins and other clients. All responses are JSON. An error is `{ "error": "<code>", "message": "<for people>" }` with a 4xx status.

## Regions

EU and NA play apart (#47). Every match belongs to the region it was hosted in, and each region has its own ratings, leaderboard, rank tags and tourneys; a player who plays in both has a rating in each. Players and their names are shared. The regions are `regions` in `src/config.ts`: `eu` (Europe) and `na` (North America). `GET /api/server` lists them (`{ testServer, regions: [{ id, label }] }`).

- **Uploads** say their region with `X-Region`, or get the host's home region, which an admin sets. Neither: `422 no_region`. The Workshop can't read the server region, so the log doesn't say it.
- **Reads** of regional data take `?region=` and answer for the first region without it.
- Matches stored before regions were all put in `eu` (`migrations/0010_regions.sql`).

## Upload a log: `POST /api/upload`

The host tool sends a Workshop log file (`Documents/Overwatch/Workshop/Log-*.txt`) as it is. Code: `src/upload/`.

| Part | |
|---|---|
| Body | The file's text, unchanged (UTF-8). At most `maxUploadBytes` (512 KB) |
| `Authorization` | `Bearer <host token>`. Admins hand out tokens ([Admin](#admin-apiadmin)); the server stores only their SHA-256 |
| `X-Log-File` | Optional. The file name |
| `X-Log-Started-At` | Optional. When the file was started, ISO 8601 with a time zone (`2026-10-03T20:15:33+02:00`). The file name has no time zone, so send this: it orders the matches for the rating. Without it, or if it's in the future, the upload time is used |
| `X-Region` | The region the matches were hosted in: an id from `regions` (`eu`, `na`; [Regions](#regions)). Optional for a host with a home region (set by an admin), which is used without it. Send it whenever the host picked a region, so a night hosted in the other region isn't stored in the home one |

Upload every file, whenever it changes or stops growing: the server sorts out the copies (see "One match in several files" in GenjiBall-CE [`docs/ranked-log.md`](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md)). Sending the same file again is cheap and changes nothing.

### Response

`200`:

```json
{
  "result": "stored",
  "uploadId": 12,
  "region": "eu",
  "matches": [
    {
      "matchKey": "482913507226",
      "lineCount": 57,
      "region": "eu",
      "action": "insert",
      "status": "review",
      "rejection": null,
      "reviewReasons": ["duplicate_name"]
    }
  ]
}
```

`result`:

| Value | Meaning |
|---|---|
| `stored` | The file was stored: at least one match in it was new or longer than the stored copy |
| `unchanged` | Every match was already stored, as long or longer. Nothing was written; `uploadId` is `null` |
| `duplicate` | This exact file was uploaded before. `matches` is empty |

`region` is where the file's new matches are stored. Each match's `region` is the upload's for a new match, and the stored match's for another copy of it: a match stays in the region it was first stored in, whatever a later copy says.

Per match, `action`:

| Value | Meaning |
|---|---|
| `insert` | A new match |
| `replace` | A longer copy of a stored match: it replaces the stored one |
| `repoint` | The same as the stored copy. The stored match now points at this file (the older file is deleted when nothing points at it any more) |
| `skip` | The stored copy is longer, or the match has no `matchKey`. Nothing changed |

and `status`, the match's status after the upload:

| Value | Meaning |
|---|---|
| `accepted` | Counts for the ratings. A complete match is rated straight away; one with no `MATCH_END` after `ratingIncompleteGraceHours` (6 h), by the cron (every 10 minutes) ([rating.md](rating.md)) |
| `review` | Waits for an admin. `reviewReasons`: `duplicate_name` (two players with the same name at once), `untrusted_host` |
| `rejected` | Never counts. `rejection.code`: `unranked` (an `UNRANKED` line), `unknown_format` (kept to re-parse when the server learns the format), `too_few_players` (fewer than `minMatchPlayers`, 2, in rated rounds. A 1v1 with a rated round counts; a match with no rated round is rejected), `untrusted_host` (when `untrustedHostUploads` is `reject`), `no_match_key`, `admin` (an admin rejected it from the review queue; a longer copy doesn't change that) |
| `void` | An admin voided it. A longer copy doesn't change that |

### Errors

| Status | `error` | When |
|---|---|---|
| 400 | `empty` | No body |
| 400 | `bad_request` | `X-Region` isn't one of `regions` |
| 401 | `unauthorized` | No token, or an unknown one |
| 403 | `revoked` | The token was revoked. Stop uploading with it |
| 405 | `method_not_allowed` | Not a `POST` |
| 409 | `conflict` | Another upload of the same match was being stored at that moment. Try again |
| 413 | `too_large` | Over `maxUploadBytes` |
| 422 | `not_ranked` | No `GBR` line: not a ranked log. Don't upload these |
| 422 | `legacy_log` | A v1.3.2 log (`KILL` lines, no `GBR`). Old logs are imported by an admin (#13) |
| 422 | `no_region` | No `X-Region`, and the host has no home region. Nothing was stored: send the region |
| 429 | `rate_limited` | Over `maxUploadsPerHour` stored uploads for this token. `Retry-After` says when to try again |

A 5xx or a network error: keep the file and try again later.

## Check a host token: `GET /api/host/me`

The host tool calls this when a host enters their token, before any upload. `Authorization: Bearer <host token>`, as for an upload. Code: `src/upload/handler.ts`.

`200 { "host": { "id": 3, "name": "Kenzo", "trust": "trusted", "region": "eu" } }`, `trust` being `trusted` or `untrusted` and `region` the home region (`null`: every upload must send `X-Region`); the host tool's region setting starts from it. The errors are an upload's: `401 unauthorized` (no token or an unknown one), `403 revoked`, `405 method_not_allowed` (not a `GET`).

## Match status: `GET /api/host/matches?keys=<matchKey>,<matchKey>`

The host tool calls this now and then to show a match's status after an admin accepted, rejected or voided it. `Authorization: Bearer <host token>`, as for an upload; only the token's host's matches are answered. Code: `src/upload/handler.ts`.

`200 { "matches": [{ "matchKey": "482913507226", "matchId": 812, "status": "accepted", "rejection": null, "reviewReasons": [] }] }`, with `status`, `rejection` and `reviewReasons` as in an upload's answer. `matchId` is the match's id on the site (`/match?id=812`, `/api/matches/:id`), which a longer copy keeps; only `accepted` and `void` matches are public there. A key the host has no match for is left out. The errors are an upload's (`401`, `403`, `405`), and `400 bad_request` for over `hostMatchKeysMax` (50) keys.

## Admin: `/api/admin/*`

For admins, from the admin page (`/admin`) or any HTTP client. Code: `src/admin/`. Every request needs `Authorization: Bearer <admin token>`; without a valid, unrevoked one it's `401 unauthorized`. Every change is written to `admin_actions` (who, what, when, which match or host) in the same transaction.

**Admin tokens.** The server stores only their SHA-256, like host tokens. `npm run admin:token -- <name>` prints a new token and writes the SQL that adds the admin to a file, with the `wrangler d1 execute --file` command to run; revoke one by setting `admins.revoked_at`. The admin page keeps the token in the tab's `sessionStorage` and sends it as the header, so there's no cookie to forge a request with.

| Route | Does |
|---|---|
| `GET /api/admin/me` | `{ admin: { id, name } }`: checks a token |
| `GET /api/admin/hosts` | `{ hosts }`: newest first, at most `adminListLimit` |
| `POST /api/admin/hosts` | Body `{ "name": "...", "trust": "trusted" \| "untrusted", "region": "eu" }` (`untrusted` if left out; `region` the home region, none if left out). `201 { host, token }`: the **token is shown only here** |
| `POST /api/admin/hosts/:id/region` | Body `{ "region": "na" }`, or `null` for none. The home region for the host's next uploads without `X-Region`; stored matches keep theirs |
| `POST /api/admin/hosts/:id/trust` | Body `{ "trust": "trusted" \| "untrusted" }`. Applies to the host's next upload |
| `POST /api/admin/hosts/:id/revoke` | The token stops working (`403 revoked` on upload). Final: make a new host token instead |
| `GET /api/admin/matches?status=review&region=eu` | `{ matches }` with that status (`review` if left out; `accepted`, `rejected`, `void`), in that region (every region if left out), newest first, at most `adminListLimit`. Each has `region`, `reviewReasons`, `rejection`, `hostName`, `players`, `complete`, `rated` |
| `GET /api/admin/matches/:id` | `{ match }` |
| `POST /api/admin/matches/:id/accept` | `review` → `accepted`; also a match an admin rejected |
| `POST /api/admin/matches/:id/reject` | `review` → `rejected`, `rejection.code` `admin`. Body `{ "reason": "..." }` optional |
| `POST /api/admin/matches/:id/void` | `accepted` → `void`. Body `{ "reason": "..." }` optional |
| `POST /api/admin/matches/:id/unvoid` | `void` → `accepted`, or `rejected` if a longer copy that arrived while it was void was rejected (an `UNRANKED` line, say) |
| `GET /api/admin/actions` | `{ actions }`: the action log, newest first, at most `adminListLimit` |
| `POST /api/admin/matches/:id/tournament` | Body: `{"tournament": true}` or `false`. Marks the match as a tournament: it counts `tournamentWeight` times as much and nobody gains or loses more than `tournamentMaxChange` display points in it. A rated match makes the ratings stale from it. `409` if it already is that way or clearing the flag while a tourney lobby still links the match; unlink it first |
| `GET /api/admin/tourneys` | `{ tourneys }`: latest start first, at most `adminListLimit`, each with `lobbies` (`id, version, label, matchId, screenshotKey, screenshotAt, verifiedAt, verifiedBy`) |
| `POST /api/admin/tourneys` | Body `{ "name", "region", "startsAt", "notes"?, "status"? }`. `region`: where it's played; its lobbies' matches must be from there. `startsAt` is ISO 8601 with a time zone. `status`: `scheduled` (default), `live`, `done`, `cancelled`. `201 { tourney }` |
| `POST /api/admin/tourneys/:id` | Same fields, all optional: changes the ones sent. `409` for a new `region` while a lobby has a match |
| `POST /api/admin/tourneys/:id/lobbies` | Body `{ "label": "Lobby 1/2" }`. `201 { lobby }` |
| `POST /api/admin/lobbies/:id` | Body `{ "label"?, "matchId"? }`. `matchId` links the lobby's match (`null` unlinks it): the match becomes a tournament ([rating.md](rating.md)), and a new match clears the verification. `409` if the match is another lobby's or from another region than the tourney. `{ lobby, ratingsStale }` |
| `DELETE /api/admin/lobbies/:id` | Deletes the lobby and its screenshot; its match is no longer a tournament. `{ ratingsStale }` |
| `PUT /api/admin/lobbies/:id/screenshot` | Body: the image, PNG, JPEG or WebP (told apart by its first bytes, so any tool's image works), at most `screenshotMaxBytes` (8 MB). Replaces the old one, which needs verifying again, then expires the oldest screenshots past the storage caps ([database.md](database.md), "Screenshots in R2"). `{ lobby, expired }`, `expired` how many were detached and queued for R2 cleanup. `409` for a concurrent lobby change or storage full while cleanup is pending; `413 too_large`, `415 unsupported_type` |
| `DELETE /api/admin/lobbies/:id/screenshot` | Deletes the screenshot |
| `POST /api/admin/lobbies/:id/verify` | Body `{ "verified": true, "version": 3 }`: an admin checked the displayed screenshot against the standings; use the lobby's displayed `version`. Needs a match, screenshot and current version (`409` otherwise). `{ "verified": false }` clears verification; version is optional when clearing |
| `POST /api/admin/legacy-import?host=<id>&region=<region>` | Body: an old v1.3.2 log file, as with an upload. Stored as the host's legacy match ([legacy.md](legacy.md)), as from a trusted host and with no rate limit, in `region` or else the host's home region (`400` with neither). Answers like `POST /api/upload`; `422 not_legacy` for a file without `KILL` lines or with a `GBR` line. `npm run import:legacy` sends a folder of them |

A match action answers `{ match, ratingsStale }`. Accepting, voiding or un-voiding brings the ratings up to date as far as one cron run would ([rating.md](rating.md)): a match that now counts is rated straight away if it's the newest, and a short stale tail is recomputed. `ratingsStale: true` means the cron finishes the recompute (every 10 minutes).

**Decisions that last.** A longer copy of a match keeps an admin's void or rejection. An accept doesn't: a longer copy is judged again, and goes back to review if it still has a reason to (its new rounds haven't been looked at).

Lobby mutations return `409 conflict` if another edit, replacement, expiry or longer log changed their snapshot before the write. A longer log also clears its lobby's verification. Screenshot removal is immediate at the public API; R2 failures leave durable cleanup records for later uploads or the cron to retry.

`admin_actions.action`: `host_create`, `host_trust`, `host_revoke`, `host_region`, `match_accept`, `match_reject`, `match_void`, `match_unvoid`, `legacy_import`, `match_tournament`, `tourney_create`, `tourney_edit`, `lobby_create`, `lobby_edit`, `lobby_delete`, `lobby_screenshot`, `lobby_screenshot_delete`, `lobby_verify`. `detail` is JSON: the name and trust of a new host, `from` and `to` of a change, the `reason` when one was given, the `file` of an import, and the `tourney` and `lobby` ids of a tourney action.

### Errors

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | The body isn't a JSON object, a field is missing or wrong, or a name or reason is over `adminTextMaxLength` characters |
| 401 | `unauthorized` | No admin token, or an unknown or revoked one |
| 404 | `not_found` | No such route, match or host |
| 405 | `method_not_allowed` | Wrong method. `Allow` says which |
| 409 | `conflict` | The action doesn't fit the status (voiding a match in review, un-revoking a host), or another admin changed it at the same time |

## Site: `/api/leaderboard`, `/api/players/:id`, `/api/players?search=`, `/api/matches/:id`, `/api/matches?after=`, `/api/tourneys`

What the website's pages read (`/`, `/player?id=`, `/match?id=`, `/tourneys`, `/tourney?id=`). Public: no token, `GET` only, and a browser may cache an answer for `publicCacheSeconds` (60 s). Code: `src/site/`. Only `accepted` and `void` matches are public; any other match is a `404 not_found`, like an unknown player or match.

The leaderboard, a player's rating and matches, and the Tourneys page are one region's: `?region=eu` ([Regions](#regions)), the first of `regions` without it, `400 bad_request` for one that isn't a region. Their answers say which (`region`). A match and a tourney have their own `region`.

Ratings are the display ratings ([rating.md](rating.md)). `tier` is `{ label, color, threshold }` (RGB 0–255; `threshold` the display rating the tier starts at) or `null`: a player needs `minRankedRounds` (3) rated rounds for a tier. `inactiveSince` is when they last played, once that's over `inactiveAfterDays` (30) ago, else `null`; inactive players stay on the leaderboard.

| Route | Answers |
|---|---|
| `GET /api/leaderboard?region=eu&page=1` | `{ region, page, pageSize, hasMore, players }`. Players with at least `minRankedRounds` rated rounds, best first, `leaderboardPageSize` (50) a page. Each: `rank, id, name, rating, rounds, wins, lastPlayedAt, tier, inactiveSince` |
| `GET /api/players/:id?region=eu` | `{ region, player, matches }`. `player`: `id, name, aliases` (newest first), `regions` (the regions they have a rating in, for a link to their other one) and `rating` in this region (as on the leaderboard, `rank` `null` below `minRankedRounds`, plus `nextTier`: the next tier up from their rating, like `tier`, `null` at the top; `null` with no rated round). `matches`: their newest `playerRecentMatches` (20) in this region, newest uploaded first: `id, playedAt, map, legacy, void, tournament, tourney, ratingBefore, ratingAfter` (`null` when the match didn't rate them; `ratingBefore` `null` for their first) |
| `GET /api/players?search=Kenzo&region=eu` | `{ region, players }`: players whose name or an old name (alias) contains the text, ignoring case, at most `playerSearchLimit` (25, what Discord's autocomplete shows). Exact names first, then names starting with the text, then the rest, each best rating first (unrated last). A player is listed once, by their best-matching name. Each: `id, name, rating, tier` (`rating` and `tier` in the region, as on its leaderboard; `null` with no rated round there) and `matchedAlias`: the old name that matched, or `null` when the current name did. `400 bad_request` when `search` has fewer than `playerSearchMinLength` (2) characters, spaces around it ignored. With `?region=` sent, only players with a rating in that region are listed. Each search reads every alias once: autocomplete should wait for a pause in typing ([database.md](database.md), "Free tier") |
| `GET /api/matches/:id` | `{ match }`: `id, region, playedAt, map, preset, gameVersion, legacy, void, complete, tournament, tourney` (`{ id, name, lobby }` of the tourney lobby it was played in, or `null`), `players` (`id, name, rounds, wins` in the match's rated rounds, `ratingBefore, ratingAfter`) and `rounds` (`number, result, rated, broken, winner`, and `placements`: `playerId, name, position, left`, in finishing order, leavers last) |
| `GET /api/matches?after=<cursor>&limit=20&region=eu` | The match feed, for posting results (the Discord bot, any community tool): `{ cursor, hasMore, matches }`. Public matches (of the region, with `?region=`; every region without it) that changed after `cursor`, oldest change first, at most `limit` (1 to `matchFeedLimit`, 20; 20 when left out). Send the answer's `cursor` as `after` next time; with `hasMore`, ask again straight away. `after=0` starts from the first match, `after=latest` gives no matches and the current cursor, to start from now. A match is listed again when it changes in a way a post shows: accepted from review, a longer copy, voided or unvoided, rated (an incomplete match is rated after `ratingIncompleteGraceHours`), linked to a tourney. A later recompute that moves its ratings doesn't list it again. Each match: `id, removed` (`false`), `region, playedAt, map, legacy, void, complete, tournament, tourney` (as in `/api/matches/:id`), `rounds, ratedRounds` (counts) and `players`: `id, name, rounds, wins` (in rated rounds), `ratingBefore, ratingAfter` (`null` while the match isn't rated for them), most wins first. A match that stopped being public (unvoided back to rejected) is listed once as `{ id, removed: true }`: take its post down. `400 bad_request` for a missing or malformed `after` or `limit` |
| `GET /api/tourneys?region=eu&page=1` | `{ region, page, pageSize, hasMore, upcoming, past }`: the region's tourneys. `upcoming`: every `scheduled` or `live` tourney, soonest first (page 1 only). `past`: `done` and `cancelled` ones, newest first, `tourneysPageSize` (10) a page. Each tourney: `id, name, region, startsAt, status, notes, lobbies`. Each lobby: `id, label, matchId` (`null` until its match is linked and public), `void, screenshot` (its URL or `null`), `screenshotExpired` (deleted to stay inside the storage caps), `verified`, and `standings`: `place, id, name, wins, kills, ratingBefore, ratingAfter`, most rounds won first, ties broken by kills, the same wins and kills sharing a place. Wins count every `WIN` round, rated or not; kills every `KILL` that isn't a player killing themselves |
| `GET /api/tourneys/:id` | `{ tourney }`, as in the list |
| `GET /api/screenshots/:key` | A verify screenshot currently belonging to a lobby (the `screenshot` URL), cached for `screenshotCacheSeconds` (1 h): a key is never reused. Removed or expired keys return `404`, including while their R2 deletion is being retried; an already cached copy can remain until its cache lifetime ends |

## Rank tags: `GET /api/rank-tags?region=eu`

What the host tool builds the game's `RANKS - generated` rule from (GenjiBall-CE [`docs/rank-tags.md`](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/rank-tags.md)), from the ratings of the region the host hosts in (`?region=`, the first of `regions` without it; the answer's `region` says which). Public, cached for `rankTagsCacheSeconds` (1 h). Code: `src/site/rankTags.ts`.

```json
{
  "region": "eu",
  "header": "Ranks updated 2026-10-03",
  "updatedAt": "2026-10-03T12:00:00Z",
  "tiers": [
    { "label": "Apprentice", "color": [205, 127, 50, 255], "guide": "Apprentice - 1300", "names": ["Kenzo"] },
    { "label": "Master", "color": [255, 215, 0, 255], "guide": "Master - 1600", "names": [] }
  ]
}
```

- `header` is the line under the guide's header (`rankTags[0]`); then one entry per tier, **lowest first**, every tier even with no names. `color` is RGBA, 0–255.
- A player is listed in their tier when they have `minRankedRounds` rated rounds and aren't inactive (the same rules as the site). At most `rankTagsMaxNames` (500) names, the best ratings first.
- `names` are display names as the log has them, which is how the Workshop writes them. Names with `{` or `}`, and names over 128 characters, are left out. The rest are raw: **the host tool escapes `"` and `\`** when it writes the `Custom String`s.
