-- Tournaments: an admin marks a match (POST /api/admin/matches/:id/tournament). It counts
-- `tournamentWeight` times as much, and nobody gains or loses more than `tournamentMaxChange` in it.
ALTER TABLE matches ADD COLUMN tournament INTEGER NOT NULL DEFAULT 0 CHECK (tournament IN (0, 1));
