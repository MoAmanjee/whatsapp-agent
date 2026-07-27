import { registerAutomotiveIndustry } from "@autoquoteai/industry-automotive";
import { registerGenericIndustries } from "@autoquoteai/industry-generic";
import { encryptSecret, decryptSecret, AppError, MEMBERSHIP_PERMISSIONS, type Permission } from "@autoquoteai/shared";
import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import { createHash } from "node:crypto";
import { prisma } from "@autoquoteai/db";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function registerAllIndustries(): void {
  try {
    registerAutomotiveIndustry();
  } catch {
    /* hot reload */
  }
  registerGenericIndustries();
}

registerAllIndustries();

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const quoteNumber = customAlphabet("0123456789ABCDEFGHJKLMNPQRSTUVWXYZ", 8);

export async function signUp(input: {
  email: string;
  password: string;
  name: string;
  businessName: string;
  industryKey?: string;
}) {
  const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (existing) {
    throw new AppError("email_taken", "Email already registered", 409);
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  const baseSlug = slugify(input.businessName) || "business";
  let slug = baseSlug;
  let i = 0;
  while (await prisma.tenant.findUnique({ where: { slug } })) {
    i += 1;
    slug = `${baseSlug}-${i}`;
  }

  const industryKey = input.industryKey ?? "automotive";

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email.toLowerCase(),
        name: input.name,
        passwordHash,
        emailVerifiedAt: new Date(),
      },
    });

    const tenant = await tx.tenant.create({
      data: {
        name: input.businessName,
        slug,
        industryKey,
      },
    });

    await tx.membership.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        role: "OWNER",
      },
    });

    await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        planKey: "starter",
        status: "TRIALING",
        entitlements: {
          conversationsPerMonth: 500,
          whatsappNumbers: 1,
          seats: 1,
        },
      },
    });

    return { user, tenant };
  });

  return result;
}

export async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user?.passwordHash) {
    throw new AppError("invalid_credentials", "Invalid email or password", 401);
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new AppError("invalid_credentials", "Invalid email or password", 401);
  }
  return user;
}

export async function createSession(userId: string) {
  const token = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 48)();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  await prisma.session.create({
    data: { userId, tokenHash, expiresAt },
  });
  return { token, expiresAt };
}

export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date()) return null;
  return session.user;
}

export async function revokeSession(token: string) {
  await prisma.session.deleteMany({
    where: { tokenHash: hashToken(token) },
  });
}

export function hasPermission(
  role: keyof typeof MEMBERSHIP_PERMISSIONS,
  permission: Permission,
): boolean {
  return (MEMBERSHIP_PERMISSIONS[role] as readonly string[]).includes(permission);
}

export async function assertMembership(
  userId: string,
  tenantId: string,
  permission?: Permission,
) {
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  });
  if (!membership) {
    throw new AppError("forbidden", "Not a member of this tenant", 403);
  }
  if (permission && !hasPermission(membership.role, permission)) {
    throw new AppError("forbidden", "Missing permission", 403);
  }
  return membership;
}

