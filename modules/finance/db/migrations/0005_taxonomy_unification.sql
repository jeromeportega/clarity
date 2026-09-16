-- One category taxonomy with stable slug ids (see db/taxonomy.ts).
--
-- Before this migration two taxonomies coexisted: the seed inserted 10
-- lowercase names under random-uuid ids, and the reconciliation sink inserted
-- 20 Title-Case names under random-uuid ids. `categories.name` is unique, so
-- the slug rows are inserted only after the legacy rows are renamed out of
-- the way; every reference is re-pointed to its slug row; the legacy rows are
-- then removed.
UPDATE `categories` SET `name` = `name` || ' (legacy)'
WHERE `id` NOT IN (
  'groceries','household','dining','entertainment','subscriptions','shopping','health-medical','travel',
  'transportation','utilities','housing','education','personal-care','electronics','clothing','books-media',
  'pet-care','home-improvement','insurance','transfers','other'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`id`, `name`) VALUES
  ('groceries', 'Groceries'),
  ('household', 'Household'),
  ('dining', 'Dining'),
  ('entertainment', 'Entertainment'),
  ('subscriptions', 'Subscriptions'),
  ('shopping', 'Shopping'),
  ('health-medical', 'Health & Medical'),
  ('travel', 'Travel'),
  ('transportation', 'Transportation'),
  ('utilities', 'Utilities'),
  ('housing', 'Housing'),
  ('education', 'Education'),
  ('personal-care', 'Personal Care'),
  ('electronics', 'Electronics'),
  ('clothing', 'Clothing'),
  ('books-media', 'Books & Media'),
  ('pet-care', 'Pet Care'),
  ('home-improvement', 'Home Improvement'),
  ('insurance', 'Insurance'),
  ('transfers', 'Transfers'),
  ('other', 'Other');
--> statement-breakpoint
UPDATE `receipt_items` SET `category_id` = (
  SELECT CASE lower(replace(c.`name`, ' (legacy)', ''))
    WHEN 'groceries' THEN 'groceries'
    WHEN 'household' THEN 'household'
    WHEN 'electronics' THEN 'electronics'
    WHEN 'clothing' THEN 'clothing'
    WHEN 'utilities' THEN 'utilities'
    WHEN 'mortgage_rent' THEN 'housing'
    WHEN 'subscriptions' THEN 'subscriptions'
    WHEN 'dining' THEN 'dining'
    WHEN 'transport' THEN 'transportation'
    WHEN 'transportation' THEN 'transportation'
    WHEN 'entertainment' THEN 'entertainment'
    WHEN 'shopping' THEN 'shopping'
    WHEN 'health & medical' THEN 'health-medical'
    WHEN 'travel' THEN 'travel'
    WHEN 'housing' THEN 'housing'
    WHEN 'education' THEN 'education'
    WHEN 'personal care' THEN 'personal-care'
    WHEN 'books & media' THEN 'books-media'
    WHEN 'pet care' THEN 'pet-care'
    WHEN 'home improvement' THEN 'home-improvement'
    WHEN 'insurance' THEN 'insurance'
    WHEN 'transfers' THEN 'transfers'
    ELSE 'other'
  END
  FROM `categories` c WHERE c.`id` = `receipt_items`.`category_id`
)
WHERE `category_id` IN (SELECT `id` FROM `categories` WHERE `name` LIKE '% (legacy)');
--> statement-breakpoint
UPDATE `sku_dictionary` SET `category` = CASE lower(`category`)
    WHEN 'groceries' THEN 'groceries'
    WHEN 'household' THEN 'household'
    WHEN 'electronics' THEN 'electronics'
    WHEN 'clothing' THEN 'clothing'
    WHEN 'utilities' THEN 'utilities'
    WHEN 'mortgage_rent' THEN 'housing'
    WHEN 'subscriptions' THEN 'subscriptions'
    WHEN 'dining' THEN 'dining'
    WHEN 'transport' THEN 'transportation'
    WHEN 'transportation' THEN 'transportation'
    WHEN 'entertainment' THEN 'entertainment'
    WHEN 'shopping' THEN 'shopping'
    WHEN 'health & medical' THEN 'health-medical'
    WHEN 'health-medical' THEN 'health-medical'
    WHEN 'travel' THEN 'travel'
    WHEN 'housing' THEN 'housing'
    WHEN 'education' THEN 'education'
    WHEN 'personal care' THEN 'personal-care'
    WHEN 'personal-care' THEN 'personal-care'
    WHEN 'books & media' THEN 'books-media'
    WHEN 'books-media' THEN 'books-media'
    WHEN 'pet care' THEN 'pet-care'
    WHEN 'pet-care' THEN 'pet-care'
    WHEN 'home improvement' THEN 'home-improvement'
    WHEN 'home-improvement' THEN 'home-improvement'
    WHEN 'insurance' THEN 'insurance'
    WHEN 'transfers' THEN 'transfers'
    ELSE 'other'
  END
WHERE `category` NOT IN (
  'groceries','household','dining','entertainment','subscriptions','shopping','health-medical','travel',
  'transportation','utilities','housing','education','personal-care','electronics','clothing','books-media',
  'pet-care','home-improvement','insurance','transfers','other'
);
--> statement-breakpoint
DELETE FROM `categories` WHERE `name` LIKE '% (legacy)';
