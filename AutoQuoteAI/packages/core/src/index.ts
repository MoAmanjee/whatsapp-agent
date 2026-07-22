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