export async function searchCatalogForTenant(
  tenantId: string,
  hints: Array<{ query: string; filters?: Record<string, unknown> }>,
) {
  const results = [];
  for (const hint of hints) {
    const q = hint.query.trim();
    if (!q) continue;

    const oem = typeof hint.filters?.oemNumber === "string" ? hint.filters.oemNumber : null;
    if (oem) {
      const oemHits = await prisma.autoOemNumber.findMany({
        where: { tenantId, oemNumber: { equals: oem, mode: "insensitive" } },
        include: {
          product: {
            include: { variants: { where: { isActive: true }, take: 1 } },
          },
        },
        take: 10,
      });
      for (const hit of oemHits) {
        const variant = hit.product.variants[0];
        results.push({
          productId: hit.product.id,
          variantId: variant?.id,
          sku: hit.product.sku,
          name: hit.product.name,
          priceCents: variant?.priceCents ?? 0,
          stockQty: variant?.stockQty ?? 0,
          score: 1,
          reason: `OEM ${oem}`,
        });
      }
    }

    const year = typeof hint.filters?.year === "number" ? hint.filters.year : null;
    const make = typeof hint.filters?.make === "string" ? hint.filters.make : null;
    const model = typeof hint.filters?.model === "string" ? hint.filters.model : null;
    if (year || make || model) {
      const vehicles = await prisma.autoVehicle.findMany({
        where: {
          tenantId,
          ...(year ? { year } : {}),
          ...(make ? { make: { equals: make, mode: "insensitive" } } : {}),
          ...(model ? { model: { equals: model, mode: "insensitive" } } : {}),
        },
        take: 20,
      });
      if (vehicles.length > 0) {
        const fitments = await prisma.autoFitment.findMany({
          where: {
            tenantId,
            vehicleId: { in: vehicles.map((v) => v.id) },
          },
          include: {
            product: {
              include: { variants: { where: { isActive: true }, take: 1 } },
            },
          },
          take: 20,
        });
        for (const fit of fitments) {
          if (!fit.product.isActive) continue;
          const variant = fit.product.variants[0];
          const vehicleLabel = [year, make, model].filter(Boolean).join(" ");
          results.push({
            productId: fit.product.id,
            variantId: variant?.id,
            sku: fit.product.sku,
            name: fit.product.name,
            priceCents: variant?.priceCents ?? 0,
            stockQty: variant?.stockQty ?? 0,
            score: 0.95,
            reason: `fitment ${vehicleLabel}`.trim(),
          });
        }
      }
    }

    const products = await prisma.catalogProduct.findMany({
      where: {
        tenantId,
        isActive: true,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { sku: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      },
      include: { variants: { where: { isActive: true }, take: 1 } },
      take: 20,
    });

    for (const p of products) {
      const variant = p.variants[0];
      results.push({
        productId: p.id,
        variantId: variant?.id,
        sku: p.sku,
        name: p.name,
        priceCents: variant?.priceCents ?? 0,
        stockQty: variant?.stockQty ?? 0,
        score: 0.7,
        reason: "catalog text match",
      });
    }
  }

  const dedup = new Map<string, (typeof results)[number]>();
  for (const r of results) {
    const prev = dedup.get(r.productId);
    if (!prev || r.score > prev.score) dedup.set(r.productId, r);
  }
  return [...dedup.values()].sort((a, b) => b.score - a.score);
}

export async function importCatalogCsv(
  tenantId: string,
  csvText: string,
): Promise<{ created: number; skipped: number; errors: string[] }> {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { created: 0, skipped: 0, errors: ["Empty CSV"] };
  }

  const header = lines[0]!.toLowerCase().split(",").map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const skuI = idx("sku");
  const nameI = idx("name");
  const priceI = idx("price");
  if (skuI < 0 || nameI < 0 || priceI < 0) {
    return {
      created: 0,
      skipped: 0,
      errors: ["CSV header must include: sku,name,price (optional: stock,brand,description,oem,currency)"],
    };
  }
  const stockI = idx("stock");
  const brandI = idx("brand");
  const descI = idx("description");
  const oemI = idx("oem");
  const currencyI = idx("currency");

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]!);
    const sku = cols[skuI]?.trim();
    const name = cols[nameI]?.trim();
    const priceRaw = cols[priceI]?.trim();
    if (!sku || !name || !priceRaw) {
      skipped += 1;
      errors.push(`Row ${i + 1}: missing sku/name/price`);
      continue;
    }
    const priceNum = Number(priceRaw.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(priceNum)) {
      skipped += 1;
      errors.push(`Row ${i + 1}: invalid price`);
      continue;
    }
    const priceCents = Math.round(priceNum * (priceRaw.includes(".") || priceNum < 1000 ? 100 : 1));
    const stockQty = stockI >= 0 ? Math.max(0, Number(cols[stockI] ?? 0) || 0) : 0;
    const currency = (currencyI >= 0 ? cols[currencyI]?.trim() : undefined) || "ZAR";
    const brand = brandI >= 0 ? cols[brandI]?.trim() : undefined;
    const description = descI >= 0 ? cols[descI]?.trim() : undefined;
    const oemNumber = oemI >= 0 ? cols[oemI]?.trim() : undefined;

    try {
      const product = await prisma.catalogProduct.upsert({
        where: { tenantId_sku: { tenantId, sku } },
        create: {
          tenantId,
          sku,
          name,
          brand,
          description,
        },
        update: {
          name,
          brand,
          description,
          isActive: true,
        },
      });
      await prisma.catalogVariant.upsert({
        where: { tenantId_sku: { tenantId, sku: `${sku}-DEFAULT` } },
        create: {
          tenantId,
          productId: product.id,
          sku: `${sku}-DEFAULT`,
          priceCents,
          stockQty,
          currency,
        },
        update: { priceCents, stockQty, currency, isActive: true },
      });
      if (oemNumber) {
        await prisma.autoOemNumber.upsert({
          where: {
            tenantId_oemNumber_productId: {
              tenantId,
              oemNumber,
              productId: product.id,
            },
          },
          create: {
            tenantId,
            productId: product.id,
            oemNumber,
            isPrimary: true,
          },
          update: { isPrimary: true },
        });
      }
      created += 1;
    } catch (err) {
      skipped += 1;
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { created, skipped, errors: errors.slice(0, 20) };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export async function activateStubSubscription(
  tenantId: string,
  planKey: "starter" | "growth" | "scale",
) {
  const planEntitlements: Record<
    "starter" | "growth" | "scale",
    { conversationsPerMonth: number; whatsappNumbers: number; seats: number; features: string[] }
  > = {
    starter: {
      conversationsPerMonth: 500,
      whatsappNumbers: 1,
      seats: 1,
      features: ["quotes", "catalog", "ai_agent"],
    },
    growth: {
      conversationsPerMonth: 3000,
      whatsappNumbers: 1,
      seats: 5,
      features: ["quotes", "catalog", "ai_agent", "approvals", "csv_import"],
    },
    scale: {
      conversationsPerMonth: 20000,
      whatsappNumbers: 5,
      seats: 25,
      features: ["quotes", "catalog", "ai_agent", "approvals", "csv_import", "api_access"],
    },
  };
  const plan = planEntitlements[planKey];
  return prisma.subscription.update({
    where: { tenantId },
    data: {
      planKey,
      status: "ACTIVE",
      providerCustomerId: `stub_cus_${tenantId.slice(0, 8)}`,
      providerSubscriptionId: `stub_sub_${planKey}_${Date.now()}`,
      entitlements: JSON.parse(JSON.stringify(plan)),
    },
  });
}

export async function assertConversationEntitlement(tenantId: string) {
  const sub = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!sub) return;
  if (sub.status === "CANCELLED" || sub.status === "UNPAID") {
    throw new AppError(
      "subscription_inactive",
      "Subscription is inactive — update billing to continue AI conversations",
      402,
    );
  }
  const entitlements = (sub.entitlements ?? {}) as {
    conversationsPerMonth?: number;
  };
  const cap = entitlements.conversationsPerMonth ?? 500;
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const used = await prisma.aiRun.count({
    where: { tenantId, startedAt: { gte: start } },
  });
  if (used >= cap) {
    throw new AppError(
      "conversation_cap",
      `Monthly conversation cap (${cap}) reached for this plan`,
      402,
    );
  }
}

