// All monetary values inside the receipts core are integer cents — never float.
// $234.17 -> 23417. Returns/refunds are signed (negative line prices).
export type Cents = number;
