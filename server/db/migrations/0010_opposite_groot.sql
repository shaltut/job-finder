CREATE TABLE `inbox` (
	`message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`contact_email` text NOT NULL,
	`from_addr` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`received_at` integer NOT NULL,
	`read_at` integer,
	`reply_status` text,
	`reply_draft_id` text,
	`reply_draft_msg_id` text,
	`questions` text,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `inbox_thread` ON `inbox` (`thread_id`);--> statement-breakpoint
CREATE TABLE `inbox_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_poll_at` integer,
	CONSTRAINT "inbox_state_one_row" CHECK("inbox_state"."id" = 1)
);
