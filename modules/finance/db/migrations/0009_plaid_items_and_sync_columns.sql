CREATE TABLE `plaid_items` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`item_id` text NOT NULL,
	`access_token` text NOT NULL,
	`institution_id` text,
	`institution_name` text,
	`cursor` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_plaid_items_item_id` ON `plaid_items` (`item_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `plaid_item_id` text REFERENCES plaid_items(id);--> statement-breakpoint
ALTER TABLE `accounts` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `subtype` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `mask` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_accounts_plaid_external` ON `accounts` (`plaid_item_id`,`external_id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `pending_external_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `category_hint` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_transactions_external` ON `transactions` (`account_id`,`external_id`);