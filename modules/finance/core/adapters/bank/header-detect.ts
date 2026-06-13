/**
 * Header-row detection for bank exports. A statement is not guaranteed to start
 * with its column header — banks routinely emit preamble rows (account number,
 * statement period, blank spacers) above it. This scans the parsed cell matrix
 * for the first row that carries the columns we need and maps them by index, so
 * the adapter can ingest the same logic for CSV and Excel alike.
 */

export type Cell = string | number | boolean | null | undefined;

export interface BankColumnMap {
  date: number;
  amount: number;
  payee: number;
  address?: number;
  reference?: number;
}

export interface DetectedHeader {
  headerRowIndex: number;
  columns: BankColumnMap;
}

/** Lower-case and drop every non-alphanumeric char so `"Amount ($)"` ≡ `amount`. */
function canon(cell: Cell): string {
  return String(cell ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Canonicalized synonyms per logical column. Order within a list is irrelevant;
// the first matching cell index in a row wins for that column.
const SYNONYMS: Record<keyof BankColumnMap, string[]> = {
  date: ['posteddate', 'postdate', 'transactiondate', 'transdate', 'date'],
  amount: ['amount', 'transactionamount', 'amountusd', 'debitcredit'],
  payee: ['payee', 'description', 'merchant', 'name', 'memo'],
  address: ['address', 'location'],
  reference: ['referencenumber', 'reference', 'refno', 'referenceno', 'ref'],
};

function mapRow(row: Cell[]): BankColumnMap | null {
  const found: Partial<BankColumnMap> = {};
  for (let i = 0; i < row.length; i++) {
    const c = canon(row[i]);
    if (c.length === 0) continue;
    for (const key of Object.keys(SYNONYMS) as (keyof BankColumnMap)[]) {
      if (found[key] === undefined && SYNONYMS[key].includes(c)) {
        found[key] = i;
      }
    }
  }
  // A genuine header must locate the three load-bearing columns.
  if (found.date === undefined || found.amount === undefined || found.payee === undefined) {
    return null;
  }
  return found as BankColumnMap;
}

export function detectHeader(matrix: Cell[][]): DetectedHeader | null {
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;
    const columns = mapRow(row);
    if (columns) return { headerRowIndex: i, columns };
  }
  return null;
}
