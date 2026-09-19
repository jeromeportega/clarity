-- The queue's "unmatched transaction" item became "missing receipt": the same
-- bank line, now asked about only when a receipt would add an item breakdown.
-- A person's earlier "stop asking" decisions on those lines must keep working,
-- so the anti-join key follows the rename. Data only; no schema change.
--
-- APPLY BEFORE DEPLOYING THE CODE that writes `missing_receipt`. OR IGNORE:
-- should a `missing_receipt` row already exist for the same (household, item),
-- the stale `unmatched_txn` row is left in place — nothing reads that type any
-- more — rather than failing the whole migration run on the unique index.
UPDATE OR IGNORE `review_decisions` SET `item_type` = 'missing_receipt' WHERE `item_type` = 'unmatched_txn';
