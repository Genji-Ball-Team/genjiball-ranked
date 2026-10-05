-- Live lobbies (#11): the ranked lobbies open right now, from the host tool's heartbeats
-- (`PUT /api/host/lobby`, docs/api.md). One row per host: a host runs one lobby at a time, and each
-- heartbeat is one upsert of that row. A row whose heartbeats stopped (`seen_at` older than
-- `lobbyTtlSeconds`) isn't listed, and the cron deletes it.
CREATE TABLE live_lobbies (
  host_id   INTEGER PRIMARY KEY REFERENCES hosts(id),
  region    TEXT NOT NULL,                    -- X-Region, else the host's home region (#47)
  name      TEXT,                             -- the lobby name the host gave, or NULL
  players   INTEGER NOT NULL,                 -- players in the lobby at the last heartbeat
  opened_at TEXT NOT NULL,                    -- first heartbeat of this lobby
  seen_at   TEXT NOT NULL                     -- last heartbeat
);

-- `GET /api/lobbies?region=` reads one region's rows. Only region is indexed: a heartbeat that keeps
-- its region doesn't rewrite the index, so it stays one row written.
CREATE INDEX live_lobbies_region ON live_lobbies(region);
