import type { IndustryModule } from "@autoquoteai/industry-sdk";
import {
  type Llm,
  llmExtractSlots,
  llmComposeReply,
} from "./llm.js";

export * from "./llm.js";

/** Best-effort read of slot field names from an industry's Zod slot schema. */
function slotKeysOf(schema: unknown): string[] {
  const def = (schema as { _def?: { shape?: unknown; typeName?: string } })?._def;
  const shape = typeof def?.shape === "function"
    ? (def.shape as () => Record<string, unknown>)()
    : (def?.shape as Record<string, unknown> | undefined);
  return shape ? Object.keys(shape) : [];
}

export type CatalogSearchResult = {
  productId: string;
  variantId?: string;
  sku: string;
  name: string;
  priceCents: number;
  stockQty: number;
  score: number;
  reason: string;
};

export type SalesTools = {
  searchCatalog: (hints: Array<{ query: string; filters?: Record<string, unknown> }>) => Promise<CatalogSearchResult[]>;
  createQuote: (input: {
    lines: Array<{
      productId: string;
      variantId?: string;
      description: string;
      quantity: number;
      unitCents: number;
    }>;
    notes?: string;
  }) => Promise<{ quoteId: string; number: string; totalCents: number }>;
  escalateToHuman: (reason: string) => Promise<void>;
};

export type WorkflowInput = {
  tenantId: string;
  currency: string;
  locale: string;
  customerText: string;
  slots: Record<string, unknown>;
  industry: IndustryModule;
  tools: SalesTools;
  requireQuoteApproval: boolean;
  /** Optional LLM; when absent the workflow uses deterministic extraction. */
  llm?: Llm | null;
  /** Business name, used for LLM reply phrasing. */
  businessName?: string;
};

export type WorkflowResult = {
  replyText: string;
  slots: Record<string, unknown>;
  action:
    | "ask_clarify"
    | "quote_drafted"
    | "quote_pending_approval"
    | "escalated"
    | "no_match";
  quoteId?: string;
  trace: Array<{ step: string; detail?: unknown }>;
};

/**
 * Deterministic sales workflow. LLM slot-filling can wrap this later;
 * prices NEVER come from the model — only from catalog tools.
 */
export async function runQuoteSalesWorkflow(
  input: WorkflowInput,
): Promise<WorkflowResult> {
  const trace: WorkflowResult["trace"] = [];
  const slots = { ...input.slots };

  trace.push({ step: "ingest", detail: { text: input.customerText } });

  if (input.llm) {
    // LLM-based structured extraction (prices/products are never requested).
    try {
      const wanted = slotKeysOf(input.industry.slotSchema);
      const extracted = await llmExtractSlots(input.llm, {
        customerText: input.customerText,
        currentSlots: slots,
        wantedSlots: wanted.length > 0 ? wanted : ["partName", "year", "make", "model", "oemNumber"],
        industryName: input.industry.displayName,
      });
      trace.push({ step: "llm_extract_slots", detail: extracted });

      if (extracted.outOfScope) {
        await input.tools.escalateToHuman("llm_out_of_scope");
        return {
          replyText:
            "Thanks for your message — I've passed this to a team member who'll get back to you shortly.",
          slots,
          action: "escalated",
          trace,
        };
      }
      for (const [k, v] of Object.entries(extracted.slots)) {
        if (v !== null && v !== undefined && v !== "" && slots[k] === undefined) {
          slots[k] = v;
        }
      }
    } catch (err) {
      trace.push({ step: "llm_extract_error", detail: String(err) });
      // Fall through to regex extraction below on any LLM failure.
    }
  }

  if (!input.llm || Object.keys(slots).length === 0) {
    // Deterministic fallback: OEM-ish tokens + year.
    const oem = input.customerText.match(/\b([A-Z0-9]{5,}(?:-?[A-Z0-9]+)+)\b/);
    if (oem?.[1] && !slots.oemNumber) {
      slots.oemNumber = oem[1];
      trace.push({ step: "extract_oem", detail: oem[1] });
    }
    const year = input.customerText.match(/\b(19|20)\d{2}\b/);
    if (year?.[0] && !slots.year) {
      slots.year = Number(year[0]);
      trace.push({ step: "extract_year", detail: slots.year });
    }
    if (!slots.partName && input.customerText.length < 120) {
      slots.partName = input.customerText;
    }
  }

  const missing = input.industry.missingSlotPrompts(slots);
  if (missing.length > 0) {
    trace.push({ step: "collect_slots", detail: missing });
    let replyText = missing[0] ?? "Could you share a bit more detail?";
    if (input.llm && input.businessName) {
      try {
        replyText = await llmComposeReply(input.llm, {
          businessName: input.businessName,
          draft: replyText,
          locale: input.locale,
        });
      } catch {
        /* keep deterministic prompt on failure */
      }
    }
    return { replyText, slots, action: "ask_clarify", trace };
  }

  const hints = await input.industry.enrichSearch(
    input.customerText,
    slots,
    {
      tenantId: input.tenantId,
      currency: input.currency,
      locale: input.locale,
    },
  );
  trace.push({ step: "enrich_search", detail: hints });

  const results = await input.tools.searchCatalog(hints);
  trace.push({ step: "search_catalog", detail: { count: results.length } });

  if (results.length === 0) {
    await input.tools.escalateToHuman("zero_catalog_matches");
    return {
      replyText:
        "I couldn't find an exact match in our catalog. A team member will follow up shortly.",
      slots,
      action: "escalated",
      trace,
    };
  }

  if (results.length > 3) {
    const top = results.slice(0, 3);
    return {
      replyText:
        "I found a few options. Which one do you want a quote for?\n" +
        top
          .map(
            (r, i) =>
              `${i + 1}. ${r.name} (${r.sku}) — ${(r.priceCents / 100).toFixed(2)} ${input.currency}`,
          )
          .join("\n"),
      slots,
      action: "ask_clarify",
      trace,
    };
  }

  const best = results[0]!;
  const explanation = input.industry.explainMatch(
    {
      productId: best.productId,
      sku: best.sku,
      name: best.name,
      score: best.score,
      reason: best.reason,
      priceCents: best.priceCents,
      stockQty: best.stockQty,
    },
    slots,
  );

  if (best.stockQty <= 0) {
    return {
      replyText: `${best.name} looks right (${explanation}) but it's currently out of stock. Want me to check alternatives?`,
      slots,
      action: "ask_clarify",
      trace,
    };
  }

  const quote = await input.tools.createQuote({
    lines: [
      {
        productId: best.productId,
        variantId: best.variantId,
        description: best.name,
        quantity: 1,
        unitCents: best.priceCents,
      },
    ],
    notes: explanation,
  });
  trace.push({ step: "create_quote", detail: quote });

  const presentation = input.industry.quotePresentation(
    [{ name: best.name, quantity: 1, unitCents: best.priceCents }],
    slots,
    {
      tenantId: input.tenantId,
      currency: input.currency,
      locale: input.locale,
    },
  );

  if (input.requireQuoteApproval) {
    return {
      replyText: `${presentation.customerSummary}\nQuote ${quote.number} is ready and pending internal approval. We'll send it shortly.`,
      slots,
      action: "quote_pending_approval",
      quoteId: quote.quoteId,
      trace,
    };
  }

  return {
    replyText: `${presentation.customerSummary}\nQuote ${quote.number}: ${(quote.totalCents / 100).toFixed(2)} ${input.currency}. Shall I send the formal quote?`,
    slots,
    action: "quote_drafted",
    quoteId: quote.quoteId,
    trace,
  };
}