export async function writeAuditLog(input: {
  tenantId?: string;
  userId?: string;
  action: string;
  resource?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: input.action,
      resource: input.resource,
      metadata: JSON.parse(JSON.stringify(input.metadata ?? {})),
    },
  });
}

export async function createQuoteDraft(input: {
  tenantId: string;
  contactId: string;
  conversationId?: string;
  currency: string;
  lines: Array<{
    productId: string;
    variantId?: string;
    description: string;
    quantity: number;
    unitCents: number;
  }>;
  notes?: string;
}) {
  const subtotal = input.lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const number = `Q-${quoteNumber()}`;

  return prisma.quote.create({
    data: {
      tenantId: input.tenantId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      number,
      status: "DRAFT",
      currency: input.currency,
      subtotalCents: subtotal,
      taxCents: 0,
      totalCents: subtotal,
      notes: input.notes,
      lines: {
        create: input.lines.map((l) => ({
          tenantId: input.tenantId,
          productId: l.productId,
          variantId: l.variantId,
          description: l.description,
          quantity: l.quantity,
          unitCents: l.unitCents,
          totalCents: l.unitCents * l.quantity,
        })),
      },
    },
    include: { lines: true },
  });
}

export async function nextQuoteNumber(): Promise<string> {
  return `Q-${quoteNumber()}`;
}

