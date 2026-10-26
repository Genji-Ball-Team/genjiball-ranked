-- Records with top lists and this month: a page stored before has neither, and
-- `readRecords` treats it as not made yet. Make every region's page urgent, so the next cron run
-- rebuilds it.
UPDATE records_revisions SET revision = revision + 1, urgent = revision + 1;
