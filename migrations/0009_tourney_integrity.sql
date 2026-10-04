-- Reject concurrent changes to the result or screenshot an admin checked.
ALTER TABLE tourney_lobbies ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX tourney_lobbies_screenshot_key ON tourney_lobbies(screenshot_key) WHERE screenshot_key IS NOT NULL;

-- Keep failed R2 deletes discoverable after the lobby stops referring to the image.
CREATE TABLE screenshot_deletions (
  key TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  delete_after TEXT NOT NULL
);
CREATE INDEX screenshot_deletions_due ON screenshot_deletions(delete_after);
