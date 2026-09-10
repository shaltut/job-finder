CREATE TABLE `applications` (
	`key` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`reason` text,
	`recruiter_email` text,
	`gmail_draft_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`key`) REFERENCES `posts`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `applications_recruiter_idx` ON `applications` (`recruiter_email`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`email` text PRIMARY KEY NOT NULL,
	`stage` text NOT NULL,
	`thread_id` text,
	`last_sent_at` integer,
	`note` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "contacts_email_lower" CHECK("contacts"."email" = lower("contacts"."email"))
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`key` text PRIMARY KEY NOT NULL,
	`scraped_at` integer DEFAULT (unixepoch()) NOT NULL,
	`search_term` text,
	`author` text,
	`author_url` text,
	`posted_age` text,
	`posted_at` integer,
	`title` text,
	`company` text,
	`location` text,
	`remote` integer,
	`in_scope` integer,
	`emails` text DEFAULT ('[]') NOT NULL,
	`score` integer,
	`reason` text,
	`text` text NOT NULL,
	`flags` text DEFAULT ('[]') NOT NULL
);
--> statement-breakpoint
CREATE INDEX `posts_score_idx` ON `posts` (`score`);--> statement-breakpoint
CREATE INDEX `posts_posted_at_idx` ON `posts` (`posted_at`);--> statement-breakpoint
CREATE INDEX `posts_search_term_idx` ON `posts` (`search_term`);