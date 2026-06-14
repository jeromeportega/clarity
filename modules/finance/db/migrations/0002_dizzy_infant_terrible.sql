ALTER TABLE `matches` ADD `rationale` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `store_credit_balance_id` text REFERENCES store_credit_balances(id) ON DELETE SET NULL;