export async function connectWhatsappAccount(input: {
  tenantId: string;
  phoneNumberId: string;
  accessToken: string;
  displayNumber?: string;
  wabaId?: string;
}) {
  const accessTokenEnc = encryptSecret(input.accessToken);
  return prisma.whatsappAccount.upsert({
    where: {
      tenantId_phoneNumberId: {
        tenantId: input.tenantId,
        phoneNumberId: input.phoneNumberId,
      },
    },
    create: {
      tenantId: input.tenantId,
      phoneNumberId: input.phoneNumberId,
      displayNumber: input.displayNumber,
      wabaId: input.wabaId,
      accessTokenEnc,
      isActive: true,
    },
    update: {
      displayNumber: input.displayNumber,
      wabaId: input.wabaId,
      accessTokenEnc,
      isActive: true,
    },
  });
}

export function resolveWhatsappAccessToken(accessTokenEnc: string): string {
  if (process.env.WHATSAPP_DEV_ACCESS_TOKEN) {
    return process.env.WHATSAPP_DEV_ACCESS_TOKEN;
  }
  // Stub tokens used in local seed start with "stub:"
  if (accessTokenEnc.startsWith("stub:")) {
    return accessTokenEnc;
  }
  try {
    return decryptSecret(accessTokenEnc);
  } catch {
    return accessTokenEnc;
  }
}

export async function seedDemoCatalog(tenantId: string) {
  const existing = await prisma.catalogProduct.count({ where: { tenantId } });
  if (existing > 0) return { seeded: false, reason: "catalog_not_empty" };

  const oilFilter = await prisma.catalogProduct.create({
    data: {
      tenantId,
      sku: "OF-TOY-001",
      name: "Oil Filter — Toyota 1ZZ",
      brand: "Bosch",
      description: "Oil filter suitable for Toyota Corolla 1ZZ engines",
      variants: {
        create: {
          tenantId,
          sku: "OF-TOY-001-DEFAULT",
          priceCents: 18999,
          stockQty: 42,
          currency: "ZAR",
        },
      },
    },
  });

  await prisma.autoOemNumber.create({
    data: {
      tenantId,
      productId: oilFilter.id,
      oemNumber: "90915-YZZD2",
      brand: "Toyota",
      isPrimary: true,
    },
  });

  const vehicle = await prisma.autoVehicle.create({
    data: {
      tenantId,
      year: 2012,
      make: "Toyota",
      model: "Corolla",
      engine: "1ZZ",
    },
  });

  await prisma.autoFitment.create({
    data: {
      tenantId,
      productId: oilFilter.id,
      vehicleId: vehicle.id,
      notes: "Demo fitment",
    },
  });

  await prisma.catalogProduct.create({
    data: {
      tenantId,
      sku: "BRK-PAD-F01",
      name: "Front Brake Pads — Corolla",
      brand: "Brembo",
      description: "Front brake pad set",
      variants: {
        create: {
          tenantId,
          sku: "BRK-PAD-F01-DEFAULT",
          priceCents: 89900,
          stockQty: 15,
          currency: "ZAR",
        },
      },
    },
  });

  return { seeded: true };
}
