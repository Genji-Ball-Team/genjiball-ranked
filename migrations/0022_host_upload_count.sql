-- The upload rate limit (config `maxUploadsPerHour`) counts the files a host stored in the hour,
-- also those a longer copy has deleted since. Counting the `uploads` rows missed those. See
-- docs/api.md, "Upload".

-- When the host's current hour of uploads started, and the files stored in it.
ALTER TABLE hosts ADD COLUMN uploads_hour_start TEXT;
ALTER TABLE hosts ADD COLUMN uploads_hour_count INTEGER NOT NULL DEFAULT 0;
