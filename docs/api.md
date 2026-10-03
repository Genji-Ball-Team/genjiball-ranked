# API

What the server offers the host tool ([genjiball-host-tool](https://github.com/Genji-Ball-Team/genjiball-host-tool)), admins and other clients. All responses are JSON. An error is `{ "error": "<code>", "message": "<for people>" }` with a 4xx status.

## Upload a log: `POST /api/upload`

The host tool sends a Workshop log file (`Documents/Overwatch/Workshop/Log-*.txt`) as it is. Code: `src/upload/`.

| Part | |
|---|---|
| Body | The file's text, unchanged (UTF-8). At most `maxUploadBytes` (512 KB) |
| `Authorization` | `Bearer <host token>`. Admins hand out tokens ([Admin](#admin-apiadmin)); the server stores only their SHA-256 |
| `X-Log-File` | Optional. The file name |
| `X-Log-Started-At` | Optional. When the file was started, ISO 8601 with a time zone (`2026-10-03T20:15:33+02:00`). The file name has no time zone, so send this: it orders the matches for the rating. Without it, or if it's in the future, the upload time is used |

Upload every file, whenever it changes or stops growing: the server sorts out the copies (see "One match in several files" in GenjiBall-CE [`docs/ranked-log.md`](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md)). Sending the same file again is cheap and changes nothing.

### Response

`200`:

```json
{
  "result": "stored",
  "uploadId": 12,
  "matches": [
    {
      "matchKey": "482913507226",
      "lineCount": 57,
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
| `rejected` | Never counts. `rejection.code`: `unranked` (an `UNRANKED` line), `unknown_format` (kept to re-parse when the server learns the format), `too_few_players` (fewer than `minMatchPlayers` in rated rounds), `untrusted_host` (when `untrustedHostUploads` is `reject`), `no_match_key`, `admin` (an admin rejected it from the review queue; a longer copy doesn't change that) |
| `void` | An admin voided it. A longer copy doesn't change that |

### Errors

| Status | `error` | When |
|---|---|---|
| 400 | `empty` | No body |
| 401 | `unauthorized` | No token, or an unknown one |
| 403 | `revoked` | The token was revoked. Stop uploading with it |
| 405 | `method_not_allowed` | Not a `POST` |
| 409 | `conflict` | Another upload of the same match was being stored at that moment. Try again |
| 413 | `too_large` | Over `maxUploadBytes` |
| 422 | `not_ranked` | No `GBR` line: not a ranked log. Don't upload these |
| 422 | `legacy_log` | A v1.3.2 log (`KILL` lines, no `GBR`). Old logs are imported by an admin (#13) |
| 429 | `rate_limited` | Over `maxUploadsPerHour` stored uploads for this token. `Retry-After` says when to try again |

A 5xx or a network error: keep the file and try again later.

## Admin: `/api/admin/*`

For admins, from the admin page (`/admin`) or any HTTP client. Code: `src/admin/`. Every request needs `Authorization: Bearer <admin token>`; without a valid, unrevoked one it's `401 unauthorized`. Every change is written to `admin_actions` (who, what, when, which match or host) in the same transaction.

**Admin tokens.** The server stores only their SHA-256, like host tokens. `npm run admin:token -- <name>` prints a new token and writes the SQL that adds the admin to a file, with the `wrangler d1 execute --file` command to run; revoke one by setting `admins.revoked_at`. The admin page keeps the token in the tab's `sessionStorage` and sends it as the header, so there's no cookie to forge a request with.

| Route | Does |
|---|---|
| `GET /api/admin/me` | `{ admin: { id, name } }`: checks a token |
| `GET /api/admin/hosts` | `{ hosts }`: newest first, at most `adminListLimit` |
| `POST /api/admin/hosts` | Body `{ "name": "...", "trust": "trusted" \| "untrusted" }` (`untrusted` if left out). `201 { host, token }`: the **token is shown only here** |
| `POST /api/admin/hosts/:id/trust` | Body `{ "trust": "trusted" \| "untrusted" }`. Applies to the host's next upload |
| `POST /api/admin/hosts/:id/revoke` | The token stops working (`403 revoked` on upload). Final: make a new host token instead |
| `GET /api/admin/matches?status=review` | `{ matches }` with that status (`review` if left out; `accepted`, `rejected`, `void`), newest first, at most `adminListLimit`. Each has `reviewReasons`, `rejection`, `hostName`, `players`, `complete`, `rated` |
| `GET /api/admin/matches/:id` | `{ match }` |
| `POST /api/admin/matches/:id/accept` | `review` → `accepted`; also a match an admin rejected |
| `POST /api/admin/matches/:id/reject` | `review` → `rejected`, `rejection.code` `admin`. Body `{ "reason": "..." }` optional |
| `POST /api/admin/matches/:id/void` | `accepted` → `void`. Body `{ "reason": "..." }` optional |
| `POST /api/admin/matches/:id/unvoid` | `void` → `accepted`, or `rejected` if a longer copy that arrived while it was void was rejected (an `UNRANKED` line, say) |
| `GET /api/admin/actions` | `{ actions }`: the action log, newest first, at most `adminListLimit` |

A match action answers `{ match, ratingsStale }`. Accepting, voiding or un-voiding brings the ratings up to date as far as one cron run would ([rating.md](rating.md)): a match that now counts is rated straight away if it's the newest, and a short stale tail is recomputed. `ratingsStale: true` means the cron finishes the recompute (every 10 minutes).

**Decisions that last.** A longer copy of a match keeps an admin's void or rejection. An accept doesn't: a longer copy is judged again, and goes back to review if it still has a reason to (its new rounds haven't been looked at).

`admin_actions.action`: `host_create`, `host_trust`, `host_revoke`, `match_accept`, `match_reject`, `match_void`, `match_unvoid`. `detail` is JSON: the name and trust of a new host, `from` and `to` of a change, and the `reason` when one was given.

### Errors

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | The body isn't a JSON object, a field is missing or wrong, or a name or reason is over `adminTextMaxLength` characters |
| 401 | `unauthorized` | No admin token, or an unknown or revoked one |
| 404 | `not_found` | No such route, match or host |
| 405 | `method_not_allowed` | Wrong method. `Allow` says which |
| 409 | `conflict` | The action doesn't fit the status (voiding a match in review, un-revoking a host), or another admin changed it at the same time |
