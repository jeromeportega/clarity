'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { QueueItem } from '../../../../../modules/finance/core/queue/types';
import type { CorrectionVariant } from '../../../../../modules/finance/core/corrections/apply';

// ---------------------------------------------------------------------------
// Three correction modes the user can choose
// ---------------------------------------------------------------------------

type CorrectionMode = 'pickCategoryId' | 'pickMatchCandidateId' | 'editResolution';

interface CorrectionDialogProps {
  item: QueueItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (correction: CorrectionVariant) => void;
}

const CATEGORY_OPTIONS = [
  'groceries',
  'household',
  'electronics',
  'clothing',
  'utilities',
  'mortgage_rent',
  'subscriptions',
  'dining',
  'transport',
  'other',
] as const;

export function CorrectionDialog({ item, open, onOpenChange, onSubmit }: CorrectionDialogProps) {
  const [mode, setMode] = React.useState<CorrectionMode>('editResolution');

  // Pick-category state
  const [categoryId, setCategoryId] = React.useState('');

  // Pick-match state
  const [candidateId, setCandidateId] = React.useState('');

  // Edit-resolution state
  const [store, setStore] = React.useState('');
  const [skuOrAbbrev, setSkuOrAbbrev] = React.useState('');
  const [canonicalName, setCanonicalName] = React.useState('');
  const [category, setCategory] = React.useState('groceries');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    let correction: CorrectionVariant;

    if (mode === 'pickCategoryId') {
      correction = { variant: 'pickCategoryId', categoryId };
    } else if (mode === 'pickMatchCandidateId') {
      correction = { variant: 'pickMatchCandidateId', candidateId };
    } else {
      correction = { variant: 'editResolution', store, skuOrAbbrev, canonicalName, category };
    }

    onSubmit(correction);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Correct item</DialogTitle>
        </DialogHeader>

        {/* Mode selector */}
        <div role="group" aria-label="Correction mode" className="flex gap-2 flex-wrap">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'editResolution'}
            aria-label="Edit resolution"
            onClick={() => setMode('editResolution')}
            className={`rounded px-3 py-1 text-sm border ${mode === 'editResolution' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
          >
            Edit resolution
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'pickCategoryId'}
            aria-label="Pick category"
            onClick={() => setMode('pickCategoryId')}
            className={`rounded px-3 py-1 text-sm border ${mode === 'pickCategoryId' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
          >
            Pick category
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'pickMatchCandidateId'}
            aria-label="Pick match candidate"
            onClick={() => setMode('pickMatchCandidateId')}
            className={`rounded px-3 py-1 text-sm border ${mode === 'pickMatchCandidateId' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
          >
            Pick match
          </button>
        </div>

        {/* Context */}
        <p className="text-sm text-muted-foreground">{item.reason}</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {mode === 'pickCategoryId' && (
            <div className="flex flex-col gap-1">
              <label htmlFor="categoryId" className="text-sm font-medium">Category</label>
              <select
                id="categoryId"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                required
                className="rounded border p-2 text-sm"
              >
                <option value="">— select —</option>
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          )}

          {mode === 'pickMatchCandidateId' && (
            <div className="flex flex-col gap-1">
              <label htmlFor="candidateId" className="text-sm font-medium">Match candidate ID</label>
              <input
                id="candidateId"
                type="text"
                value={candidateId}
                onChange={(e) => setCandidateId(e.target.value)}
                required
                placeholder="match-…"
                className="rounded border p-2 text-sm"
              />
            </div>
          )}

          {mode === 'editResolution' && (
            <>
              <div className="flex flex-col gap-1">
                <label htmlFor="store" className="text-sm font-medium">Store</label>
                <input
                  id="store"
                  type="text"
                  value={store}
                  onChange={(e) => setStore(e.target.value)}
                  required
                  placeholder="COSTCO"
                  className="rounded border p-2 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="skuOrAbbrev" className="text-sm font-medium">SKU / abbreviation</label>
                <input
                  id="skuOrAbbrev"
                  type="text"
                  value={skuOrAbbrev}
                  onChange={(e) => setSkuOrAbbrev(e.target.value)}
                  required
                  placeholder="KS-EVOO"
                  className="rounded border p-2 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="canonicalName" className="text-sm font-medium">Canonical name</label>
                <input
                  id="canonicalName"
                  type="text"
                  value={canonicalName}
                  onChange={(e) => setCanonicalName(e.target.value)}
                  required
                  placeholder="Kirkland Organic Olive Oil"
                  className="rounded border p-2 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="category" className="text-sm font-medium">Category</label>
                <select
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  required
                  className="rounded border p-2 text-sm"
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Apply correction</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
