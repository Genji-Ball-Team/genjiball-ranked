-- The build id of the game code that wrote the match: the last field of the `GBR` line
-- (GenjiBall-CE docs/ranked-log.md, "Build id"). Every merge into v1.3.3R is re-released as 1.3.3R,
-- so game_version can't tell the builds apart. NULL for logs from before the field (and legacy logs).
-- A longer copy of a match replaces it, like game_version. See docs/database.md.
ALTER TABLE matches ADD COLUMN build TEXT;
