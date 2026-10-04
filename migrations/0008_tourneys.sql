-- Tourneys (#22, #24, #28, #31). Tourney matches stay on the one leaderboard: a lobby's match is
-- marked `matches.tournament` (0006), which is what the rating reads. These tables hold what the
-- Tourneys page shows: the schedule, each lobby's match and its verify screenshot.

-- A tourney an admin schedules. `starts_at` is UTC; the site shows it in the viewer's time zone.
CREATE TABLE tourneys (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  starts_at  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'done', 'cancelled')),
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
-- Tourneys page: upcoming ones by start, past ones newest first.
CREATE INDEX tourneys_status_starts ON tourneys(status, starts_at);

-- A lobby of a tourney ("Lobby 1/2"), its match once uploaded and its verify screenshot.
CREATE TABLE tourney_lobbies (
  id             INTEGER PRIMARY KEY,
  tourney_id     INTEGER NOT NULL REFERENCES tourneys(id),
  label          TEXT NOT NULL,
  match_id       INTEGER UNIQUE REFERENCES matches(id),  -- a match is in one lobby at most
  screenshot_key TEXT,                                   -- the image's key in R2 (PROOFS), NULL until uploaded or once expired
  screenshot_at  TEXT,
  screenshot_bytes INTEGER,
  screenshot_expired_at TEXT,                            -- set: the screenshot was deleted to stay inside the storage caps
  verified_by    INTEGER REFERENCES admins(id),          -- set: an admin checked the screenshot against the standings
  verified_at    TEXT
);
CREATE INDEX tourney_lobbies_tourney ON tourney_lobbies(tourney_id);
-- Expiring screenshots: the stored ones, oldest first.
CREATE INDEX tourney_lobbies_screenshot ON tourney_lobbies(screenshot_at) WHERE screenshot_key IS NOT NULL;
