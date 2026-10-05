-- Merging players and naming them (#8). See docs/api.md, "Players", and docs/database.md, "Merging players".

-- A merged player keeps their row (so the id isn't handed out again and an undo can bring it
-- back), with no aliases and no ratings. NULL: not merged.
ALTER TABLE players ADD COLUMN merged_into INTEGER REFERENCES players(id);
-- 1: an admin set the display name, and uploads don't change it. 0: it's the name seen most recently.
ALTER TABLE players ADD COLUMN name_fixed INTEGER NOT NULL DEFAULT 0 CHECK (name_fixed IN (0, 1));

-- Keep the alias used in a match, even when it moves or changes spelling. Before this migration
-- every player has one alias, so existing rows can use it without SQLite's ASCII-only lower().
ALTER TABLE match_players ADD COLUMN alias_id INTEGER REFERENCES aliases(id);
UPDATE match_players SET alias_id = (SELECT id FROM aliases WHERE player_id = match_players.player_id);

-- Every merge, kept for its undo. `aliases`: JSON array of the ids of the aliases it moved, which an
-- undo moves back with the match rows played under those names.
CREATE TABLE player_merges (
  id        INTEGER PRIMARY KEY,
  from_id   INTEGER NOT NULL REFERENCES players(id),  -- the player merged away
  into_id   INTEGER NOT NULL REFERENCES players(id),  -- the player who kept their id
  aliases   TEXT NOT NULL,
  merged_by INTEGER NOT NULL REFERENCES admins(id),
  merged_at TEXT NOT NULL,
  undone_by INTEGER REFERENCES admins(id),
  undone_at TEXT                                       -- set: undone, and can't be undone again
);
-- A player page's merges.
CREATE INDEX player_merges_from ON player_merges(from_id);
CREATE INDEX player_merges_into ON player_merges(into_id);
