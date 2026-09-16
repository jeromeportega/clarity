import { z } from 'zod';

import type { ExtractedReceipt } from './vision-provider';

/**
 * What the vision model's `record_receipt` tool call must look like before a
 * single field of it is trusted. The JSON Schema in `system-prompt.ts` tells
 * the model the shape; this Zod schema checks what actually came back, so a
 * float where integer cents belong, a string where a number belongs, or a
 * missing field turns the call into an invalid one (→ unreadable receipt)
 * instead of flowing into the money path. `extraction-schema.test.ts` keeps
 * the two in step.
 *
 * Tolerances, deliberately: unknown keys are dropped rather than rejected, and
 * the two arrays default to empty when omitted — a sparse but honest answer is
 * still a receipt with zero items, never fabricated ones.
 */
const cents = z.number().int();

export const ExtractedReceiptSchema = z.object({
  readable: z.boolean(),
  store: z.string().nullable(),
  purchasedAt: z.string().nullable(),
  total: cents.nullable(),
  tax: cents.nullable(),
  fees: z
    .array(
      z.object({
        kind: z.enum(['crv', 'bag', 'bottle', 'other']),
        label: z.string(),
        amount: cents,
      }),
    )
    .default([]),
  paymentHint: z
    .object({
      method: z.string().nullable(),
      last4: z.string().nullable(),
    })
    .nullable(),
  lineItems: z
    .array(
      z.object({
        sku: z.string().nullable(),
        rawDescription: z.string(),
        quantity: z.number(),
        unitPrice: cents.nullable(),
        linePrice: cents,
        discount: cents.min(0),
      }),
    )
    .default([]),
});

// The schema's output and the domain type must be the same shape, both ways.
type Parsed = z.infer<typeof ExtractedReceiptSchema>;
type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : never) : never;
const _extractedReceiptMatchesSchema: MutuallyAssignable<Parsed, ExtractedReceipt> = true;
void _extractedReceiptMatchesSchema;

/** A `validate` for `jsonSchema()` from `ai`: the SDK marks a failing call `invalid`. */
export function validateExtraction(value: unknown): { success: true; value: ExtractedReceipt } | { success: false; error: Error } {
  const result = ExtractedReceiptSchema.safeParse(value);
  return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
}
