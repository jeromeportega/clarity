PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sku_dictionary` (
	`household_id` text NOT NULL,
	`store` text NOT NULL,
	`sku_or_abbrev` text NOT NULL,
	`canonical_name` text NOT NULL,
	`category` text NOT NULL,
	`name_confidence` real NOT NULL,
	`category_confidence` real NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`household_id`, `store`, `sku_or_abbrev`)
);
--> statement-breakpoint
INSERT INTO `__new_sku_dictionary`("household_id", "store", "sku_or_abbrev", "canonical_name", "category", "name_confidence", "category_confidence", "source", "updated_at") SELECT 'demo-household-00000000-0000-0000-0000-000000000001', "store", "sku_or_abbrev", "canonical_name", "category", "name_confidence", "category_confidence", "source", "updated_at" FROM `sku_dictionary`;--> statement-breakpoint
DROP TABLE `sku_dictionary`;--> statement-breakpoint
ALTER TABLE `__new_sku_dictionary` RENAME TO `sku_dictionary`;--> statement-breakpoint
PRAGMA foreign_keys=ON;