import type { LedgerEvent, ReconciledLedger } from '../reconcile/model';
import type { Correction, Rollup } from './model';

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7); // YYYY-MM-DD → YYYY-MM
}

function primaryCategory(event: LedgerEvent): string {
  if (event.mergedItems.length > 0) {
    return event.mergedItems[0].category;
  }
  return event.categoryFallback ?? 'uncategorized';
}

function transactionIdOf(event: LedgerEvent): string | undefined {
  if (event.fundedBy === 'bank') return event.sources.transactionId;
  if (event.fundedBy === 'split') return event.sources.transactionId;
  return event.sources.transactionId; // optional for store_credit
}

// Updates transactionId in sources, preserving the discriminated union via type assertion.
// Safe: fundedBy discriminant is unchanged; only transactionId inside sources is overwritten.
function withTransactionId(event: LedgerEvent, txId: string | undefined): LedgerEvent {
  if (event.fundedBy === 'bank') {
    return { ...event, sources: { ...event.sources, transactionId: txId as string } };
  }
  if (event.fundedBy === 'split') {
    return { ...event, sources: { ...event.sources, transactionId: txId as string } };
  }
  // store_credit: transactionId is optional
  return { ...event, sources: { ...event.sources, transactionId: txId } } as LedgerEvent;
}

// ── rollupNetSpend ────────────────────────────────────────────────────────────

/**
 * Produce net-spend rollup cells keyed by (category, month YYYY-MM).
 * Sums `signedSpendCents` so purchases offset refunds within each cell (FR-11, FR-9).
 */
export function rollupNetSpend(ledger: ReconciledLedger): Rollup {
  type CellAccum = { category: string; month: string; netSpendCents: number; eventIds: string[] };
  const cellMap = new Map<string, CellAccum>();

  for (const event of ledger.events) {
    const category = primaryCategory(event);
    const month = monthOf(event.occurredOn);
    const key = `${category}\0${month}`;

    const cell = cellMap.get(key);
    if (cell) {
      cell.netSpendCents += event.signedSpendCents;
      cell.eventIds.push(event.id);
    } else {
      cellMap.set(key, {
        category,
        month,
        netSpendCents: event.signedSpendCents,
        eventIds: [event.id],
      });
    }
  }

  return Array.from(cellMap.values());
}

// ── applyCorrections ──────────────────────────────────────────────────────────

/**
 * Pure transform: returns a new `ReconciledLedger` with the given corrections applied.
 * Does NOT mutate the input (ADR-008).
 */
export function applyCorrections(
  ledger: ReconciledLedger,
  corrections: Correction[],
): ReconciledLedger {
  return corrections.reduce<ReconciledLedger>(applyOne, ledger);
}

function applyOne(ledger: ReconciledLedger, correction: Correction): ReconciledLedger {
  switch (correction.kind) {
    case 'reclassify_item':
      return applyReclassify(ledger, correction);
    case 'reject_match':
      return applyReject(ledger, correction);
    case 'relink_match':
      return applyRelink(ledger, correction);
  }
}

// ── reclassify_item ───────────────────────────────────────────────────────────

function applyReclassify(
  ledger: ReconciledLedger,
  correction: Extract<Correction, { kind: 'reclassify_item' }>,
): ReconciledLedger {
  const { itemRef: corrRef, newCategory } = correction;

  return {
    ...ledger,
    events: ledger.events.map(
      (event): LedgerEvent => ({
        ...event,
        mergedItems: event.mergedItems.map((item) => {
          const matchesReceipt =
            corrRef.receiptItemId !== undefined &&
            item.itemRef.receiptItemId === corrRef.receiptItemId;
          const matchesOrder =
            corrRef.orderItemId !== undefined &&
            item.itemRef.orderItemId === corrRef.orderItemId;
          // At least one key from corrRef must match; all provided keys must match.
          const anyProvided = corrRef.receiptItemId !== undefined || corrRef.orderItemId !== undefined;
          const allProvidedMatch =
            (corrRef.receiptItemId === undefined || matchesReceipt) &&
            (corrRef.orderItemId === undefined || matchesOrder);
          if (anyProvided && allProvidedMatch) {
            return { ...item, category: newCategory };
          }
          return item;
        }),
      }) as LedgerEvent,
    ),
  };
}

