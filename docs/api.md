# API

What the server offers the host tool ([genjiball-host-tool](https://github.com/Genji-Ball-Team/genjiball-host-tool)) and other clients. All responses are JSON. An error is `{ "error": "<code>", "message": "<for people>" }` with a 4xx status.

## Upload a log: `POST /api/upload`

The host tool sends a Workshop log file (`Documents/Overwatch/Workshop/Log-*.txt`) as it is. Code: `src/upload/`.

| Part | |
|---|---|
| Body | The file's text, unchanged (UTF-8). At most `maxUploadBytes` (512 KB) |
| `Authorization` | `Bearer <host token>`. Admins hand out tokens (#7); the server stores only their SHA-256 |
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
| `accepted` | Counts for the ratings |
| `review` | Waits for an admin. `reviewReasons`: `duplicate_name` (two players with the same name at once), `untrusted_host` |
| `rejected` | Never counts. `rejection.code`: `unranked` (an `UNRANKED` line), `unknown_format` (kept to re-parse when the server learns the format), `too_few_players` (fewer than `minMatchPlayers` in rated rounds), `untrusted_host` (when `untrustedHostUploads` is `reject`), `no_match_key` |
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
