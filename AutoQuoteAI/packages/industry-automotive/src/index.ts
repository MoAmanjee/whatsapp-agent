import {
  registerIndustry,
  type IndustryModule,
  type IndustryContext,
  type ProductCandidate,
  type QuotePresentation,
  type SearchHint,
} from "@autoquoteai/industry-sdk";
import { z } from "zod";

export const automotiveSlotsSchema = z.object({
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  make: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  engine: z.string().optional(),
  partName: z.string().min(1).optional(),
  oemNumber: z.string().optional(),
});

export type AutomotiveSlots = z.infer<typeof automotiveSlotsSchema>;

function missingSlotPrompts(slots: Record<string, unknown>): string[] {
  const s = automotiveSlotsSchema.partial().parse(slots);
  const prompts: string[] = [];
  if (!s.oemNumber) {
    if (!s.year) prompts.push("What year is the vehicle?");
    if (!s.make) prompts.push("What make (e.g. Toyota, VW, BMW)?");
    if (!s.model) prompts.push("What model?");
    if (!s.partName) prompts.push("Which part do you need?");
  }
  return prompts;
}

export const automotiveModule: IndustryModule = {
  key: "automotive",
  displayName: "Automotive Parts",
  slotSchema: automotiveSlotsSchema,

  async enrichSearch(
    customerText: string,
    slots: Record<string, unknown>,
    _ctx: IndustryContext,
  ): Promise<SearchHint[]> {
    const s = automotiveSlotsSchema.partial().parse(slots);
    const hints: SearchHint[] = [];

    if (s.oemNumber) {
      hints.push({
        query: s.oemNumber,
        filters: { oemNumber: s.oemNumber },
      });
    }

    const part = s.partName ?? customerText;
    const vehicleBits = [s.year, s.make, s.model, s.engine]
      .filter(Boolean)
      .join(" ");

    hints.push({
      query: [part, vehicleBits].filter(Boolean).join(" ").trim(),
      filters: {
        ...(s.year ? { year: s.year } : {}),
        ...(s.make ? { make: s.make } : {}),
        ...(s.model ? { model: s.model } : {}),
      },
    });

    return hints;
  },

  explainMatch(product: ProductCandidate, slots: Record<string, unknown>): string {
    const s = automotiveSlotsSchema.partial().parse(slots);
    if (s.oemNumber) {
      return `${product.name} matches OEM/interchange ${s.oemNumber}`;
    }
    const vehicle = [s.year, s.make, s.model].filter(Boolean).join(" ");
    return vehicle
      ? `${product.name} is a candidate for ${vehicle}`
      : product.reason;
  },

  quotePresentation(
    lines: Array<{ name: string; quantity: number; unitCents: number }>,
    slots: Record<string, unknown>,
    ctx: IndustryContext,
  ): QuotePresentation {
    const s = automotiveSlotsSchema.partial().parse(slots);
    const vehicle = [s.year, s.make, s.model, s.engine].filter(Boolean).join(" ");
    return {
      title: vehicle ? `Parts quote — ${vehicle}` : "Parts quote",
      customerSummary: vehicle
        ? `Quote for ${vehicle}${s.partName ? ` — ${s.partName}` : ""}`
        : `Quote (${ctx.currency})`,
      lineNotes: lines.map((l) => `${l.quantity}x ${l.name}`),
    };
  },

  missingSlotPrompts,
};

export function registerAutomotiveIndustry(): void {
  try {
    registerIndustry(automotiveModule);
  } catch {
    // already registered
  }
}
