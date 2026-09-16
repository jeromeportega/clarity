import { generateText, jsonSchema, tool, type LanguageModel } from 'ai';

import { normalizeSkuOrAbbrev, normalizeStore } from '../dictionary/normalize';
import type { SkuDictionary } from '../dictionary/sku-dictionary';
import type { Resolution, ResolutionQuery, SkuResolver } from './sku-resolver';

// Default for FR-12's auto write-back gate; passed as a plain number (not the
// ReceiptConfig object) to avoid a back-dependency on the pipeline entry point.
const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

export interface LlmSkuResolverDeps {
  // The persistent learning cache. Hit ⇒ no model call (FR-11).
  dictionary: SkuDictionary;
  // The generic LLM resolver — the default path on a dictionary miss (FR-9).
  // Injected so offline tests replay recorded outputs (RecordedSkuResolver) or
  // spy on call/no-call, and the eval harness wires the live Anthropic seam.
  llm: SkuResolver;
  // Auto write-back gate (FR-12). Default 0.80.
  confidenceThreshold?: number;
  // Stamp for dictionary write-backs; injected for deterministic tests.
  clock?: () => number;
}

// =============================================================================
// The dictionary-first SKU resolver (epic contract §8).
//
// Orchestrates the three-step algorithm: lookup the normalized key first and
// short-circuit on a hit (no model call); on a miss delegate to the generic LLM
// seam, clamp the category to the query's taxonomy, then append qualifying
// auto-resolutions back to the dictionary. The generic seam is injected, so the
// dictionary-first behavior and the write-back gate are fully testable offline.
// =============================================================================
export class LlmSkuResolver implements SkuResolver {
  private readonly dictionary: SkuDictionary;
  private readonly llm: SkuResolver;
  private readonly confidenceThreshold: number;
  private readonly clock: () => number;

  constructor(deps: LlmSkuResolverDeps) {
    this.dictionary = deps.dictionary;
    this.llm = deps.llm;
    this.confidenceThreshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.clock = deps.clock ?? Date.now;
  }

  async resolve(query: ResolutionQuery): Promise<Resolution> {
    const store = normalizeStore(query.store);
    const key = normalizeSkuOrAbbrev(query.sku ?? query.description);

    // Step 1 — dictionary-first. A hit returns immediately, no LLM call (FR-11).
    const hit = await this.dictionary.lookup(store, key);
    if (hit) {
      return {
        canonicalName: hit.canonicalName,
        category: hit.category,
        nameConfidence: hit.nameConfidence,
        categoryConfidence: hit.categoryConfidence,
        source: 'dictionary',
      };
    }

    // Step 2 — miss ⇒ the generic LLM resolver (default path, FR-9). Clamp the
    // returned category to the taxonomy: out-of-taxonomy ⇒ categoryConfidence 0
    // (ADR-008). We keep the model's category string but mark it untrusted
    // rather than inventing a different one.
    const raw = await this.llm.resolve(query);
    const inTaxonomy = query.categories.includes(raw.category);
    const resolution: Resolution = {
      canonicalName: raw.canonicalName,
      category: raw.category,
      nameConfidence: raw.nameConfidence,
      categoryConfidence: inTaxonomy ? raw.categoryConfidence : 0,
      source: 'auto',
    };

    // Step 3 — write back only when BOTH axes clear the threshold (FR-12). An
    // out-of-taxonomy clamp (categoryConfidence 0) therefore never gets cached.
    if (
      Math.min(resolution.nameConfidence, resolution.categoryConfidence) >=
      this.confidenceThreshold
    ) {
      await this.dictionary.upsert({
        store,
        skuOrAbbrev: key,
        canonicalName: resolution.canonicalName,
        category: resolution.category,
        nameConfidence: resolution.nameConfidence,
        categoryConfidence: resolution.categoryConfidence,
        source: 'auto',
        updatedAt: this.clock(),
      });
    }

    return resolution;
  }
}

// -----------------------------------------------------------------------------
// The live generic LLM seam (the default path on a dictionary miss, FR-9).
//
// Receives an already-chosen model — an AI Gateway id or any AI SDK language
// model. The core NEVER chooses a model, reads a key or builds a provider
// (NFR-1, G-3); the composition root and the eval harness wire it. Forces a
// single structured tool call so name and category come back as separate
// fields with separate confidences. Taxonomy clamping and dictionary write-back
// are the orchestrator's job (LlmSkuResolver), not this seam's.
// -----------------------------------------------------------------------------
export interface ModelSkuResolverOpts {
  model: LanguageModel;
  maxOutputTokens?: number;
}

interface RecordResolutionInput {
  canonicalName: string;
  category: string;
  nameConfidence: number;
  categoryConfidence: number;
}

export const RECORD_RESOLUTION_TOOL_NAME = 'record_resolution';

export class ModelSkuResolver implements SkuResolver {
  private readonly model: LanguageModel;
  private readonly maxOutputTokens: number;

  constructor(opts: ModelSkuResolverOpts) {
    this.model = opts.model;
    this.maxOutputTokens = opts.maxOutputTokens ?? 256;
  }

  async resolve(query: ResolutionQuery): Promise<Resolution> {
    const result = await generateText({
      model: this.model,
      maxOutputTokens: this.maxOutputTokens,
      tools: {
        [RECORD_RESOLUTION_TOOL_NAME]: tool({
          description:
            'Record the canonical product name and category for one receipt line item, ' +
            'with separate confidence scores for the name and the category.',
          inputSchema: jsonSchema<RecordResolutionInput>({
            type: 'object',
            properties: {
              canonicalName: {
                type: 'string',
                description: 'The full, human-readable product name the abbreviation refers to.',
              },
              category: {
                type: 'string',
                enum: [...query.categories],
                description: 'The single best-fitting category, chosen ONLY from the allowed list.',
              },
              nameConfidence: {
                type: 'number',
                description: 'Confidence in canonicalName, 0..1.',
              },
              categoryConfidence: {
                type: 'number',
                description: 'Confidence in category, 0..1.',
              },
            },
            required: ['canonicalName', 'category', 'nameConfidence', 'categoryConfidence'],
          }),
        }),
      },
      toolChoice: { type: 'tool', toolName: RECORD_RESOLUTION_TOOL_NAME },
      prompt: buildPrompt(query),
    });

    const call = result.toolCalls.find((c) => c.toolName === RECORD_RESOLUTION_TOOL_NAME);
    if (!call) {
      throw new Error('SKU resolver: model did not return a record_resolution tool call');
    }
    const input = call.input as RecordResolutionInput;
    return {
      canonicalName: input.canonicalName,
      category: input.category,
      nameConfidence: input.nameConfidence,
      categoryConfidence: input.categoryConfidence,
      source: 'auto',
    };
  }
}

function buildPrompt(query: ResolutionQuery): string {
  const skuLine = query.sku ? `SKU/code: ${query.sku}` : 'SKU/code: (none printed)';
  return [
    `Store: ${query.store}`,
    skuLine,
    `Printed line description: ${query.description}`,
    '',
    `Allowed categories: ${query.categories.join(', ')}`,
    '',
    'Resolve the abbreviated description to a canonical product name and pick the ' +
      'single best category from the allowed list. The canonical name is the product\'s ' +
      'identity — brand and product as a shopper would name it — WITHOUT pack size, ' +
      'count, weight or volume (those are separate fields), unless the size is part ' +
      'of the product\'s own name. Call record_resolution with your answer.',
  ].join('\n');
}
