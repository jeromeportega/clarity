-- The queue's "unmatched transaction" item became "missing receipt": the same
-- bank line, now asked about only when a receipt would add an item breakdown.
-- A person's earlier "stop asking" decisions on those lines must keep working,
-- so the anti-join key follows the rename. Data only; no schema change.
UPDATE `review_decisions` SET `item_type` = 'missing_receipt' WHERE `item_type` = 'unmatched_txn';
