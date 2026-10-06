-- Tourney sign-ups and lobby capacity (#22, #24, #31). A sign-up only says a player means to come:
-- no login, nothing enforced. It tells admins how many lobbies to set up.

-- Players a lobby holds. NULL: `tourneyLobbyCapacity` in src/config.ts. A tourney's capacity is
-- the sum of its lobbies'.
ALTER TABLE tourney_lobbies ADD COLUMN capacity INTEGER;

-- One in-game name signed up for a tourney, from the Tourneys page. `name` as typed (spaces around it
-- dropped), `name_key` lower case: a name signs up once per tourney, whatever its case. An admin
-- removes a sign-up by setting `removed_by` and `removed_at`: the row stays, so the name can't
-- sign up again, and the removal can be undone.
CREATE TABLE tourney_signups (
  id           INTEGER PRIMARY KEY,
  tourney_id   INTEGER NOT NULL REFERENCES tourneys(id),
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,                  -- hex SHA-256 of the signer's IP, only for the rate limit
  signed_up_at TEXT NOT NULL,
  removed_by   INTEGER REFERENCES admins(id),
  removed_at   TEXT
);
-- One sign-up per name per tourney; also how a tourney's sign-ups are read.
CREATE UNIQUE INDEX tourney_signups_name ON tourney_signups(tourney_id, name_key);
-- The rate limit: one IP's sign-ups in the last hour.
CREATE INDEX tourney_signups_ip ON tourney_signups(ip_hash, signed_up_at);
