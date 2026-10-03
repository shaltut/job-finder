CREATE TABLE `job_queue` (
	`id` integer PRIMARY KEY NOT NULL,
	`lane` text NOT NULL,
	`kind` text NOT NULL,
	`args` text NOT NULL,
	`queued_at` text NOT NULL,
	`started_at` text
);
