CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text,
	`institution` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_categories_name` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`order_item_id` text,
	`receipt_item_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`confidence` real,
	`method` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_item_id`) REFERENCES `receipt_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`shipment_id` text NOT NULL,
	`item_seq` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_cents` integer,
	`amount_cents` integer NOT NULL,
	`is_return` integer DEFAULT false NOT NULL,
	`refund_destination` text,
	`source_row_hash` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_order_items_line` ON `order_items` (`order_id`,`shipment_id`,`item_seq`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`source` text NOT NULL,
	`external_order_id` text NOT NULL,
	`order_date` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`order_total_cents` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_orders_external` ON `orders` (`household_id`,`source`,`external_order_id`);--> statement-breakpoint
CREATE TABLE `receipt_items` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`sku` text,
	`raw_description` text NOT NULL,
	`canonical_name` text,
	`category_id` text,
	`quantity` real NOT NULL,
	`unit_price_cents` integer,
	`line_price_cents` integer NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`name_confidence` real,
	`category_confidence` real,
	`refund_destination` text,
	`needs_review` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`source` text NOT NULL,
	`store` text NOT NULL,
	`purchased_at` text NOT NULL,
	`subtotal_cents` integer,
	`tax_cents` integer,
	`total_cents` integer NOT NULL,
	`payment_last4` text,
	`image_hash` text,
	`needs_review` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `store_credit_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`order_item_id` text,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`posted_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`direction` text NOT NULL,
	`raw_merchant` text,
	`normalized_merchant` text NOT NULL,
	`source_row_hash` text NOT NULL,
	`dedup_key` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_transactions_dedup` ON `transactions` (`dedup_key`);