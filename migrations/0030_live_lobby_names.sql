-- Live lobby players (#11): the names of the players in the lobby at the last heartbeat, a JSON
-- array of strings in the order they joined, so the Live page and the Discord bot can list them.
-- NULL when the heartbeat sent none (a host tool from before names were sent). Not indexed, so a
-- heartbeat that refreshes it is still one row written.
ALTER TABLE live_lobbies ADD COLUMN names TEXT;
