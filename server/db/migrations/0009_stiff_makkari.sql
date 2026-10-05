CREATE TABLE `app_drafts` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`mode` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`outcome` text
);
--> statement-breakpoint
-- Backfill: every application draft already created. A draft already sent or deleted is gone from Gmail and
-- the sender records it as such on first look. Follow-up drafts kept their id only in a note the sweep
-- overwrites, so they cannot be recovered here.
INSERT OR IGNORE INTO `app_drafts` (`draft_id`, `email`, `mode`, `created_at`)
SELECT `gmail_draft_id`, lower(`recruiter_email`), 'apply', min(coalesce(`created_at`, unixepoch()))
FROM `applications`
WHERE `verdict` = 'drafted' AND `gmail_draft_id` IS NOT NULL AND `gmail_draft_id` NOT LIKE '%.json'
  AND `recruiter_email` IS NOT NULL
GROUP BY `gmail_draft_id`;
