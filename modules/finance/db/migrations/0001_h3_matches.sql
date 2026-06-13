-- H3 additive columns on the matches table (ADR-006: additive only, never rename/drop).
-- FR-3: rationale explains why the engine linked these records.
-- FR-7: store_credit_balance_id links a store-credit refund to its ledger row.
ALTER TABLE matches ADD COLUMN rationale TEXT;
--> statement-breakpoint
ALTER TABLE matches ADD COLUMN store_credit_balance_id TEXT REFERENCES store_credit_balances(id) ON DELETE SET NULL;
