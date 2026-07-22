import {
  registerIndustry,
  type IndustryModule,
  type IndustryContext,
  type ProductCandidate,
  type QuotePresentation,
  type SearchHint,
} from "@autoquoteai/industry-sdk";
import { z } from "zod";

function makeGenericIndustry(opts: {
  key: string;
  displayName: string;
  partLabel: string;
}): IndustryModule {
  const slotSchema = z.object({
    partName: z.string().min(1).optional(),
    brand: z.string().optional(),
    sku: z.string().optional(),
    notes: z.string().optional(),
  });

  return {
    key: opts.key,
    displayName: opts.displayName,
    slotSchema,
    async enrichSearch(customerText, slots): Promise<SearchHint[]> {
      const s = slotSchema.partial().parse(slots);
      return [
        {
          query: s.sku ?? s.partName ?? customerText,
          filters: {
            ...(s.brand ? { brand: s.brand } : {}),
            ...(s.sku ? { sku: s.sku } : {}),
          },
        },
      ];
    },
    explainMatch(product: ProductCandidate): string {
      return `${product.name} matched your ${opts.partLabel} request`;
    },
    quotePresentation(lines, _slots, ctx: IndustryContext): QuotePresentation {
      return {
        title: `${opts.displayName} quote`,
        customerSummary: `Quote for ${opts.partLabel} (${ctx.currency})`,
        lineNotes: lines.map((l) => `${l.quantity}x ${l.name}`),
      };
    },
    missingSlotPrompts(slots) {
      const s = slotSchema.partial().parse(slots);
      if (!s.partName && !s.sku) {
        return [`Which ${opts.partLabel} do you need? (name or SKU)`];
      }
      return [];
    },
  };
}

export const hardwareModule = makeGenericIndustry({
  key: "hardware",
  displayName: "Hardware Store",
  partLabel: "item",
});
export const plumbingModule = makeGenericIndustry({
  key: "plumbing",
  displayName: "Plumbing Supplier",
  partLabel: "plumbing part",
});
export const electricalModule = makeGenericIndustry({
  key: "electrical",
  displayName: "Electrical Wholesaler",
  partLabel: "electrical item",
});
export const tyreModule = makeGenericIndustry({
  key: "tyre",
  displayName: "Tyre Shop",
  partLabel: "tyre",
});
export const furnitureModule = makeGenericIndustry({
  key: "furniture",
  displayName: "Furniture Store",
  partLabel: "furniture item",
});
export const applianceModule = makeGenericIndustry({
  key: "appliance",
  displayName: "Appliance Store",
  partLabel: "appliance / part",
});

const ALL = [
  hardwareModule,
  plumbingModule,
  electricalModule,
  tyreModule,
  furnitureModule,
  applianceModule,
];

export function registerGenericIndustries(): void {
  for (const m of ALL) {
    try {
      registerIndustry(m);
    } catch {
      // already registered on hot reload
    }
  }
}
