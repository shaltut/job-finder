CREATE TABLE `post_requirements` (
	`key` text NOT NULL,
	`term` text NOT NULL,
	`category` text NOT NULL,
	`importance` text NOT NULL,
	`status` text NOT NULL,
	`quote` text NOT NULL,
	`cv_shows` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`key`, `term`),
	FOREIGN KEY (`key`) REFERENCES `posts`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `requirement_runs` (
	`key` text PRIMARY KEY NOT NULL,
	`cv_sha` text NOT NULL,
	`model` text NOT NULL,
	`kept` integer NOT NULL,
	`dropped` integer NOT NULL,
	`extracted_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`key`) REFERENCES `posts`(`key`) ON UPDATE no action ON DELETE cascade
);
