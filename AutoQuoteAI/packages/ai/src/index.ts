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

function isAffirmative(text: string): boolean {
  return /^(yes|yep|yeah|yup|ok|okay|sure|please|send|send it|go ahead|confirm|do it|ja|y)\b/i.test(
    text.trim(),
  );
}

function isNegative(text: string): boolean {
  return /^(no|nope|nah|cancel|stop|don't|dont)\b/i.test(text.trim());
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
  /** Optional — when customer confirms, queue formal quote send. */
  sendQuote?: (quoteId: string) => Promise<void>;
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
    | "quote_send_queued"
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

  // --- Confirmation handshake -------------------------------------------
  // If a quote was already drafted and is waiting, act on the customer's reply.
  const pendingQuoteId =
    typeof slots.pendingQuoteId === "string" ? slots.pendingQuoteId : undefined;
  if (pendingQuoteId) {
    if (isAffirmative(input.customerText)) {
      if (input.tools.sendQuote) {
        await input.tools.sendQuote(pendingQuoteId);
      }
      delete slots.pendingQuoteId;
      slots.lastSentQuoteId = pendingQuoteId;
      trace.push({ step: "send_quote_confirmed", detail: { quoteId: pendingQuoteId } });
      return {
        replyText:
          "Perfect — I'm sending the formal quote on WhatsApp now. Reply anytime if you need anything else.",
        slots,
        action: "quote_send_queued",
        quoteId: pendingQuoteId,
        trace,
      };
    }
    if (isNegative(input.customerText)) {
      delete slots.pendingQuoteId;
      trace.push({ step: "send_quote_declined", detail: { quoteId: pendingQuoteId } });
      return {
        replyText:
          "No problem — I won't send the formal quote. Tell me if you'd like a different part.",
        slots,
        action: "ask_clarify",
        quoteId: pendingQuoteId,
        trace,
      };
    }
    // Neither yes nor no while a quote is pending: re-prompt instead of re-drafting.
    return {
      replyText:
        "I already have a quote ready for you. Reply **yes** to send the formal quote, or tell me what to change.",
      slots,
      action: "ask_clarify",
      quoteId: pendingQuoteId,
      trace,
    };
  }

  // Already sent a quote recently and no new part request — avoid re-drafting.
  if (
    typeof slots.lastSentQuoteId === "string" &&
    input.customerText.trim().length < 8 &&
    !/\b(filter|pad|brake|oem|part|quote|need|want)\b/i.test(input.customerText)
  ) {
    return {
      replyText: "Your quote is already on the way. What else can I help with?",
      slots,
      action: "ask_clarify",
      quoteId: slots.lastSentQuoteId as string,
      trace,
    };
  }

  // --- Slot extraction ---------------------------------------------------
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

  // Deterministic fallback. Ignore the control slots when deciding "is it empty?".
  if (
    !input.llm ||
    Object.keys(slots).filter(
      (k) => !["pendingQuoteId", "lastSentQuoteId"].includes(k),
    ).length === 0
  ) {
    const text = input.customerText;

    const oem = text.match(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{4,}(?:-[A-Z0-9]+)*\b/i);
    if (oem?.[0] && !slots.oemNumber) {
      slots.oemNumber = oem[0].toUpperCase();
      trace.push({ step: "extract_oem", detail: slots.oemNumber });
    }

    const year = text.match(/\b(19|20)\d{2}\b/);
    if (year?.[0] && !slots.year) {
      slots.year = Number(year[0]);
      trace.push({ step: "extract_year", detail: slots.year });
    }

    const makeMatch = text.match(
      /\b(toyota|honda|bmw|vw|volkswagen|ford|nissan|mercedes|audi|hyundai|kia|mazda)\b/i,
    );
    if (makeMatch?.[1] && !slots.make) {
      const raw = makeMatch[1]!.toLowerCase();
      const map: Record<string, string> = { vw: "Volkswagen", volkswagen: "Volkswagen", bmw: "BMW" };
      slots.make = map[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
      trace.push({ step: "extract_make", detail: slots.make });
    }

    const modelMatch = text.match(
      /\b(corolla|civic|golf|polo|ranger|hilux|i20|focus|a4|c-class)\b/i,
    );
    if (modelMatch?.[1] && !slots.model) {
      const m = modelMatch[1]!;
      slots.model = m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
      trace.push({ step: "extract_model", detail: slots.model });
    }

    const partMatch = text.match(
      /\b(oil filter|air filter|cabin filter|brake pads?|spark plugs?|clutch|battery|alternator|radiator|filter|pads?)\b/i,
    );
    if (partMatch?.[1] && !slots.partName) {
      slots.partName = partMatch[1];
      trace.push({ step: "extract_part", detail: slots.partName });
    }

    if (!slots.partName && !slots.make && !slots.year && !slots.oemNumber && text.length < 120) {
      slots.partName = text;
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

  // --- Catalog match + draft --------------------------------------------
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
    // Needs internal sign-off first — do NOT let the customer's "yes" send it.
    return {
      replyText: `${presentation.customerSummary}\nQuote ${quote.number} is ready and pending internal approval. We'll send it shortly.`,
      slots,
      action: "quote_pending_approval",
      quoteId: quote.quoteId,
      trace,
    };
  }

  // Draft held — remember it and wait for the customer to confirm with "yes".
  slots.pendingQuoteId = quote.quoteId;
  return {
    replyText: `${presentation.customerSummary}\nQuote ${quote.number}: ${(quote.totalCents / 100).toFixed(2)} ${input.currency}. Reply **yes** and I'll send the formal quote now.`,
    slots,
    action: "quote_drafted",
    quoteId: quote.quoteId,
    trace,
  };
}
