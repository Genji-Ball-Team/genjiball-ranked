-- Initial schema. Follows GenjiBall-CE docs/ranked-log.md (format 1). See docs/database.md.
-- Times are stored as ISO 8601 text (UTC). Log times (`time` in the log) are REAL seconds.

-- A player account. Names map to players through aliases; admins merge aliases (#8).
CREATE TABLE players (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,                -- display name: the alias seen most recently
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Every name seen for a player. A name belongs to one player; matching ignores case.
CREATE TABLE aliases (
  id            INTEGER PRIMARY KEY,
  player_id     INTEGER NOT NULL REFERENCES players(id),
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL UNIQUE,         -- lower(name), for lookups
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX aliases_player ON aliases(player_id);

-- A host who uploads logs with a token. Only the SHA-256 of the token is stored.
CREATE TABLE hosts (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,        -- hex SHA-256 of the bearer token
  trust          TEXT NOT NULL DEFAULT 'untrusted' CHECK (trust IN ('trusted', 'untrusted', 'revoked')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_upload_at TEXT
);

-- Every uploaded log file, kept so everything can be re-parsed and re-rated.
CREATE TABLE uploads (
  id           INTEGER PRIMARY KEY,
  host_id      INTEGER NOT NULL REFERENCES hosts(id),
  content_hash TEXT NOT NULL UNIQUE,          -- hex SHA-256 of the raw text: the same file is stored once
  raw_log      BLOB NOT NULL,                 -- gzip of the raw text
  raw_size     INTEGER NOT NULL,              -- bytes before gzip
  file_name    TEXT,                          -- Log-<date>-<time>.txt, as the host tool sent it
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  status       TEXT NOT NULL CHECK (status IN ('parsed', 'rejected', 'error')),
  error        TEXT                           -- why it was rejected or failed
);
CREATE INDEX uploads_host ON uploads(host_id, received_at);

-- One match from a log. Several files can hold copies of the same match (same host and matchKey):
-- the copy with the most lines wins, and replaces the stored one.
CREATE TABLE matches (
  id                INTEGER PRIMARY KEY,
  upload_id         INTEGER NOT NULL REFERENCES uploads(id),
  host_id           INTEGER NOT NULL REFERENCES hosts(id),
  match_key         TEXT,                     -- GBR matchKey, as text. NULL for legacy logs
  line_count        INTEGER NOT NULL,         -- lines of ours in this copy
  format            INTEGER NOT NULL,         -- log format version; 0 for legacy
  game_version      TEXT NOT NULL,
  legacy            INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  status            TEXT NOT NULL CHECK (status IN ('accepted', 'review', 'rejected', 'void')),
  rejection_code    TEXT,                     -- unranked, unknown_format, too_few_players, ...
  rejection_message TEXT,
  review_reasons    TEXT,                     -- comma-separated: duplicate_name, untrusted_host, ...
  unranked          TEXT,                     -- comma-separated UNRANKED reasons
  map               TEXT,
  preset            TEXT,
  played_at         TEXT NOT NULL,            -- when the match started (from the file name, else received_at)
  complete          INTEGER NOT NULL CHECK (complete IN (0, 1)),  -- has MATCH_END
  UNIQUE (host_id, match_key)
);
-- Rating recompute and the match list: accepted matches in play order.
CREATE INDEX matches_status_played ON matches(status, played_at);

-- The players of a match, by their per-match log id.
CREATE TABLE match_players (
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  log_id     INTEGER NOT NULL,                -- the id from JOIN
  player_id  INTEGER NOT NULL REFERENCES players(id),
  name       TEXT NOT NULL,                   -- the name in this match
  join_time  REAL NOT NULL,
  leave_time REAL,
  PRIMARY KEY (match_id, log_id)
) WITHOUT ROWID;
-- Player page: the matches a player was in.
CREATE INDEX match_players_player ON match_players(player_id, match_id);

CREATE TABLE rounds (
  id         INTEGER PRIMARY KEY,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  result     TEXT NOT NULL CHECK (result IN ('WIN', 'NONE', 'ABORT')),
  winner_id  INTEGER,                         -- log id of the winner
  start_time REAL NOT NULL,
  end_time   REAL NOT NULL,
  rated      INTEGER NOT NULL CHECK (rated IN (0, 1)),
  broken     TEXT,                            -- why a WIN round can't be rated
  UNIQUE (match_id, number)
);

-- Who was in a round and how they finished. Head-to-head compares two players' rows per round.
CREATE TABLE round_players (
  round_id    INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  log_id      INTEGER NOT NULL,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  position    INTEGER,                        -- 1 = winner, in the rated finishing order. NULL if left or not rated
  place       INTEGER,                        -- ELIM place as logged (NULL for the winner and leavers)
  left_round  INTEGER NOT NULL DEFAULT 0 CHECK (left_round IN (0, 1)),
  killer_id   INTEGER,                        -- log id from ELIM
  PRIMARY KEY (round_id, log_id)
) WITHOUT ROWID;
CREATE INDEX round_players_player ON round_players(player_id, round_id);

-- KILL and DEFLECT lines, for stats. Bulk-inserted per match from JSON (docs/database.md).
CREATE TABLE events (
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,                -- order in the file
  type       TEXT NOT NULL CHECK (type IN ('KILL', 'DEFLECT')),
  round      INTEGER,                         -- round number, NULL between rounds
  time       REAL NOT NULL,
  actor_id   INTEGER,                         -- KILL: attacker, DEFLECT: deflecting player (log ids)
  target_id  INTEGER,                         -- KILL: victim, DEFLECT: the ball's new target
  speed      REAL,                            -- DEFLECT only
  PRIMARY KEY (match_id, seq)
) WITHOUT ROWID;

-- Current ratings. `board` is the leaderboard (ranked now; tourney and global with #26).
CREATE TABLE ratings (
  board          TEXT NOT NULL DEFAULT 'ranked',
  player_id      INTEGER NOT NULL REFERENCES players(id),
  mu             REAL NOT NULL,
  sigma          REAL NOT NULL,
  display        REAL NOT NULL,               -- scaled conservative rating (#6)
  rounds         INTEGER NOT NULL DEFAULT 0,  -- rated rounds played
  wins           INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT,
  PRIMARY KEY (board, player_id)
) WITHOUT ROWID;
-- Leaderboard: top display ratings per board.
CREATE INDEX ratings_board_display ON ratings(board, display DESC);

-- Rating after each match a player was in, for the graph (#17).
CREATE TABLE rating_history (
  board     TEXT NOT NULL DEFAULT 'ranked',
  player_id INTEGER NOT NULL REFERENCES players(id),
  match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  mu        REAL NOT NULL,
  sigma     REAL NOT NULL,
  display   REAL NOT NULL,
  played_at TEXT NOT NULL,
  PRIMARY KEY (board, player_id, played_at, match_id)
) WITHOUT ROWID;
