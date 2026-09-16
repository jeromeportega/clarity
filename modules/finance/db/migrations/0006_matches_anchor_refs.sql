ALTER TABLE `matches` ADD `receipt_id` text REFERENCES receipts(id);--> statement-breakpoint
ALTER TABLE `matches` ADD `order_id` text REFERENCES orders(id);--> statement-breakpoint
UPDATE `matches` SET `receipt_id` = (SELECT `receipt_id` FROM `receipt_items` WHERE `receipt_items`.`id` = `matches`.`receipt_item_id`) WHERE `receipt_item_id` IS NOT NULL;--> statement-breakpoint
UPDATE `matches` SET `order_id` = (SELECT `order_id` FROM `order_items` WHERE `order_items`.`id` = `matches`.`order_item_id`) WHERE `order_item_id` IS NOT NULL;
