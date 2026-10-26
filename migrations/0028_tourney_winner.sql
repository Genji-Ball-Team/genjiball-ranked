-- A tourney's winner (#124): the player who won it outright, set by an admin once it's done. Left as
-- it is when the player is merged: reads follow `players.merged_into` to the player it is now, so an
-- undone merge needs nothing (src/admin/playerStore.ts, `followed`).
ALTER TABLE tourneys ADD COLUMN winner_player_id INTEGER REFERENCES players(id);
