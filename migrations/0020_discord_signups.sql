-- Discord sign-ups (Genji-Ball-Team/Discord-Bot): the bot's Register button signs the player up
-- here too, so the Tourneys page and Discord show one list. `discord_user_id`: the Discord user who
-- signed up from the bot, or who claimed a name already signed up from the page (the same name is
-- the same player). NULL for a sign-up from the page only. The bot's sign-ups have `ip_hash`
-- 'discord': they aren't rate-limited by IP.
ALTER TABLE tourney_signups ADD COLUMN discord_user_id TEXT;
-- One sign-up per Discord user per tourney.
CREATE UNIQUE INDEX tourney_signups_discord ON tourney_signups(tourney_id, discord_user_id) WHERE discord_user_id IS NOT NULL;
