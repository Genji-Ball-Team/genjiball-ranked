# Legacy v1.3.2 logs

Before ranked logging (v1.3.3R), the v1.3.2 RANKED version logged one line per death and nothing else ([spec](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md#legacy-v132-logs)):

```
[00:00:21] KILL|21.81|Fealthy|MrPichulin
```

`time` is Total Time Elapsed, then the attacker's name and the victim's. These files are imported as **legacy matches** (#4, #13) so the ratings start from the games already played. They're marked "Legacy" on the site. Code: `src/parser/legacy.ts`.

## Importing

An admin imports them; hosts can't upload them (`422 legacy_log`).

```sh
GENJIBALL_ADMIN_TOKEN=<admin token> npm run import:legacy -- https://test.genjiball.us <host id> path/to/logs
```

- `<host id>` is the host whose lobbies the files are from (add one at `/admin` first). The import counts as from a trusted host.
- The script sends the files oldest first, and leaves out a file whose `KILL` lines are the start of another file's: a shorter copy of the same match. Legacy logs have no `matchKey`, so this is the only way to tell copies apart. Each file is its own match, keyed `legacy-<hash of the file>`, and the same file twice is a `duplicate`.
- The match's start time comes from the file name, read in the time zone of the computer running the script: run it in the host's.
- Import to the test server first and spot-check the rounds. Then import the same files directly into `https://genjiball.us`, using a production admin token and the intended host's production ID (add that host at production `/admin` first if needed). Tokens and host IDs belong to each database, so don't reuse the test values. Never copy the test database over, since it also holds test uploads.

## How the rounds are rebuilt

The log has no rounds, joins, leaves, winners or deflects. The parser rebuilds the rounds from how v1.3.2 plays (`original/genjiball-v1.3.2-ranked.txt` in GenjiBall-CE):

- **A round ends when one player is left alive.** That winner never dies, so they have no line: the winner is the one player in the lobby who didn't go out.
- **Everyone dies at most once a round.** A second death of the same player means a new round.
- **No attacker:** the attacker is the victim. That's the ball killing its target before anyone deflected (a first-ball loss, a real loss), a fall, or the game killing the player.
- **Joining mid-round:** v1.3.2 kills a player who spawns while a round is going. A player whose first line is a death with no attacker, once a round has been won, is a joiner: they're left out of that round and play from the next. One killed in the 2.25 s after a win (`legacyResurrectSeconds`) is resurrected with everyone and plays the next round.
- **Who is in the lobby:** a player is there from their first line on, and stays in each round they were there at the start of, until they go out. After their last line they're gone.
- **Timing:** after a win the game waits 2.25 s and counts down 5 s before the ball spawns, so the next round's first death is at least about 7.6 s after the last one (`legacyRoundGapSeconds`, 7). A death sooner than that is in the same round, so a round isn't closed while the next death is that close: a player we haven't seen yet is still alive in it.
- **Alone in the lobby:** with fewer than 2 players there's no round.

## What isn't rated

- **Rounds with a bot** (`legacyBotNames`: `Genji Bot` and the dummy bot `zSh4d0Ws bozo`). New logs reject a whole match with a bot; a legacy file is often a long lobby with a bot in only some rounds, so only those rounds are left out.
- **Rounds the rebuild can't be sure of** (`ABORT`, with the reason in `broken`): a player died twice before the round had a winner, so someone joined or left unseen.
- **`NONE` rounds:** everyone in the round died.
- A match still needs `minMatchPlayers` (2) players in its rated rounds, like a new one.

Everything else is rated like a new round, AFK players included: a player who idles in the lobby loses each round to the first ball, as they would in a new log.

On the 306 real files (Sep 22 to Oct 3, 2026): about 5,800 rounds, of which about 2,700 are rated (about 2,200 had a bot, about 800 were uncertain), with about 770 players, and 193 matches with enough players to count.

## Guesses that can be wrong

- A player who leaves silently, or joins between rounds and wins without a line, makes the lobby wrong for a round. Usually that shows as a player dying twice and the round isn't rated; sometimes it moves a winner.
- A real first death with no attacker of a player not seen before (after the first round) is taken for a join.
- The finishing order is exact for the players who went out. The winner is a deduction.
