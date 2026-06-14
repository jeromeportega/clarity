import { DEFAULT_RECEIPT_CONFIG, type ReceiptConfig } from './config';
import type { SkuDictionary } from './dictionary/sku-dictionary';
import { imageHash } from './image-hash';
import { reconcile } from './reconcile';
import type { Resolution, SkuResolver } from './resolver/sku-resolver';
import type {
  NewReceiptItem,
  ReceiptItemRecord,
  ReceiptRecord,
  ReceiptStore,
} from './store/receipt-store';
import type { ReceiptImageInput, VisionProvider } from './vision/vision-provider';

// =============================================================================
// The single public entry point (epic contract §5).
//
// `processReceipt` accepts image bytes and returns a structured record plus
// resolved line items, wiring the seams in order:
//   imageHash → idempotency check → vision.extract → per-item resolver.resolve
//   → reconcile → review flagging → store writes.
//
// The CALLER constructs `deps` — the core never builds an Anthropic client
// (NFR-1, G-3). `npm test` wires recorded/stub seams; `vision:eval` wires the
// live providers. Every amount stays integer cents until the storage boundary.
// =============================================================================

export interface ReceiptPipelineDeps {
  // Live OR recorded — chosen by the caller, never by the core.
  vision: VisionProvider;
  resolver: SkuResolver;
  // Part of the seam bundle per the contract. The dictionary-first lookup and
  // auto write-back live INSIDE the resolver (story-002-004); the pipeline does
  // not touch the dictionary directly — the caller wires it into the resolver.
  dictionary: SkuDictionary;
  store: ReceiptStore;
  // Reserved by the contract for deterministic timestamps. Row `createdAt` and
  // dictionary `updatedAt` are stamped by the injected store / resolver from
  // their own clocks, so the pipeline itself does not read this.
  clock?: () => number;
  // Receipt-context columns H1 requires on every row (`receipts.household_id`,
  // `receipts.source`) that the image input does not carry. Optional with
  // defaults so offline tests need not specify them; a real caller injects the
  // authenticated household. `householdId` is H1's text UUID FK.
  householdId?: string;
  source?: string;
}

export interface ProcessReceiptResult {
  receipt: ReceiptRecord;
  items: ReceiptItemRecord[]; // [] when unreadable (FR-6) or on an idempotent hit
  status: 'ok' | 'needs_review';
  idempotent: boolean; // true => identical photo already processed (FR-2)
}

const DEFAULT_HOUSEHOLD_ID = 'default-household';
const DEFAULT_SOURCE = 'photo';

export async function processReceipt(
  input: ReceiptImageInput,
  deps: ReceiptPipelineDeps,
  config?: Partial<ReceiptConfig>,
): Promise<ProcessReceiptResult> {
  const cfg: ReceiptConfig = { ...DEFAULT_RECEIPT_CONFIG, ...config };
  const householdId = deps.householdId ?? DEFAULT_HOUSEHOLD_ID;
  const source = deps.source ?? DEFAULT_SOURCE;

  const hash = imageHash(input.bytes);

  // Idempotency (FR-2): an identical photo is a no-op that links the existing
  // record. Keyed on the SHA-256 of the raw bytes, so a re-upload performs ZERO
  // new writes.
  const existing = await deps.store.findReceiptByImageHash(hash);
  if (existing) {
    return {
      receipt: existing,
      items: [],
      status: existing.needsReview ? 'needs_review' : 'ok',
      idempotent: true,
    };
  }

  const extracted = await deps.vision.extract(input);

  // Unreadable / refusal (FR-6): persist a zero-item record flagged
  // needs_review; never fabricate items.
  if (!extracted.readable) {
    const receipt = await deps.store.insertReceipt({
      householdId,
      source,
      store: null,
      purchasedAt: null,
      subtotalCents: null,
      taxCents: null,
      totalCents: null,
      paymentLast4: null,
      imageHash: hash,
      needsReview: true,
    });
    return { receipt, items: [], status: 'needs_review', idempotent: false };
  }

  // Resolution — exactly one resolve() per line item, in extraction order.
  const categories = await deps.store.listCategories();
  const storeName = extracted.store ?? '';
  const resolutions: Resolution[] = [];
  for (const li of extracted.lineItems) {
    resolutions.push(
      await deps.resolver.resolve({
        store: storeName,
        sku: li.sku,
        description: li.rawDescription,
        categories,
      }),
    );
  }

  // Reconciliation (FR-15) over integer cents.
  const recon = reconcile(extracted, cfg.arithmeticToleranceCents);

  // Per-item review flag (FR-14): an item is flagged when its weakest axis
  // (name or category) falls below the confidence threshold.
  const itemNeedsReview = resolutions.map(
    (r) => Math.min(r.nameConfidence, r.categoryConfidence) < cfg.confidenceThreshold,
  );

  // Whole-receipt review: an arithmetic mismatch (FR-15) OR any below-threshold
  // item (FR-14) flags the entire receipt.
  const needsReview = !recon.ok || itemNeedsReview.some(Boolean);

  // Merchandise subtotal (pre-tax, pre-fee), in cents.
  const subtotalCents = extracted.lineItems.reduce(
    (acc, li) => acc + li.linePrice - li.discount,
    0,
  );

  const receipt = await deps.store.insertReceipt({
    householdId,
    source,
    store: extracted.store,
    purchasedAt: extracted.purchasedAt,
    subtotalCents,
    taxCents: extracted.tax,
    totalCents: extracted.total,
    paymentLast4: extracted.paymentHint?.last4 ?? null,
    imageHash: hash,
    needsReview,
  });

  const newItems: NewReceiptItem[] = extracted.lineItems.map((li, i) => {
    const res = resolutions[i]!;
    return {
      receiptId: receipt.id,
      lineNo: i + 1,
      sku: li.sku,
      rawDescription: li.rawDescription,
      canonicalName: res.canonicalName,
      categoryId: res.category,
      quantity: li.quantity,
      unitPriceCents: li.unitPrice,
      linePriceCents: li.linePrice,
      discountCents: li.discount,
      nameConfidence: res.nameConfidence,
      categoryConfidence: res.categoryConfidence,
      refundDestination: null,
      needsReview: itemNeedsReview[i] ?? false,
    };
  });

  const items =
    newItems.length > 0 ? await deps.store.insertReceiptItems(newItems) : [];

  return {
    receipt,
    items,
    status: needsReview ? 'needs_review' : 'ok',
    idempotent: false,
  };
}
