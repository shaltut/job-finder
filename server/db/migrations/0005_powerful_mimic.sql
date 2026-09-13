ALTER TABLE `posts` ADD `links` text DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `phones` text DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `ref_ids` text DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `channels` text DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `applied_at` integer;