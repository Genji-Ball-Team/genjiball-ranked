# API

What the server offers the host tool ([genjiball-host-tool](https://github.com/Genji-Ball-Team/genjiball-host-tool)), admins and other clients. All responses are JSON. An error is `{ "error": "<code>", "message": "<for people>" }` with a 4xx status.

## Regions

EU and NA play apart (#47). Every match belongs to the region it was hosted in, and each region has its own ratings, leaderboard, rank tags and tourneys; a player who plays in both has a rating in each. Players and their names are shared. The regions are `regions` in `src/config.ts`: `eu` (Europe) and `na` (North America). `GET /api/server` lists them (`{ testServer, regions: [{ id, label }] }`).

- **Uploads** and **live lobby heartbeats** say their region with `X-Region`, or get the host's home region, which an admin sets. Neither: `422 no_region`. The Workshop can't read the server region, so the log doesn't say it.
- **Reads** of regional data take `?region=` and answer for the first region without it. Except a host's assigned tourney lobbies (`GET /api/host/tourneys`): every region's without it, each lobby saying its region.
- **Tourney lobbies** are their tourney's region; an assigned host from anywhere hosts them there.
- Matches stored before regions were all put in `eu` (`migrations/0011_regions.sql`).

## Upload a log: `POST /api/upload`

The host tool sends a Workshop log file (`Documents/Overwatch/Workshop/Log-*.txt`) as it is. Code: `src/upload/`.

| Part | |
|---|---|
| Body | The file's text, unchanged (UTF-8). At most `maxUploadBytes` (512 KB) |
| `Authorization` | `Bearer <host token>`. Admins hand out tokens ([Admin](#admin-apiadmin)); the server stores only their SHA-256 |
| `X-Log-File` | Optional. The file name |
| `X-Log-Started-At` | Optional. When the file was started, ISO 8601 with a time zone (`2026-10-03T20:15:33+02:00`). The file name has no time zone, so send this: it orders the matches for the rating. Without it, or if it's in the future, the upload time is used |
| `X-Region` | The region the matches were hosted in: an id from `regions` (`eu`, `na`; [Regions](#regions)). Optional for a host with a home region (set by an admin), which is used without it. Send it whenever the host picked a region, so a night hosted in the other region isn't stored in the home one |
| `X-Host-Afk` | Optional. The rounds the host was AFK in ([Host AFK](#host-afk-x-host-afk)): `<matchKey>:<round>,<round>,...`, matches separated by `;` (`482913507226:3,4,5;482913507231:1`) |

Upload every file, whenever it changes or stops growing: the server sorts out the copies (see "One match in several files" in GenjiBall-CE [`docs/ranked-log.md`](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md)). Sending the same file again is cheap and changes nothing, unless it brings new host AFK rounds.

### Host AFK: `X-Host-Afk`

The host tool's AFK button. Every round that **starts** while it's on, the host is dropped from that round's rating exactly like a player who left it: no rating change for them, the others rated on their order without them ([rating.md](rating.md)). Stats (kills, deflects, round wins) don't change. A round left with fewer than 2 players isn't rated, and a match left with fewer than `minMatchPlayers` players in rated rounds is rejected (`too_few_players`), as usual. The match page shows the host as `AFK` in those rounds (`afk` on the placement in `/api/matches/:id`).

- **Format.** `<matchKey>:<rounds>`, several matches separated by `;`. `rounds`: the log's `ROUND_START` round numbers (whole numbers from 1), comma-separated, in any order; empty is allowed (`482913507226:`). Spaces around keys and numbers are ignored; a key listed twice gets both lists. At most `hostMatchKeysMax` (50) matches and `hostAfkMaxRounds` (1000) rounds a match. Anything else is a `400 bad_request` whose message says what's wrong, and nothing is stored.
- **The host** is the player whose `JOIN` has `host` `1` (all of their ids, if they left and came back). A log without the field (older games) has no host: the rounds are stored but drop no one.
- **Send the whole set** for the match with every upload of it. The server keeps, per host and `matchKey`, the **union** of every upload's rounds (`matches.host_afk`, at most `hostAfkMaxRounds`, the lowest kept), so a later upload never takes rounds away and the AFK button can't be undone for a round once sent. A key in the header that isn't in the file is ignored.
- **A copy that isn't longer** (`skip`, `repoint`) or **the same file again** (`duplicate`) with rounds that drop the host from a round of the stored copy: the stored match is rated again with them (`action: "refresh"`). Its rows are rewritten from its own copy (this file when it's as long, else its stored log) and it stays in its upload; this file isn't stored for it. Its status is judged again as for a longer copy (an admin's rejection or void stays). A tourney lobby's verification stays: the standings don't change. Rounds that drop no one from the stored copy (a round it doesn't have yet) aren't written on their own: send them again with the longer copy, as the host tool does anyway.

The rounds aren't in the log, so they're stored with the match, and a longer copy, a re-parse or a recompute applies them again.

### Tourney matches

A match with a `TOURNEY` line (log format 2, GenjiBall-CE `docs/ranked-log.md`, "Tourney matches") was played in a tourney lobby: its `lobbyKey` is the lobby's, from the host tool's tourney code ([Assigned tourneys](#assigned-tourneys-get-apihosttourneys)). The upload links it to that lobby, as an admin's link does (`POST /api/admin/lobbies/:id` with `matchId`): the match becomes a tournament ([rating.md](rating.md)), is rated and listed in the match feed as one, and shows in the lobby's standings. Code: `tourneyCheck` in `src/upload/plan.ts`.

It's linked only when all of these hold. Otherwise it waits in the review queue with a `tourney_*` reason for each that fails, and is never on the boards as a tourney match on its own:

| Check | Review reason when it fails |
|---|---|
| A lobby has the `lobbyKey` | `tourney_unknown_lobby` (the only reason then) |
| The tourney isn't `cancelled` | `tourney_cancelled` |
| The uploading host is the lobby's assigned host | `tourney_wrong_host` |
| The match's region (`X-Region`, else the host's home region) is the tourney's | `tourney_wrong_region` |
| The lobby has no match yet | `tourney_lobby_taken`; also for a second match of the same file for the lobby |
| The logged `roundLimit` is the one the lobby plays (its own, else `tourneyRoundLimit`) | `tourney_round_limit`: the host's code wasn't the lobby's (an admin changed the limit after it was copied, or it was edited), so its standings may not be the ones the tourney meant |

A match that doesn't count anyway (`rejected`: `UNRANKED`, too few players) isn't linked and gets no `tourney_*` reason. The checks are made again in the upload's transaction: a lobby linked to another match, reassigned, given another round limit or cancelled meanwhile sends the match to review (`tourney_lobby_taken`) instead.

- **Copies of the match.** `TOURNEY` is in every copy. A longer copy of a linked match keeps the link (and its lobby's verification is cleared, as for any longer copy). A longer copy of a match that wasn't linked is checked again, so a first copy rejected for having no rated round yet is linked by the full one. A copy of a match an admin accepted or voided without a lobby, or unlinked, stays as the admin left it.
- **In review.** An admin reads the reason, then links the match to its lobby (`POST /api/admin/lobbies/:id` with `matchId`) and accepts it, accepts it as a ranked match, or rejects it.
- A match without `TOURNEY` (format 1, or a ranked format 2 match) is a ranked match, as before.

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
      "reviewReasons": ["duplicate_name"],
      "hostAfk": [3, 4, 5]
    }
  ]
}
```

`result`:

| Value | Meaning |
|---|---|
| `stored` | The file was stored: at least one match in it was new or longer than the stored copy |
| `unchanged` | Every match was already stored, as long or longer. The file isn't stored; `uploadId` is `null`. Nothing was written, unless a match is a `refresh` (new host AFK rounds) |
| `duplicate` | This exact file was uploaded before; `uploadId` is that upload. `matches` is empty, unless the upload brought new host AFK rounds: then it lists the file's matches, the `refresh`ed ones included |

`region` is where the file's new matches are stored. Each match's `region` is the upload's for a new match, and the stored match's for another copy of it: a match stays in the region it was first stored in, whatever a later copy says.

Per match, `action`:

| Value | Meaning |
|---|---|
| `insert` | A new match |
| `replace` | A longer copy of a stored match: it replaces the stored one |
| `repoint` | The same as the stored copy. The stored match now points at this file (the older file is deleted when nothing points at it any more) |
| `skip` | The stored copy is longer, or the match has no `matchKey`. Nothing changed |
| `refresh` | Not longer than the stored copy, but with new host AFK rounds: the stored match is rated again with them, and stays in its file ([Host AFK](#host-afk-x-host-afk)) |

`hostAfk`: the match's host AFK rounds as stored now (`[]`: none).

and `status`, the match's status after the upload:

| Value | Meaning |
|---|---|
| `accepted` | Counts for the ratings. A complete match is rated straight away (by the next cron run when the upload took too many of D1's queries per request to rate it too); one with no `MATCH_END` after `ratingIncompleteGraceHours` (6 h), by the cron (every 10 minutes) ([rating.md](rating.md)) |
| `review` | Waits for an admin. `reviewReasons`: `duplicate_name` (two players with the same name at once), `merged_names` (different aliases resolve to one player in the same round), `untrusted_host`, and for a tourney match not linked to its lobby `tourney_unknown_lobby`, `tourney_cancelled`, `tourney_wrong_host`, `tourney_wrong_region`, `tourney_lobby_taken`, `tourney_round_limit` ([Tourney matches](#tourney-matches)) |
| `rejected` | Never counts. `rejection.code`: `unranked` (an `UNRANKED` line), `unknown_format` (kept to re-parse when the server learns the format), `too_few_players` (fewer than `minMatchPlayers`, 2, in rated rounds. A 1v1 with a rated round counts; a match with no rated round is rejected), `untrusted_host` (when `untrustedHostUploads` is `reject`), `no_match_key`, `admin` (an admin rejected it from the review queue; a longer copy doesn't change that) |
| `void` | An admin voided it. A longer copy doesn't change that |

### Errors

| Status | `error` | When |
|---|---|---|
| 400 | `empty` | No body |
| 400 | `bad_request` | `X-Region` isn't one of `regions`, or `X-Host-Afk` is malformed or over its limits |
| 401 | `unauthorized` | No token, or an unknown one |
| 403 | `revoked` | The token was revoked. Stop uploading with it |
| 405 | `method_not_allowed` | Not a `POST` |
| 409 | `conflict` | Another upload of the same match was being stored at that moment. Try again |
| 413 | `too_large` | Over `maxUploadBytes`, or so many rows that one upload can't write them within D1's queries per request ([database.md](database.md), "Rules for code that writes"). Nothing was stored |
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

## Live lobby: `PUT /api/host/lobby`, `DELETE /api/host/lobby`

The host tool says a ranked lobby is open, so the site can list it (#11, Genji-Ball-Team/genjiball-host-tool#6). `Authorization: Bearer <host token>`, as for an upload. One lobby per host. Code: `src/lobby/`.

**Heartbeat: `PUT`**, every `lobbyHeartbeatSeconds` (60) while a ranked match log is active. Body `{ "players": 6, "name": "Kenzo's ranked" }`: `players` 0 to `lobbyPlayersMax` (12), `name` optional (spaces around it dropped, at most `lobbyNameMaxLength`, 64, characters; left out or empty: `null`). `players` is required. Each heartbeat sends the name again: left out, it's cleared. The region is an upload's: `X-Region`, else the host's home region, else `422 no_region` ([Regions](#regions)).

`200 { "lobby": { "region": "eu", "name": "Kenzo's ranked", "players": 6, "openedAt": "2026-10-05T20:00:00Z", "seenAt": "2026-10-05T20:14:00Z" }, "heartbeatSeconds": 60, "ttlSeconds": 180 }`. Send the next heartbeat after `heartbeatSeconds`. A lobby with no heartbeat for `lobbyTtlSeconds` (180) is gone; the next heartbeat opens a new one (`openedAt` starts again), as does a heartbeat in another region or after a close.

**Close: `DELETE`**, when the match ends, the game closes or the host switches it off. `200 { "closed": true }`, `false` when no lobby was open. The lobby leaves the list at once, but the next heartbeat still waits `lobbyHeartbeatMinSeconds` from the close.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | The body isn't a JSON object, `players` or `name` is wrong, the body is over `lobbyBodyMaxBytes` (1 KB), or `X-Region` isn't one of `regions` |
| 401 | `unauthorized` | No token, or an unknown one |
| 403 | `revoked` | The token was revoked. Its lobby isn't listed any more |
| 405 | `method_not_allowed` | Not a `PUT` or `DELETE` |
| 422 | `no_region` | No `X-Region`, and the host has no home region. Nothing was stored |
| 429 | `rate_limited` | A heartbeat less than `lobbyHeartbeatMinSeconds` (30) after the last heartbeat or close. Nothing was written; a change waits for the next heartbeat |

Tourney lobbies (#25) will add an optional `tourneyLobbyId` to the heartbeat; until then the list's `tourney` is always `null`.

## Assigned tourneys: `GET /api/host/tourneys`

The host tool's "Scheduled" list and its "Copy tourney code" (host-tool #8, #9) read this: the tourney lobbies an admin assigned to the token's host, in tourneys that are `scheduled` or `live`, and in `done` ones until their screenshot is verified (the host still has to upload it; `code` is `null`), soonest start first. `Authorization: Bearer <host token>`, as for an upload. Code: `src/tourney/host.ts`.

`?region=eu` (or `X-Region: eu`; the query wins) lists only that region's lobbies; without either, every region's, since an admin may assign a host a lobby outside their home region. Each lobby says its region, which is its tourney's.

```json
{
  "region": null,
  "codeLeadMinutes": 60,
  "lobbies": [
    {
      "id": 7,
      "label": "Lobby 1/2",
      "region": "eu",
      "roundLimit": 30,
      "tourney": { "id": 3, "name": "October Cup", "region": "eu", "startsAt": "2026-10-10T17:00:00Z", "status": "scheduled" },
      "matchId": null,
      "screenshot": null,
      "screenshotExpired": false,
      "verified": false,
      "codeFrom": "2026-10-10T16:00:00Z",
      "code": { "lobbyKey": "482913507226", "roundLimit": 30, "name": "October Cup", "label": "Lobby 1/2" }
    }
  ]
}
```

- `region`: the region asked for, `null` for every region.
- `roundLimit`: the lobby's own (an admin sets it) or `tourneyRoundLimit` (30).
- `code`: the values for the game's `TOURNEY - generated` rule (GenjiBall-CE#143), from `codeFrom` (`tourneyCodeLeadMinutes`, 60, before the start) until the lobby is done: its match is linked, or the tourney is `done` or `cancelled`. `null` outside that window. `lobbyKey` is the server's id for the lobby (random digits, text); the game logs it so the server can tell which lobby a match was (GenjiBall-CE#142). `name` and `label` are for the game's display label.
- `matchId`, `screenshot`, `screenshotExpired`, `verified`: as on the [Tourneys page](#site-apileaderboard-apiplayersid-apiplayersidhistory-apiplayersidstats-apiplayerssearch-apimatchesid-apimatchesafter-apihead-to-head-apirecords-apitourneys-apilobbies), but `matchId` whatever the match's status.

No assigned lobby: `lobbies` is empty. The errors are an upload's (`401`, `403 revoked`, `405`), and `400 bad_request` for a region that isn't one.

## Verify screenshot: `PUT`/`DELETE /api/host/lobbies/:id/screenshot`

The lobby's assigned host uploads the screenshot of the final standings (host-tool #10), or deletes or replaces it, until an admin has verified it. `Authorization: Bearer <host token>`. The same limits and storage as the admin's upload ([Admin](#admin-apiadmin)): PNG, JPEG or WebP whatever made it, at most `screenshotMaxBytes` (8 MB), stored in R2, the old one deleted, the oldest expired past the caps. Each change is logged in `host_actions`. Code: `src/tourney/host.ts`, `src/tourney/upload.ts`.

`200 { lobby }`, the lobby as in `GET /api/host/tourneys`, or `{ "lobby": null }` if it stopped being this host's right after the change. `X-Region` (or `?region=`) is optional; sent, it must be the lobby's region. The checks are made again in the write's transaction: if the host's token is revoked, the lobby reassigned or verified, or its tourney cancelled or moved to another region while the image uploads, it's a `409` and the image is deleted.

| Status | `error` | When |
|---|---|---|
| 400 | `empty` | `PUT` with no body |
| 400 | `bad_request` | The region isn't one of `regions` |
| 401, 403 | `unauthorized`, `revoked` | As for an upload |
| 403 | `not_assigned` | The lobby isn't assigned to this host (any more) |
| 404 | `not_found` | No such lobby |
| 405 | `method_not_allowed` | Not `PUT` or `DELETE` |
| 409 | `verified` | An admin verified the screenshot: only an admin can change it now (or un-verify it) |
| 409 | `wrong_region` | The region sent isn't the lobby's |
| 409 | `conflict` | The tourney was cancelled, `DELETE` with no screenshot, storage full while cleanup is pending, or something changed meanwhile (token revoked, lobby reassigned, verified or replaced, tourney cancelled or moved). Reload and try again |
| 413 | `too_large` | Over `screenshotMaxBytes` |
| 415 | `unsupported_type` | Not a PNG, JPEG or WebP |

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
| `POST /api/admin/matches/:id/region` | Body `{ "region": "na" }`: moves a match hosted in another region than it was stored in (a host uploaded under the wrong one). Its ratings leave the old region's leaderboard (stale from it, recomputed) and it's rated in the new one like a late upload. `409` for its own region, or while a tourney lobby links it (unlink it first). `{ match, ratingsStale }` |
| `GET /api/admin/actions` | `{ actions }`: the action log, newest first, at most `adminListLimit` |
| `GET /api/admin/players?search=Ken` | `{ players }`: the site's name search (`/api/players?search=`) over every region, at most `adminListLimit`, merged players left out. Each: `id, name, matchedAlias, aliases` (every name, newest seen first). `400` under `playerSearchMinLength` characters |
| `GET /api/admin/players/:id` | `{ player, merges }`. `player`: `id, name, nameFixed` (an admin set the name), `mergedInto` (`null`, or the player it was merged into), `createdAt`, `aliases` (`id, name, firstSeenAt, lastSeenAt`, newest seen first; empty times for a name an admin gave that no log has shown yet), `ratings` (`region, rating, rounds, wins, lastPlayedAt` per region) and `matches` (how many). `merges`: the merges it was in, as below |
| `POST /api/admin/players/:id/merge` | Body `{ "into": 12 }`: [merges](#merging-players) the player into player 12, who keeps their id. `{ merge, ratingsStale }`. `400` for no `into` or the player itself, `404` for an unknown player, `409` if either was merged already (use the one it went into) or both played in the same round, `409 too_large` when it would rewrite more than `playerMergeMaxPairRows` (5,000) head-to-head rows (an undo too), with nothing written |
| `GET /api/admin/merges` | `{ merges }`: newest first, at most `adminListLimit`. Each: `id, from` and `into` (`{ id, name }`), `aliases` (the names it moved), `mergedBy, mergedAt, undoneBy, undoneAt` |
| `POST /api/admin/merges/:id/undo` | Undoes a merge. `{ merge, ratingsStale }`. `409` if it's undone already, or the player it went into was merged on since (undo that merge first) |
| `POST /api/admin/players/:id/name` | Body `{ "name": "Kenzo" }`: the display name, which uploads then don't change. `{ "name": null }`: the display name follows the logs again. `{ player }`, as above. `409` for a merged player, or a name that's another player's (merge them instead) |
| `POST /api/admin/matches/:id/tournament` | Body: `{"tournament": true}` or `false`. Marks the match as a tournament: it counts `tournamentWeight` times as much and nobody gains or loses more than `tournamentMaxChange` display points in it. A rated match makes the ratings stale from it. `409` if it already is that way or clearing the flag while a tourney lobby still links the match; unlink it first |
| `GET /api/admin/tourneys` | `{ tourneys }`: latest start first, at most `adminListLimit`, each with `capacity` and `signups` (as on the [Tourneys page](#sign-up-for-a-tourney-post-apitourneysidsignups)) and `lobbies` (`id, version, label, hostId, hostName, roundLimit, roundLimitDefault, capacity, capacityDefault, lobbyKey, matchId, screenshotKey, screenshotAt, verifiedAt, verifiedBy`; `roundLimitDefault`: `roundLimit` is `tourneyRoundLimit`; `capacityDefault`: `capacity` is `tourneyLobbyCapacity`). The admin page says when the sign-ups pass the capacity: add a lobby, or another tourney |
| `GET /api/admin/tourneys/:id/signups` | `{ signups }`: every sign-up of the tourney, removed ones too, first come first. Each: `id, tourneyId, name, signedUpAt, removedAt, removedBy` (the admin's name; both `null` unless removed). Never the IP hash |
| `POST /api/admin/signups/:id` | Body `{ "removed": true }`: removes a sign-up (a joke name, a double). The row stays, marked removed by the admin: it no longer counts or shows, and the name can't sign up for that tourney again. `{ "removed": false }` restores it. `{ signup }`, as above. `409` if it already is that way |
| `POST /api/admin/tourneys` | Body `{ "name", "region", "startsAt", "notes"?, "status"? }`. `region`: where it's played; its lobbies' matches must be from there. `startsAt` is ISO 8601 with a time zone. `status`: `scheduled` (default), `live`, `done`, `cancelled`. `201 { tourney }` |
| `POST /api/admin/tourneys/:id` | Same fields, all optional: changes the ones sent. `409` for a new `region` while a lobby has a match |
| `POST /api/admin/tourneys/:id/lobbies` | Body `{ "label": "Lobby 1/2", "hostId"?, "roundLimit"?, "capacity"? }` (as below). The lobby gets a random `lobbyKey`. `201 { lobby }` |
| `POST /api/admin/lobbies/:id` | Body `{ "label"?, "hostId"?, "roundLimit"?, "capacity"?, "matchId"? }`. `hostId` assigns the lobby's host (`null`: none), who gets its code values and uploads its screenshot ([Assigned tourneys](#assigned-tourneys-get-apihosttourneys)): any host, whatever its home region, as the lobby is played in the tourney's; `404` for an unknown host, `409` for a revoked one. `roundLimit`: 1 to `tourneyRoundLimitMax` (50), `null` for `tourneyRoundLimit` (30). `capacity`: the players the lobby holds, 1 to `tourneyLobbyCapacityMax` (12), `null` for `tourneyLobbyCapacity` (10); the tourney's capacity is the sum of its lobbies'. `matchId` links the lobby's match: the match becomes a tournament ([rating.md](rating.md)), and a new match clears the verification. `null` unlinks it, which **moves the match back to ranked**: it's no longer a tournament and is rated as a normal ranked match (the ratings go stale from it, like a void), and the log row's `match_id` is the match that left (`fromMatchId` in `detail`). The admin page's "Move match to ranked" button does this; a longer copy of the match then stays unlinked ([Tourney matches](#tourney-matches)). To drop the match instead, void it. The upload of a tourney match links it on its own when it passes the checks; this is for the others, and for fixing a link. `409` if the match is another lobby's or from another region than the tourney. `{ lobby, ratingsStale }` |
| `DELETE /api/admin/lobbies/:id` | Deletes the lobby and its screenshot; its match is no longer a tournament. `{ ratingsStale }` |
| `PUT /api/admin/lobbies/:id/screenshot` | Body: the image, PNG, JPEG or WebP (told apart by its first bytes, so any tool's image works), at most `screenshotMaxBytes` (8 MB). Replaces the old one, which needs verifying again, then expires the oldest screenshots past the storage caps ([database.md](database.md), "Screenshots in R2"). `{ lobby, expired }`, `expired` how many were detached and queued for R2 cleanup. `409` for a concurrent lobby change or storage full while cleanup is pending; `413 too_large`, `415 unsupported_type` |
| `DELETE /api/admin/lobbies/:id/screenshot` | Deletes the screenshot |
| `POST /api/admin/lobbies/:id/verify` | Body `{ "verified": true, "version": 3 }`: an admin checked the displayed screenshot against the standings; use the lobby's displayed `version`. Needs a match, screenshot and current version (`409` otherwise). `{ "verified": false }` clears verification; version is optional when clearing |
| `POST /api/admin/legacy-import?host=<id>&region=<region>` | Body: an old v1.3.2 log file, as with an upload. Stored as the host's legacy match ([legacy.md](legacy.md)), as from a trusted host and with no rate limit, in `region` or else the host's home region (`400` with neither). Answers like `POST /api/upload`; `422 not_legacy` for a file without `KILL` lines or with a `GBR` line. `npm run import:legacy` sends a folder of them |

| `POST /api/admin/parse?host=<id>&region=<region>&legacy=1` | Dry-run parse: body a log file, as with an upload. What an upload would answer and what the parser read, **writing nothing** ([Debug tools](#debug-tools)) |
| `POST /api/admin/ratings/recompute?region=<region>` | Marks the region's ratings stale from the start: the cron recomputes them. `region` is required. The dry run is `npm run ratings:dry-run` ([Debug tools](#debug-tools)) |

A match action answers `{ match, ratingsStale }`. Accepting, voiding or un-voiding brings the ratings up to date as far as one cron run would ([rating.md](rating.md)): a match that now counts is rated straight away if it's the newest, and a short stale tail is recomputed. `ratingsStale: true` means the cron finishes the recompute (every 10 minutes).

### Merging players

A player who changes their name shows up as a new player: names are all the server knows of them (`players`, `aliases`). An admin who knows two names are one player merges them. Merges fix name changes. They don't detect smurfs or tell who is behind an account, and the site (and anything built on this API) must never say they do: a merge only joins names an admin knows are one player.

- **Merge** (`POST /api/admin/players/:id/merge`): the player's names, and every match row played under them, become `into`'s. `into` keeps their id; the merged player's page (`/api/players/:id`) answers as `into`, and they drop out of searches and leaderboards. Later uploads of any of the names count for `into`. Two names that played the same round at once are two players: refused.
- **Ratings.** Each region's ratings are rebuilt from the first rated match the merged player played there, so a player who played EU as one name and NA as the other has both regions recomputed. Merge and undo mark the affected regions stale in their transaction and answer `ratingsStale: true`; the cron does all recomputation (every 10 minutes).
- **Head-to-head.** The pairs of the merged player's matches are counted again as one player's, at once, in the same transaction ([database.md](database.md), "Merging players"); an undo does the same for the matches that go back.
- **Display name.** The name seen most recently, of either player, unless an admin set one (`POST /api/admin/players/:id/name`). Old names stay aliases: the player is still found by them. A name an admin sets that the player didn't have becomes one of their names, so a log with it counts for them. The rank tags keep using the name the player was last seen with in a log, which is what the game shows.
- **Undo** (`POST /api/admin/merges/:id/undo`): the merged player gets their id, names and match rows back, including matches uploaded under those names since the merge, and the ratings are rebuilt in the same way. Ratings come from the matches, so after the recompute they're exactly what they were. Merges are undone newest first: if `into` was merged on since, undo that one first.

**Decisions that last.** A longer copy of a match keeps an admin's void or rejection. An accept doesn't: a longer copy is judged again, and goes back to review if it still has a reason to (its new rounds haven't been looked at).

Lobby mutations return `409 conflict` if another edit, replacement, expiry or longer log changed their snapshot before the write. A longer log also clears its lobby's verification. Screenshot removal is immediate at the public API; R2 failures leave durable cleanup records for later uploads or the cron to retry.

`admin_actions.action`: `host_create`, `host_trust`, `host_revoke`, `host_region`, `match_region`, `match_accept`, `match_reject`, `match_void`, `match_unvoid`, `legacy_import`, `match_tournament`, `tourney_create`, `tourney_edit`, `lobby_create`, `lobby_edit`, `lobby_delete`, `lobby_screenshot`, `lobby_screenshot_delete`, `lobby_verify`, `signup_remove`, `signup_restore`, `ratings_recompute`, `player_merge`, `player_unmerge`, `player_name`. `detail` is JSON: the name and trust of a new host, `from` and `to` of a change, the `reason` when one was given, the `file` of an import, the `tourney` and `lobby` ids of a tourney action (with `hostId`, `roundLimit` and `capacity` for a lobby, and `fromMatchId` when its match changed; `host_id` is the lobby's assigned host), the `tourney`, `signup` id and `name` of a sign-up action, the `region` of a recompute, and for a player action the `merge` id, the player ids (`from`, `into`, `player`) and names. A host's own screenshot changes go to `host_actions` instead (`lobby_screenshot`, `lobby_screenshot_delete`).

### Debug tools

For finding out why a log was parsed, judged or rated the way it was (#33). Code: `src/admin/debug.ts`, `src/rating/dryRun.ts`, `scripts/ratings-dry-run.ts`. With `LOG_LEVEL=debug` the server also logs each uploaded match's action, status, rejection, review reasons, host AFK rounds (stored, and those that dropped the host) and skipped lines.

**Dry-run parse: `POST /api/admin/parse`.** The body is a log file, as with an upload, at most `maxUploadBytes` (past it, or empty, `upload` says the upload's `413`/`400` and nothing is parsed). It's parsed and planned exactly as an upload would be, through the same code, and nothing is written. Query, all optional:

| Param | |
|---|---|
| `host` | A host id: answers as that host's upload would: its revocation, home region, rate limit, trust and stored copies (`replace`, `repoint`, `skip`; a stored match keeps its region). Without it the host checks are skipped, and the file is judged as from a trusted host with nothing stored. `404` for an unknown host |
| `region` | Stands for the upload's `X-Region` (the import's `region`): echoed into each new match's `region`. One that isn't a region is the upload's `400`. Without it, the host's home region, or `null` |
| `legacy` | `1`: as `legacy-import` would read the file (the v1.3.2 parser, as from a trusted host, revocation not checked, `host` required) |

`200`, also for a file an upload would refuse:

```json
{
  "dryRun": true,
  "region": "eu",
  "host": { "id": 3, "name": "Kenzo", "trust": "trusted", "region": "eu" },
  "legacy": false,
  "bytes": 2048,
  "duplicateOf": null,
  "upload": {
    "status": 200, "result": "stored", "uploadId": null, "region": "eu",
    "matches": [{ "matchKey": "482913507226", "lineCount": 57, "region": "eu", "action": "insert", "status": "review", "rejection": null, "reviewReasons": ["duplicate_name"] }]
  },
  "parser": {
    "error": null,
    "matches": [
      {
        "matchKey": "482913507226", "lineCount": 57, "region": "eu", "action": "insert", "status": "review",
        "rejection": null, "reviewReasons": ["duplicate_name"], "storedMatchId": null,
        "format": 1, "gameVersion": "1.3.3R", "startLine": 2, "unranked": [],
        "settings": { "map": "workshop-island-night", "preset": "Default", "feel": false, "addOns": [] },
        "complete": true, "startTime": 2.38, "endTime": 114, "endResult": "TIME",
        "players": [{ "id": 1, "name": "Sparrow", "joinTime": 2.38, "leaveTime": null }],
        "ratedRounds": 3,
        "rounds": [
          { "number": 1, "result": "WIN", "rated": true, "startTime": 21.02, "endTime": 43.3, "players": [1, 2, 3, 4, 5],
            "winnerId": 1, "left": [2], "broken": [], "placements": [{ "position": 1, "id": 1, "name": "Sparrow" }] }
        ],
        "kills": 11, "deflects": 18,
        "problems": []
      }
    ],
    "warnings": []
  }
}
```

- **`upload`** is what `POST /api/upload` (or `legacy-import`) would answer: its status and body, with `uploadId: null` for a file it would store. It checks in the real order: the host, region and rate limit before the body. An upload: `403 revoked`, then `400` for a `region` that isn't one, `422 no_region`, `429 rate_limited`, then the body (`413 too_large`, `400 empty`), `duplicate` (this exact file is stored: `duplicateOf`), the parser's `422` (`not_ranked`, `legacy_log`), and `stored` or `unchanged`. An import: `400` without `host`, for a bad `region` or with no region, then the body, `duplicate`, `422 not_legacy`, and the result. The dry run itself only refuses its own parameters: `400` for a malformed `host` or `legacy`, `404` for an unknown host.
- **`parser`** is what the parser read, even when the upload would stop before parsing (a stored file, a revoked host). `error` is the parse's own refusal (`{ status, error, message }`) or `null`. Each match has its plan (`action, status, rejection, reviewReasons`, `region`, `storedMatchId` with `host`, `lobbyId`: the tourney lobby the upload would link it to) and what was read (`tourney`: `{ lobbyKey, roundLimit }` from `TOURNEY`, or `null`; the tourney checks are made as `host` in `region`, each skipped without it): player and round ids are the log's, `placements` the rated finishing order (winner first, leavers left out; empty for a round that isn't rated), `problems` the lines skipped and why. `warnings`: copies of one match in the file (only the longest is used), skipped lines, broken rounds, no `MATCH_END`.

**Recompute: `POST /api/admin/ratings/recompute?region=eu`.** Marks the region's ratings stale from its first match and logs `ratings_recompute`, in one batch; `{ region, ratingsStale: true }`. It rates nothing itself: the cron (every 10 minutes) recomputes `ratingMatchesPerRun` matches a run until it's done ([rating.md](rating.md), "Ratings in the database"), so the request stays inside the free plan's 10 ms of CPU. New matches are still rated meanwhile. `region` is required (`400` without it, or for one that isn't a region); the other region is never touched. `dryRun` gets a `400`: the dry run is a script. Use it after a rating config or engine change, or when the dry run finds drift.

**Dry-run recompute: `npm run ratings:dry-run -- --region eu`.** On your computer, not in the Worker: a whole region from scratch doesn't fit a Worker's CPU time on the free plan. It reads the region's accepted matches, the rated rounds of those that count and the stored ratings with read-only `SELECT`s through `wrangler d1 execute`, rates them from scratch with the engine and the config of the checkout, and prints who would move. Nothing is written. Which matches count (accepted, complete or past `ratingIncompleteGraceHours`), their order (`played_at`, then id) and tournament weighting are the recompute's own: it shares `counts`, the match and round queries' columns and grouping, and the engine with the server (`src/rating/dryRun.ts`).

| Option | |
|---|---|
| `--region <id>` | Required |
| `--local` / `--remote` | The local D1 (`npm run dev`'s, the default) or the deployed one. `--remote` needs `wrangler login` to the Genji Ball account |
| `--env test` | The test server's database |
| `--limit <n>` | Players printed, the biggest moves first (50) |
| `--chunk <n>` | Matches whose rounds one query reads (200) |
| `--json <file>` | Writes the whole report: `{ region, database, env, at, staleFrom, matches: { accepted, counted, unrated }, cost: { queries, rowsRead }, summary, players }` |

Each of `players` changes on the leaderboard: `{ playerId, name, before, after, change, rankChange }`, `before`/`after` `{ display, rounds, wins, rank }` or `null` (gains or loses a rating), `rank` the leaderboard's (display down, from `minRankedRounds` rated rounds; `null` below), `rankChange` places up (negative: down). `summary`: `players, changed, added, removed, up, down, biggestGain, biggestLoss`, and `identical`: every stored rating, mu and sigma included, is exactly what a recompute from scratch gives.

**Cost.** One query for the matches, one for the stored ratings, one per `--chunk` counted matches for the rounds (about 225 rows read a match: its rounds and placed players), one per `--chunk` changed players for their names. With `--remote` these are real D1 reads: the 220 v1.3.2 matches are about 50,000 rows (1% of the free tier's 5 million a day); a year of busy weeks (14,600 matches) about 3.3 million, most of a day's reads. `cost.rowsRead` says what a run read (`null` locally: the local D1 doesn't report it). Run it when needed, not on a schedule.

**Consistent reads.** The reads are separate `wrangler` calls, so a cron run or an admin action could land between them. The script reads the region's `rating_state.version` before and after them: every rating write, recompute mark and tournament change moves it on. If it moved, the script reads everything again once; if it moved again, it stops with "The ratings changed while reading": run it again a minute later. (A change that writes no rating, like accepting a match the cron hasn't rated yet, doesn't move it; the next run shows it.)

### Errors

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | The body isn't a JSON object, a field is missing or wrong, or a name or reason is over `adminTextMaxLength` characters (a player's display name: `playerNameMaxLength`, 64) |
| 401 | `unauthorized` | No admin token, or an unknown or revoked one |
| 404 | `not_found` | No such route, match, host, player or merge |
| 405 | `method_not_allowed` | Wrong method. `Allow` says which |
| 409 | `conflict` | The action doesn't fit the status (voiding a match in review, un-revoking a host), or another admin changed it at the same time |

## Public API: CORS and caching

Everything a community tool can read without a token: the [Site](#site-apileaderboard-apiplayersid-apiplayersidhistory-apiplayersidstats-apiplayerssearch-apimatchesid-apimatchesafter-apihead-to-head-apirecords-apitourneys-apilobbies) routes (the live lobbies included), the [rank tags](#rank-tags-get-apirank-tagsregioneu), `/api/server` and `/api/health`. A page on any website can read them from the browser. Code: `src/public.ts`, applied to every route in `src/index.ts`, so a handler doesn't set any of this itself.

**The rule.** A path is public when its first segment after `/api/` is in `publicReadRoutes` (`src/public.ts`): `health`, `server`, `leaderboard`, `players`, `matches`, `tourneys`, `lobbies`, `head-to-head`, `records`, `rank-tags`, `screenshots`, and everything under them (`/api/players/12/history` is under `players`). **A new public route lists its first segment there**; one under an existing segment gets it already. `admin`, `host` and `upload` (`privateRoutes`) need a token: they never get CORS headers, whatever the list says, and every answer on them is `Cache-Control: no-store`.

On a public path:

| | |
|---|---|
| Methods | `GET` and `HEAD`. Anything else is `405 method_not_allowed`, except the public writes below |
| `Access-Control-Allow-Origin` | `*` on every answer, errors included. No cookies or credentials are used, so there's no `Access-Control-Allow-Credentials` and no `Vary: Origin` (the answer is the same for every origin) |
| `OPTIONS` (preflight) | `204` with `Access-Control-Allow-Methods: GET, HEAD`, `Access-Control-Allow-Headers: *` and `Access-Control-Max-Age: corsMaxAgeSeconds` (2 h). A plain `GET` without custom headers needs no preflight |
| `Access-Control-Expose-Headers` | `ETag`, so a script can read it |
| `Cache-Control` | A route's own when it sets one (rank tags: `rankTagsCacheSeconds`, live lobbies: `lobbiesCacheSeconds`, screenshots: `screenshotCacheSeconds`, `/api/health`: `no-store`); else `public, max-age=publicCacheSeconds` (60 s). An error (4xx, 5xx) is always `no-store`: a match in review is a `404` until an admin accepts it |
| `ETag` | Every JSON `200` gets a weak ETag (`W/"…"`, from a hash of the body); screenshots have R2's. Send it back as `If-None-Match` and an unchanged answer is a `304` with no body. That saves the download, not the server's work: the answer is still computed |

**Public writes.** A `POST` anyone may send without a token: only the [tourney sign-up](#sign-up-for-a-tourney-post-apitourneysidsignups), listed in `publicWrites` (`src/public.ts`). It's for the site's own pages: no CORS headers (the preflight above allows only reads), `403 cross_origin` when the request's `Origin` is another site's, and every answer is `Cache-Control: no-store`.

```js
// From any web page: the EU top 10.
const res = await fetch("https://genjiball.us/api/leaderboard?region=eu");
const { players } = await res.json();
console.log(players.slice(0, 10).map((p) => `${p.rank}. ${p.name} ${Math.round(p.rating)}`));
```

## Site: `/api/leaderboard`, `/api/players/:id`, `/api/players/:id/history`, `/api/players/:id/stats`, `/api/players?search=`, `/api/matches/:id`, `/api/matches?after=`, `/api/head-to-head`, `/api/records`, `/api/tourneys`, `/api/lobbies`

What the website's pages read (`/`, `/player?id=`, `/compare?ids=`, `/match?id=`, `/tourneys`, `/tourney?id=`). The pages show one region too, with the same `?region=` in their URL (#48): without it, the last region the browser viewed, else a guess from its time zone (the Americas: `na`). Public: no token, `GET` only, and a browser may cache an answer for `publicCacheSeconds` (60 s; the live lobbies `lobbiesCacheSeconds`, 15 s); CORS and caching as in [Public API](#public-api-cors-and-caching). Code: `src/site/`. Only `accepted` and `void` matches are public; any other match is a `404 not_found`, like an unknown player or match.

The leaderboard, a player's rating, matches, rivals and rating history, head-to-head records, the records, the Tourneys page and the live lobbies are one region's: `?region=eu` ([Regions](#regions)), the first of `regions` without it, `400 bad_request` for one that isn't a region. Their answers say which (`region`). A match and a tourney have their own `region`.

Ratings are the display ratings ([rating.md](rating.md)). `tier` is `{ label, color, threshold }` (RGB 0–255; `threshold` the display rating the tier starts at) or `null`: a player needs `minRankedRounds` (3) rated rounds for a tier. `inactiveSince` is when they last played, once that's over `inactiveAfterDays` (30) ago, else `null`; inactive players stay on the leaderboard.

| Route | Answers |
|---|---|
| `GET /api/leaderboard?region=eu&page=1` | `{ region, page, pageSize, hasMore, players }`. Players with at least `minRankedRounds` rated rounds, best first, `leaderboardPageSize` (50) a page. Each: `rank, id, name, rating, rounds, wins, lastPlayedAt, tier, inactiveSince` |
| `GET /api/players/:id?region=eu` | `{ region, player, matches }`. A player an admin merged into another answers as that player ([Merging players](#merging-players)). `player`: `id, name, aliases` (newest first), `regions` (the regions they have a rating in, for a link to their other one) and `rating` in this region (as on the leaderboard, `rank` `null` below `minRankedRounds`, plus `nextTier`: the next tier up from their rating, like `tier`, `null` at the top; `null` with no rated round). `matches`: their newest `playerRecentMatches` (20) in this region, newest uploaded first: `id, playedAt, map, legacy, void, tournament, tourney, ratingBefore, ratingAfter` (`null` when the match didn't rate them; `ratingBefore` `null` for their first). `mostEliminated` and `mostEliminatedBy` (#18): the opponents they eliminated most and who eliminated them most in the region's accepted matches, at most `playerRivalsLimit` (5) each, most first: `id, name, kills` (of the one on the other) and `rounds` (rated rounds both finished) |
| `GET /api/players/:id/history?region=eu` | The rating graph (#17): `{ region, player, matches, points, peak, streak, bestStreak, form }`. `player`: `id, name`. `matches`: how many matches rated them in the region. `points`: their display rating after each, `matchId, playedAt, rating`, in play order; a history of more than `ratingHistoryMaxPoints` (200) matches is thinned to that many, evenly, keeping the first, the last and the peak. `peak`: the highest of them (the first time it was reached), like a point, `null` with none. `streak`: rated rounds won in a row up to now, `bestStreak` the longest ever ([rating.md](rating.md)). `form`: their last `recentFormRounds` (20) rated rounds in matches public in the region, `{ rounds, wins, averagePosition, results }`, `results` newest first, each `matchId, round, position` (1 = won) and `players` (in the round's rated order). An unknown player is a `404`; a merged player's id answers as the player they were merged into, like `/api/players/:id`; a player with no rated match in the region gets empty `points` and `form`. Only matches public in the region now are shown: one back in review or rejected, or moved away, is left out at once; a voided one leaves with the recompute. Compare (#16) asks once per player: each answer is cached on its own URL, and two or more players are as many reads |
| `GET /api/players/:id/stats?region=eu` | Round stats for compare (#16): `{ region, player, stats }`. `player`: `id, name`. `stats`: `rounds` (rated rounds they finished in the region's accepted matches; not void ones, like the head-to-head), `kills`, `deflects` and `touches` in those rounds (counted as on the match page, per round), `deflectRounds` (those of the rounds whose log has deflects: a legacy log has none, so divide `deflects` and `touches` by this, not by `rounds`) and `averagePosition` (1 = won; `null` with no round). An unknown player is a `404`; a merged player answers as the player they were merged into. Reads every rated round of the player, so it's not on the player page ([database.md](database.md), "Free tier") |
| `GET /api/players?search=Kenzo&region=eu` | `{ region, players }`: players whose name or an old name (alias) contains the text, ignoring case, at most `playerSearchLimit` (25, what Discord's autocomplete shows). Exact names first, then names starting with the text, then the rest, each best rating first (unrated last). A player is listed once, by their best-matching name. Each: `id, name, rating, tier` (`rating` and `tier` in the region, as on its leaderboard; `null` with no rated round there) and `matchedAlias`: the old name that matched, or `null` when the current name did. `400 bad_request` when `search` has fewer than `playerSearchMinLength` (2) characters, spaces around it ignored. With `?region=` sent, only players with a rating in that region are listed. Each search reads every alias once: autocomplete should wait for a pause in typing ([database.md](database.md), "Free tier") |
| `GET /api/matches/:id` | `{ match }`: `id, region, playedAt, map, preset, gameVersion, legacy, void, complete, tournament, tourney` (`{ id, name, lobby }` of the tourney lobby it was played in, or `null`), `players` (`id, name, rounds, wins` in the match's rated rounds, `ratingBefore, ratingAfter`) and `rounds` (`number, result, rated, broken, winner`, and `placements`: `playerId, name, position, left, afk`, in finishing order, leavers last; `afk`: the host, dropped from the round's rating as AFK, with no `position`). Stats (#15), per round on each placement and for the match on each player: `kills` (`KILL` lines with them as attacker that aren't a self-kill, as the tourney standings count them: per round those in the round, in a new log a `KILL` logged after the `ROUND_END` in the same tick counting in the round of its `ELIM`; for the match every one, between rounds too), `deflects` (`DEFLECT` lines), `touches` (deflects, plus being eliminated by a ball someone sent: a ball that hits before anyone deflected can't be told from a fall, so it isn't counted). For the match only: `roundWins`, every `WIN` round they won, rated or not (`wins` counts only rated ones); `longestStreak`, the most of those in a row (over the `WIN` rounds the player finished; rounds they weren't in or left don't break it); and `place`, the overall place as in the tourney standings: most `roundWins` first, ties broken by kills, the same wins and kills sharing a place. Stats count every round, rated or not. A legacy log has no deflects: `deflects` and `touches` are `null` (unknown, not 0) |
| `GET /api/matches?after=<cursor>&limit=20&region=eu` | The match feed, for posting results (the Discord bot, any community tool): `{ cursor, hasMore, matches }`. Public matches (of the region, with `?region=`; every region without it) that changed after `cursor`, oldest change first, at most `limit` (1 to `matchFeedLimit`, 20; 20 when left out). Send the answer's `cursor` as `after` next time; with `hasMore`, ask again straight away. `after=0` starts from the first match, `after=latest` gives no matches and the current cursor, to start from now. A match is listed again when it changes in a way a post shows: accepted from review, a longer copy, voided or unvoided, rated (an incomplete match is rated after `ratingIncompleteGraceHours`), linked to a tourney. A later recompute that moves its ratings doesn't list it again. Each match: `id, removed` (`false`), `region, playedAt, map, legacy, void, complete, tournament, tourney` (as in `/api/matches/:id`), `rounds, ratedRounds` (counts) and `players`: `id, name, rounds, wins` (in rated rounds), `ratingBefore, ratingAfter` (`null` while the match isn't rated for them), most wins first. A match that stopped being public (unvoided back to rejected) is listed once as `{ id, removed: true }`: take its post down. So is a match an admin moved to another region, in the feed of the region it left (`?region=`); the new region's feed and the all-regions one list it with its new `region`. `400 bad_request` for a missing or malformed `after` or `limit` |
| `GET /api/records?region=eu` | The records page (#19): `{ region, updatedAt, records, activity, topHosts }`, counting the region's accepted matches only (not void, review or rejected). The cron rebuilds it ([database.md](database.md), "Records"): `updatedAt` is when, usually 60 to 70 minutes (`recordsRefreshMinutes`) after a change, within 10 when a match stops counting (meanwhile that match is left out of the records); `null` before the first time, with every record `null`. `records`: `roundDeflects` (most `DEFLECT`s by one player in one round), `fastestDeflect` (highest ball speed after a deflect), `matchKills` (most `KILL`s in one match, not of themselves), `matchWins` (most rated rounds won in one match), `highestRating` (highest display rating after a match): each `{ value, player: { id, name }, matchId, playedAt }`, plus `round` for the first two. `winStreak` (most rated rounds won in a row, across matches), `mostRounds`, `mostWins` (rated rounds played and won): each `{ value, player }`. Each is `null` with nothing to count; a tie goes to the first to set it (for the last three, the lowest player id). `activity`: the last `recordsActivityDays` (28) days in UTC, today included: `{ days, matches, rounds, players, perDay }`, `rounds` the rated rounds, `players` different players who joined a match; `perDay`: `date, matches, rounds, players` for every day, oldest first, zeros included. `topHosts`: at most `recordsTopHosts` (10), `name, matches` (matches hosted), most first. A match moved to the other region moves with its records at the next rebuild |
| `GET /api/head-to-head?a=12&b=34&region=eu` | Two players' record against each other in the region (#18): `{ region, rounds, a, b }`. Only `accepted` matches of the region count (not void ones, nor ones in review). `rounds`: rated rounds both finished. `a` and `b`: `id, name, ahead` (of those rounds, the ones they finished above the other), `kills` (every `KILL` line of theirs on the other, in any round or between rounds, as the match stats count kills; so two players can have kills and no rounds). All 0 when they never met there. A player an admin merged into another counts as that one ([Merging players](#merging-players)). `400 bad_request` when `a` or `b` is missing, not an id, or both are the same player (merges followed); `404 not_found` when either isn't a player. Read from totals kept on upload ([database.md](database.md), "Match stats and head-to-head") |
| `GET /api/tourneys?region=eu&page=1` | `{ region, page, pageSize, hasMore, upcoming, past }`: the region's tourneys. `upcoming`: every `scheduled` or `live` tourney, soonest first (page 1 only). `past`: `done` and `cancelled` ones, newest first, `tourneysPageSize` (10) a page. Each tourney: `id, name, region, startsAt, status, notes, capacity, signups, lobbies`. `capacity`: the players its lobbies hold (0 with no lobby). `signups`: `{ open, count, full }`: `open` while it's `scheduled`, `count` the names signed up and not removed, `full` once `count` reaches a `capacity` above 0 ([Sign up](#sign-up-for-a-tourney-post-apitourneysidsignups)). Each lobby: `id, label, capacity, matchId` (`null` until its match is linked and public), `void, screenshot` (its URL or `null`), `screenshotExpired` (deleted to stay inside the storage caps), `verified`, and `standings`: `place, id, name, wins, kills, ratingBefore, ratingAfter`, most rounds won first, ties broken by kills, the same wins and kills sharing a place. Wins count every `WIN` round, rated or not; kills every `KILL` that isn't a player killing themselves |
| `GET /api/tourneys/:id` | `{ tourney }`, as in the list, with `signups.names`: the names signed up and not removed, first come first (those past `capacity` wait for another lobby) |
| `GET /api/lobbies?region=eu` | `{ region, lobbies }`: the region's ranked lobbies open now ([Live lobby](#live-lobby-put-apihostlobby-delete-apihostlobby)), longest open first. Each: `hostName, name` (`null` when the host gave none), `players, openedAt, seenAt` (the last heartbeat, within `lobbyTtlSeconds`), `tourney` (`null` until #25). A revoked host's lobby isn't listed. Poll it no more often than every `lobbiesCacheSeconds` (15 s) |
| `GET /api/screenshots/:key` | A verify screenshot currently belonging to a lobby (the `screenshot` URL), cached for `screenshotCacheSeconds` (1 h): a key is never reused. Removed or expired keys return `404`, including while their R2 deletion is being retried; an already cached copy can remain until its cache lifetime ends |

## Sign up for a tourney: `POST /api/tourneys/:id/signups`

A player types their in-game name on the tourney's page to say they're coming (#31). No login, and nothing is enforced: it tells admins how many lobbies to set up (#24). A [public write](#public-api-cors-and-caching): same origin only, never cached. Code: `src/tourney/signups.ts`.

Body `{ "name": "Kenzo" }`: spaces around it dropped, at most `playerNameMaxLength` (64) characters, no control characters, the body at most `tourneySignupBodyMaxBytes` (1 KB).

`201` for a new sign-up, `200` for a name already signed up (nothing written):

```json
{ "signup": { "name": "Kenzo", "signedUpAt": "2026-10-06T10:00:00Z" }, "created": true, "capacity": 20, "signups": { "open": true, "count": 21, "full": true } }
```

- **Only while the tourney is `scheduled`.** Sign-ups close when it goes live, is done or cancelled.
- **One per name per tourney**, whatever its case: `kenzo` after `Kenzo` answers Kenzo's sign-up.
- **Past capacity is fine.** `full` says the lobbies are full; the sign-up is still taken and listed after the others, and admins add a lobby. A tourney stores at most `tourneySignupsMax` (200) sign-ups.
- **Rate limit:** at most `tourneySignupsPerHour` (10) stored sign-ups per IP an hour, across tourneys. Only the SHA-256 of the IP is stored, for this.
- Admins see and remove sign-ups ([Admin](#admin-apiadmin)). A removed name can't sign up for that tourney again.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | The body isn't a JSON object, or `name` is missing, blank, too long or has control characters |
| 403 | `cross_origin` | Sent from another site's page |
| 404 | `not_found` | No such tourney |
| 405 | `method_not_allowed` | Not a `POST` |
| 409 | `closed` | The tourney isn't `scheduled` any more |
| 409 | `removed` | An admin removed this name from the tourney's sign-ups |
| 409 | `too_many` | The tourney has `tourneySignupsMax` sign-ups |
| 429 | `rate_limited` | Over `tourneySignupsPerHour` for this IP. `Retry-After` says when to try again |

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
- `names` are the names the players were last seen with in a log, which is how the Workshop writes them (not a display name an admin set, [Merging players](#merging-players)). Names with `{` or `}`, and names over 128 characters, are left out. The rest are raw: **the host tool escapes `"` and `\`** when it writes the `Custom String`s.
