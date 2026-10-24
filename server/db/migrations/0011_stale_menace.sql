CREATE TABLE `schedule_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_run_at` integer,
	CONSTRAINT "schedule_state_one_row" CHECK("schedule_state"."id" = 1)
);
