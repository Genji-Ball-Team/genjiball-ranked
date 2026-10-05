-- Live lobbies (#11): the ranked lobbies open right now, from the host tool's heartbeats
-- (`PUT /api/host/lobby`, docs/api.md). One row per host: a host runs one lobby at a time. A
-- heartbeat refreshes the row without touching `region`, so it's one row written. A row whose
-- heartbeats stopped (`seen_at` older than `lobbyTtlSeconds`) or that was closed isn't listed, and
-- the cron deletes it once that's older than the TTL.
CREATE TABLE live_lobbies (
  host_id   INTEGER PRIMARY KEY REFERENCES hosts(id),
  region    TEXT NOT NULL,                    -- X-Region, else the host's home region (#47)
  name      TEXT,                             -- the lobby name the host gave, or NULL
  players   INTEGER NOT NULL,                 -- players in the lobby at the last heartbeat
  opened_at TEXT NOT NULL,                    -- first heartbeat of this lobby
  seen_at   TEXT NOT NULL,                    -- last heartbeat
  closed_at TEXT                              -- set: the host closed it. The row stays, so the
                                              -- next heartbeat still waits `lobbyHeartbeatMinSeconds`
);

-- `GET /api/lobbies?region=` reads one region's rows. Only region is indexed, and a heartbeat in the
-- same region doesn't SET it, so the index isn't rewritten.
CREATE INDEX live_lobbies_region ON live_lobbies(region);
