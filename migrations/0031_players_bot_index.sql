-- The few bot players, for the `NOT IN (SELECT id FROM players WHERE bot = 1)` of head-to-head
-- (src/upload/pairs.ts) and records without reading every player: each upload's match_pairs insert
-- scanned the players table twice. Only bots are in it, so a new player's insert doesn't write to it.
CREATE INDEX players_bot ON players(id) WHERE bot = 1;