// ── reject_match ──────────────────────────────────────────────────────────────

function applyReject(
  ledger: ReconciledLedger,
  correction: Extract<Correction, { kind: 'reject_match' }>,
): ReconciledLedger {
  const match =
    ledger.matches.find((m) => m.id === correction.matchId) ??
    ledger.reviewQueue.find((m) => m.id === correction.matchId);
  if (!match) return ledger;

  const txId = match.transactionId;
  const removedIds = new Set(
    txId ? ledger.events.filter((e) => transactionIdOf(e) === txId).map((e) => e.id) : [],
  );

  const newEvents = ledger.events.filter((e) => !removedIds.has(e.id));
  return {
    ...ledger,
    matches: ledger.matches.filter((m) => m.id !== correction.matchId),
    reviewQueue: ledger.reviewQueue.filter((m) => m.id !== correction.matchId),
    events: newEvents,
    netSpendCents: newEvents.reduce((sum, e) => sum + e.signedSpendCents, 0),
  };
}

// ── relink_match ──────────────────────────────────────────────────────────────

/**
 * Re-anchors a match to a different bank transaction.
 *
 * When both the old and new transactions already have events in the ledger,
 * the two events swap their `transactionId` and `occurredOn` (so each event
 * remains correctly dated for its new anchor).  When only the anchored event
 * exists, its sources are updated in place without a date change.
 */
function applyRelink(
  ledger: ReconciledLedger,
  correction: Extract<Correction, { kind: 'relink_match' }>,
): ReconciledLedger {
  const { matchId, newTransactionId } = correction;

  const matchInMatches = ledger.matches.find((m) => m.id === matchId);
  const matchInReview = matchInMatches == null ? ledger.reviewQueue.find((m) => m.id === matchId) : null;
  const match = matchInMatches ?? matchInReview;
  if (!match) return ledger;

  const oldTxId = match.transactionId;
  const anchoredEvent = ledger.events.find((e) => transactionIdOf(e) === oldTxId);
  const targetEvent = ledger.events.find((e) => transactionIdOf(e) === newTransactionId);

  let newEvents: LedgerEvent[];
  if (anchoredEvent && targetEvent) {
    // Swap transactions and dates between the two events so each keeps its own amount
    // but is now correctly associated with the other bank line.
    const relinkAnchor: LedgerEvent = {
      ...withTransactionId(anchoredEvent, newTransactionId),
      occurredOn: targetEvent.occurredOn,
    } as LedgerEvent;
    const relinkTarget: LedgerEvent = {
      ...withTransactionId(targetEvent, oldTxId),
      occurredOn: anchoredEvent.occurredOn,
    } as LedgerEvent;

    newEvents = ledger.events.map((e) => {
      if (e.id === anchoredEvent.id) return relinkAnchor;
      if (e.id === targetEvent.id) return relinkTarget;
      return e;
    });
  } else if (anchoredEvent) {
    // No target event — just update sources, leave date unchanged.
    const updated = withTransactionId(anchoredEvent, newTransactionId);
    newEvents = ledger.events.map((e) => (e.id === anchoredEvent.id ? updated : e));
  } else {
    newEvents = ledger.events;
  }

  const updatedMatch = { ...match, transactionId: newTransactionId };
  return {
    ...ledger,
    events: newEvents,
    matches: matchInMatches
      ? ledger.matches.map((m) => (m.id === matchId ? updatedMatch : m))
      : ledger.matches,
    reviewQueue: matchInReview
      ? ledger.reviewQueue.map((m) => (m.id === matchId ? updatedMatch : m))
      : ledger.reviewQueue,
  };
}
