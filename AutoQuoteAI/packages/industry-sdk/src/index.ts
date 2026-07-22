import type { ZodTypeAny } from "zod";

export type IndustryContext = {
  tenantId: string;
  currency: string;
  locale: string;
};

export type SearchHint = {
  query: string;
  filters?: Record<string, string | number | boolean>;
  boostProductIds?: string[];
};

export type ProductCandidate = {
  productId: string;
  sku: string;
  name: string;
  score: number;
  reason: string;
  priceCents?: number;
  stockQty?: number;
};

export type QuotePresentation = {
  title: string;
  customerSummary: string;
  lineNotes?: string[];
};

/**
 * Industry plugins implement this contract.
 * Core never imports automotive specifics — only this interface.
 */
export interface IndustryModule {
  readonly key: string;
  readonly displayName: string;
  /** Slots the sales agent must collect before quoting */
  readonly slotSchema: ZodTypeAny;
  enrichSearch(
    customerText: string,
    slots: Record<string, unknown>,
    ctx: IndustryContext,
  ): Promise<SearchHint[]>;
  explainMatch(
    product: ProductCandidate,
    slots: Record<string, unknown>,
  ): string;
  quotePresentation(
    lines: Array<{ name: string; quantity: number; unitCents: number }>,
    slots: Record<string, unknown>,
    ctx: IndustryContext,
  ): QuotePresentation;
  /** Human-readable prompts to ask when slots are missing */
  missingSlotPrompts(slots: Record<string, unknown>): string[];
}

const registry = new Map<string, IndustryModule>();

export function registerIndustry(module: IndustryModule): void {
  if (registry.has(module.key)) {
    throw new Error(`Industry already registered: ${module.key}`);
  }
  registry.set(module.key, module);
}

export function getIndustry(key: string): IndustryModule {
  const mod = registry.get(key);
  if (!mod) {
    throw new Error(`Unknown industry plugin: ${key}`);
  }
  return mod;
}

export function listIndustries(): IndustryModule[] {
  return [...registry.values()];
}
