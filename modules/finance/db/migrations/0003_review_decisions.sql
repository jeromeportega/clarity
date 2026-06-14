CREATE TABLE `review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`decision` text NOT NULL,
	`payload_json` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_review_decisions_item` ON `review_decisions` (`household_id`,`item_type`,`item_id`);--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `bbox` text;