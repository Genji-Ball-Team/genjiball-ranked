-- Tourney hosts (#24, #25, #28): each lobby gets an assigned host, who reads its tourney code values
-- (GET /api/host/tourneys) and uploads its verify screenshot. The values the game's tourney rule
-- needs (GenjiBall-CE#142, #143) are the lobby's `lobby_key` and round limit.

-- The host who hosts the lobby. NULL: nobody yet. Any host, whatever its home region: the lobby's
-- region is always its tourney's.
ALTER TABLE tourney_lobbies ADD COLUMN host_id INTEGER REFERENCES hosts(id);
-- Rounds the lobby's match plays (the game's tourney round limit). NULL: `tourneyRoundLimit` in src/config.ts.
ALTER TABLE tourney_lobbies ADD COLUMN round_limit INTEGER;
-- The server's id for the lobby in the game's tourney rule and log (`lobbyKey`, GenjiBall-CE#142):
-- random digits, text. Made when the lobby is added; the lobbies added before this get one here:
-- 6 random digits then the lobby id as 6 digits, so no two collide (there are far fewer than a
-- million lobbies).
ALTER TABLE tourney_lobbies ADD COLUMN lobby_key TEXT;
UPDATE tourney_lobbies SET lobby_key = substr('000000' || abs(random() % 1000000), -6) || substr('000000' || id, -6) WHERE lobby_key IS NULL;
CREATE UNIQUE INDEX tourney_lobbies_lobby_key ON tourney_lobbies(lobby_key) WHERE lobby_key IS NOT NULL;
-- GET /api/host/tourneys: the host's lobbies.
CREATE INDEX tourney_lobbies_host ON tourney_lobbies(host_id) WHERE host_id IS NOT NULL;

-- What a host did through the host API (a verify screenshot uploaded or deleted), like
-- `admin_actions` for admins. Only ever inserted. `lobby_id` has no foreign key: a deleted lobby keeps its log.
CREATE TABLE host_actions (
  id       INTEGER PRIMARY KEY,
  host_id  INTEGER NOT NULL REFERENCES hosts(id),
  action   TEXT NOT NULL,                     -- lobby_screenshot, lobby_screenshot_delete (docs/api.md)
  lobby_id INTEGER,
  detail   TEXT,                              -- JSON
  at       TEXT NOT NULL
);
