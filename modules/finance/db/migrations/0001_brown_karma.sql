CREATE TABLE `sku_dictionary` (
	`store` text NOT NULL,
	`sku_or_abbrev` text NOT NULL,
	`canonical_name` text NOT NULL,
	`category` text NOT NULL,
	`name_confidence` real NOT NULL,
	`category_confidence` real NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`store`, `sku_or_abbrev`)
);
