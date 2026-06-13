/**
 * Synthetic Amazon "Request My Data" → Order History CSV fixtures.
 *
 * These are AUTHORED test data — never real exports (operator privacy rule). The
 * header is the verbatim real-world header so the parser is exercised against the
 * true column layout, including the quoted PII columns we must ignore.
 *
 * PII columns (Billing Address, Shipping Address, Gift*, Item Serial Number,
 * Purchase Order Number, Carrier Name & Tracking Number) are deliberately filled
 * with comma-bearing junk so a test can prove they (a) parse correctly through the
 * CSV quoting and (b) never reach the normalized model.
 */

/** The verbatim header from a real Amazon Order History export. */
export const AMAZON_HEADER =
  'ASIN,"Billing Address","Carrier Name & Tracking Number",Currency,"Gift Message","Gift Recipient Contact","Gift Sender Name","Item Serial Number","Order Date","Order ID","Order Status","Original Quantity","Payment Method Type","Product Condition","Product Name","Purchase Order Number","Ship Date","Shipment Item Subtotal","Shipment Item Subtotal Tax","Shipment Status","Shipping Address","Shipping Charge","Shipping Option","Total Amount","Total Discounts","Unit Price","Unit Price Tax",Website';

/** Column order, matching {@link AMAZON_HEADER} exactly. */
const COLUMNS = [
  'ASIN',
  'Billing Address',
  'Carrier Name & Tracking Number',
  'Currency',
  'Gift Message',
  'Gift Recipient Contact',
  'Gift Sender Name',
  'Item Serial Number',
  'Order Date',
  'Order ID',
  'Order Status',
  'Original Quantity',
  'Payment Method Type',
  'Product Condition',
  'Product Name',
  'Purchase Order Number',
  'Ship Date',
  'Shipment Item Subtotal',
  'Shipment Item Subtotal Tax',
  'Shipment Status',
  'Shipping Address',
  'Shipping Charge',
  'Shipping Option',
  'Total Amount',
  'Total Discounts',
  'Unit Price',
  'Unit Price Tax',
  'Website',
] as const;

type Column = (typeof COLUMNS)[number];
type Row = Partial<Record<Column, string>>;

/** Junk PII filler containing commas — proves CSV quoting and that we ignore it. */
const PII = {
  'Billing Address': '1 Main St, Apt 4, Springfield, IL',
  'Carrier Name & Tracking Number': 'UPS, 1Z999AA10123456784',
  'Gift Message': 'Happy birthday, friend!',
  'Gift Recipient Contact': 'Pat Doe, 555-0100',
  'Gift Sender Name': 'Sam, Q.',
  'Item Serial Number': 'SN-001, rev-2',
  'Purchase Order Number': 'PO-42, internal',
  'Shipping Address': '500 Oak Ave, Suite 9, Portland, OR',
} satisfies Partial<Record<Column, string>>;

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Build one CSV line, defaulting PII columns to comma-bearing junk. */
export function buildRow(row: Row): string {
  const merged: Row = { Website: 'Amazon.com', Currency: 'USD', ...PII, ...row };
  return COLUMNS.map((col) => csvEscape(merged[col] ?? '')).join(',');
}

/** Build a full CSV document (header + rows). */
export function buildCsv(rows: Row[]): string {
  return [AMAZON_HEADER, ...rows.map(buildRow)].join('\r\n') + '\r\n';
}

/**
 * The canonical multi-order fixture used by the extraction + idempotency tests:
 *   - 111-SINGLE  : one shipment, two items (purchase).
 *   - 222-SPLIT   : one order shipped in THREE parcels (the H3 "one order → many
 *                   bank charges" beat).
 *   - 333-RETURN  : two purchases + one return refunded to a card (no ledger row);
 *                   nets below the gross — the WHERE amount>0 trap.
 *   - 444-GIFTCARD: a purchase + a return refunded to a GIFT CARD (one accrual row).
 */
