-- Records with top lists, this month and climbers: a page stored before has none of them, and
-- `readRecords` treats it as not made yet. Make every region's page urgent, so the next cron run
-- rebuilds it.
UPDATE records_revisions SET revision = revision + 1, urgent = revision + 1;
