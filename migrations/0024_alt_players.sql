-- Alt accounts: an admin marks a player as someone's second account. See docs/database.md, "Tables".

-- 1: an alt. It's rated like anyone, and its profile and matches stay public, but it isn't on the
-- leaderboard (nor the in-game top 10 and the Discord bot's leaderboard, which read it) and has no
-- place there: others' places don't count it.
ALTER TABLE players ADD COLUMN alt INTEGER NOT NULL DEFAULT 0 CHECK (alt IN (0, 1));
-- The few alts, for the places' `NOT IN` without reading every player.
CREATE INDEX players_alt ON players(id) WHERE alt = 1;