export const FULL_CSV = buildCsv([
  // 111-SINGLE — single shipment, two items.
  {
    ASIN: 'B0SINGLE01',
    'Order ID': '111-SINGLE',
    'Order Date': '2026-01-05',
    'Ship Date': '2026-01-07',
    'Order Status': 'Closed',
    'Shipment Status': 'Shipped',
    'Payment Method Type': 'Visa - 1234',
    'Product Name': 'USB-C Cable, 2-pack',
    'Original Quantity': '1',
    'Unit Price': '12.99',
    'Unit Price Tax': '1.00',
    'Shipment Item Subtotal': '12.99',
    'Shipment Item Subtotal Tax': '1.00',
    'Total Amount': '13.99',
    'Total Discounts': '0.00',
  },
  {
    ASIN: 'B0SINGLE02',
    'Order ID': '111-SINGLE',
    'Order Date': '2026-01-05',
    'Ship Date': '2026-01-07',
    'Order Status': 'Closed',
    'Shipment Status': 'Shipped',
    'Payment Method Type': 'Visa - 1234',
    'Product Name': 'Phone Stand',
    'Original Quantity': '1',
    'Unit Price': '9.99',
    'Unit Price Tax': '0.50',
    'Shipment Item Subtotal': '9.99',
    'Shipment Item Subtotal Tax': '0.50',
    'Total Amount': '10.49',
    'Total Discounts': '0.00',
  },

  // 222-SPLIT — three shipments (three distinct ship dates), one item each.
  {
    ASIN: 'B0SPLIT001',
    'Order ID': '222-SPLIT',
    'Order Date': '2026-02-01',
    'Ship Date': '2026-02-03',
    'Order Status': 'Closed',
    'Shipment Status': 'Shipped',
    'Payment Method Type': 'Mastercard - 5678',
    'Product Name': 'Novel A',
    'Original Quantity': '1',
    'Unit Price': '15.00',
    'Shipment Item Subtotal': '15.00',
    'Total Amount': '15.99',
  },
  {
    ASIN: 'B0SPLIT002',
    'Order ID': '222-SPLIT',
    'Order Date': '2026-02-01',
    'Ship Date': '2026-02-05',
    'Order Status': 'Closed',
    'Shipment Status': 'Shipped',
    'Payment Method Type': 'Mastercard - 5678',
    'Product Name': 'Novel B',
    'Original Quantity': '1',
    'Unit Price': '20.00',
    'Shipment Item Subtotal': '20.00',
    'Total Amount': '21.30',
  },
  {
    ASIN: 'B0SPLIT003',
    'Order ID': '222-SPLIT',
    'Order Date': '2026-02-01',
    'Ship Date': '2026-02-08',
    'Order Status': 'Closed',
    'Shipment Status': 'Shipped',
    'Payment Method Type': 'Mastercard - 5678',
    'Product Name': 'Novel C',
    'Original Quantity': '1',
    'Unit Price': '8.00',
    'Shipment Item Subtotal': '8.00',
    'Total Amount': '8.50',
  },

  // 333-RETURN — two purchases + one card refund (net < gross; no ledger row).
  {
    ASIN: 'B0RETURN01',
    'Order ID': '333-RETURN',
    'Order Date': '2026-03-01',
    'Ship Date': '2026-03-02',
    'Order Status': 'Closed',
    'Shipment Status': 'Shipped',
    'Payment Method Type': 'Visa - 1234',
    'Product Name': 'Wireless Mouse',
    'Original Quantity': '1',
    'Unit Price': '30.00',
    'Shipment Item Subtotal': '30.00',
    'Total Amount': '30.00',
  },
  {
    ASIN: 'B0RETURN02',
    'Order ID': '333-RETURN',
    'Order Date': '2026-03-01',
    'Ship Date': '2026-03-02',
    'Order Status': 'Closed',
    'Shipment Status': 'Shipped',
    'Payment Method Type': 'Visa - 1234',
    'Product Name': 'Mechanical Keyboard',
    'Original Quantity': '1',
    'Unit Price': '20.00',
    'Shipment Item Subtotal': '20.00',
    'Total Amount': '20.00',
  },
  {
    ASIN: 'B0RETURN02',
    'Order ID': '333-RETURN',
    'Order Date': '2026-03-01',
    'Ship Date': '2026-03-02',
    'Order Status': 'Returned',
    'Shipment Status': 'Returned',
    'Payment Method Type': 'Visa - 1234',
    'Product Name': 'Mechanical Keyboard',
    'Original Quantity': '1',
    'Unit Price': '-20.00',
    'Shipment Item Subtotal': '-20.00',
    'Total Amount': '-20.00',
  },

  // 444-GIFTCARD — purchase + gift-card refund (one positive accrual row).
  {
    ASIN: 'B0GIFTC001',
    'Order ID': '444-GIFTCARD',
    'Order Date': '2026-04-10',
    'Ship Date': '2026-04-11',
    'Order Status': 'Closed',
    'Shipment Status': 'Shipped',
    'Payment Method Type': 'Gift Card',
    'Product Name': 'eBook Reader Case',
    'Original Quantity': '1',
    'Unit Price': '24.00',
    'Shipment Item Subtotal': '24.00',
    'Total Amount': '24.00',
  },
  {
    ASIN: 'B0GIFTC001',
    'Order ID': '444-GIFTCARD',
    'Order Date': '2026-04-10',
    'Ship Date': '2026-04-11',
    'Order Status': 'Refunded',
    'Shipment Status': 'Returned',
    'Payment Method Type': 'Gift Card',
    'Product Name': 'eBook Reader Case',
    'Original Quantity': '1',
    'Unit Price': '-24.00',
    'Shipment Item Subtotal': '-24.00',
    'Total Amount': '-24.00',
  },
]);
