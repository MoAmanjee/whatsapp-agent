import { config } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

for (const p of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
]) {
  if (existsSync(p)) {
    config({ path: p });
    break;
  }
}

import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { prisma } from "@autoquoteai/db";
import {
  AppError,
  problemJson,
  QUEUE_NAMES,
  PLANS,
} from "@autoquoteai/shared";
import {
  authenticate,
  assertMembership,
  connectWhatsappAccount,
  createSession,
  resolveSession,
  resolveWhatsappAccessToken,
  seedDemoCatalog,
  signUp,
  registerAllIndustries,
} from "@autoquoteai/core";
import { createWhatsappProvider, verifyMetaSignature } from "@autoquoteai/whatsapp";
import { createBillingProvider } from "@autoquoteai/billing";
import { getIndustry, listIndustries } from "@autoquoteai/industry-sdk";
import { renderQuoteHtml } from "@autoquoteai/quotes";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";

registerAllIndustries();

const PORT = Number(process.env.API_PORT ?? 4000);
const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const SESSION_COOKIE = "aq_session";

const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const conversationQueue = new Queue(QUEUE_NAMES.conversationProcess, {
  connection: redis,
});
const quoteSendQueue = new Queue(QUEUE_NAMES.quoteSend, { connection: redis });

const whatsapp = createWhatsappProvider();
const billing = createBillingProvider();

type AuthedUser = { id: string; email: string; name: string | null };

function requireUser(req: { user?: AuthedUser | null }) {
  if (!req.user) throw new AppError("unauthorized", "Not signed in", 401);
  return req.user;
}

async function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  await app.register(cors, { origin: WEB_URL, credentials: true });
  await app.register(cookie);

  // Preserve the raw request body so webhook signatures (Meta, Stripe) can be
  // verified over the exact bytes received — re-serializing JSON is unreliable.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      if (!body) return done(null, {});
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(problemJson(err));
    }
    if ((err as { name?: string }).name === "ZodError") {
      return reply.status(400).send({
        type: "https://autoquoteai.local/errors/validation",
        title: "validation",
        status: 400,
        detail: "Invalid request body",
        details: err,
      });
    }
    app.log.error(err);
    return reply.status(500).send({
      type: "https://autoquoteai.local/errors/internal",
      title: "internal",
      status: 500,
      detail: "Internal server error",
    });
  });

  app.addHook("preHandler", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      (req as { user?: AuthedUser | null }).user = await resolveSession(token);
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    version: "0.1.0",
  }));

  app.get("/ready", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      return { ok: true };
    } catch (e) {
      return reply.status(503).send({ ok: false, error: String(e) });
    }
  });

  app.get("/v1/industries", async () =>
    listIndustries().map((i) => ({ key: i.key, displayName: i.displayName })),
  );

  app.get("/v1/plans", async () => PLANS);

  // --- Auth ---
  app.post("/v1/auth/signup", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(1),
        businessName: z.string().min(1),
        industryKey: z.string().default("automotive"),
      })
      .parse(req.body);
    getIndustry(body.industryKey);
    const { user, tenant } = await signUp(body);
    const session = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: session.expiresAt,
    });
    return { user: { id: user.id, email: user.email, name: user.name }, tenant };
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body);
    const user = await authenticate(body.email, body.password);
    const session = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: session.expiresAt,
    });
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post("/v1/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/me", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const memberships = await prisma.membership.findMany({
      where: { userId: user.id },
      include: { tenant: true },
    });
    return { user, memberships };
  });

  // --- Tenant ---
  app.get("/v1/tenants/:tenantId", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "tenant:read");
    return prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: { subscription: true },
    });
  });

  app.patch("/v1/tenants/:tenantId", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "ai:configure");
    const body = z
      .object({
        name: z.string().min(1).optional(),
        timezone: z.string().optional(),
        currency: z.string().length(3).optional(),
        requireQuoteApproval: z.boolean().optional(),
      })
      .parse(req.body);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = {
      ...((tenant.settings ?? {}) as object),
      ...(body.requireQuoteApproval !== undefined
        ? { requireQuoteApproval: body.requireQuoteApproval }
        : {}),
    };
    return prisma.tenant.update({
      where: { id: tenantId },
      data: {
        name: body.name,
        timezone: body.timezone,
        currency: body.currency,
        settings,
      },
    });
  });

  app.post("/v1/tenants/:tenantId/seed-demo", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "catalog:write");
    return seedDemoCatalog(tenantId);
  });

  // --- Catalog ---
  app.get("/v1/tenants/:tenantId/products", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "catalog:read");
    return prisma.catalogProduct.findMany({
      where: { tenantId },
      include: { variants: true, oemNumbers: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  app.post("/v1/tenants/:tenantId/products", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "catalog:write");
    const body = z
      .object({
        sku: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        brand: z.string().optional(),
        priceCents: z.number().int().nonnegative(),
        stockQty: z.number().int().nonnegative().default(0),
        currency: z.string().length(3).default("ZAR"),
        oemNumber: z.string().optional(),
      })
      .parse(req.body);

    return prisma.catalogProduct.create({
      data: {
        tenantId,
        sku: body.sku,
        name: body.name,
        description: body.description,
        brand: body.brand,
        variants: {
          create: {
            tenantId,
            sku: `${body.sku}-DEFAULT`,
            priceCents: body.priceCents,
            stockQty: body.stockQty,
            currency: body.currency,
          },
        },
        oemNumbers: body.oemNumber
          ? {
              create: {
                tenantId,
                oemNumber: body.oemNumber,
                isPrimary: true,
              },
            }
          : undefined,
      },
      include: { variants: true, oemNumbers: true },
    });
  });

  // --- WhatsApp connect ---
  app.get("/v1/tenants/:tenantId/whatsapp", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "tenant:read");
    const accounts = await prisma.whatsappAccount.findMany({ where: { tenantId } });
    return accounts.map((a) => ({
      id: a.id,
      phoneNumberId: a.phoneNumberId,
      displayNumber: a.displayNumber,
      wabaId: a.wabaId,
      isActive: a.isActive,
      qualityRating: a.qualityRating,
    }));
  });

  app.post("/v1/tenants/:tenantId/whatsapp", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "whatsapp:connect");
    const body = z
      .object({
        phoneNumberId: z.string().min(1),
        accessToken: z.string().min(1),
        displayNumber: z.string().optional(),
        wabaId: z.string().optional(),
      })
      .parse(req.body);
    const account = await connectWhatsappAccount({ tenantId, ...body });
    return {
      id: account.id,
      phoneNumberId: account.phoneNumberId,
      displayNumber: account.displayNumber,
      isActive: account.isActive,
    };
  });

  // --- Demo inbound (no Meta required at home) ---
  app.post("/v1/tenants/:tenantId/demo/inbound", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "inbox:takeover");
    const body = z
      .object({
        text: z.string().min(1),
        fromWaId: z.string().default("27000000000"),
        profileName: z.string().default("Demo Customer"),
      })
      .parse(req.body);

    let account = await prisma.whatsappAccount.findFirst({
      where: { tenantId, isActive: true },
    });
    if (!account) {
      account = await connectWhatsappAccount({
        tenantId,
        phoneNumberId: `demo-${tenantId.slice(0, 8)}`,
        accessToken: "stub:demo",
        displayNumber: "+27 DEMO",
        wabaId: "demo-waba",
      });
    }

    const contact = await prisma.contact.upsert({
      where: { tenantId_waId: { tenantId, waId: body.fromWaId } },
      create: {
        tenantId,
        waId: body.fromWaId,
        profileName: body.profileName,
        phoneE164: `+${body.fromWaId}`,
      },
      update: { profileName: body.profileName },
    });

    const conversation = await prisma.conversation.upsert({
      where: {
        tenantId_contactId_whatsappAccountId: {
          tenantId,
          contactId: contact.id,
          whatsappAccountId: account.id,
        },
      },
      create: {
        tenantId,
        contactId: contact.id,
        whatsappAccountId: account.id,
        lastMessageAt: new Date(),
        status: "AI_ACTIVE",
      },
      update: { lastMessageAt: new Date(), status: "AI_ACTIVE" },
    });

    const waMessageId = `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const saved = await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        direction: "INBOUND",
        status: "RECEIVED",
        waMessageId,
        bodyText: body.text,
        payload: { demo: true },
      },
    });

    await conversationQueue.add(
      "process",
      {
        tenantId,
        conversationId: conversation.id,
        messageId: saved.id,
      },
      { removeOnComplete: 1000, removeOnFail: 5000, jobId: `msg:${waMessageId}` },
    );

    return { ok: true, conversationId: conversation.id, messageId: saved.id };
  });

  // --- Inbox ---
  app.get("/v1/tenants/:tenantId/conversations", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "tenant:read");
    return prisma.conversation.findMany({
      where: { tenantId },
      include: {
        contact: true,
        messages: { orderBy: { createdAt: "desc" }, take: 5 },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 50,
    });
  });

  app.get("/v1/tenants/:tenantId/conversations/:id", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    await assertMembership(user.id, tenantId, "tenant:read");
    return prisma.conversation.findFirstOrThrow({
      where: { id, tenantId },
      include: {
        contact: true,
        messages: { orderBy: { createdAt: "asc" }, take: 200 },
      },
    });
  });

  app.post("/v1/tenants/:tenantId/conversations/:id/takeover", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    await assertMembership(user.id, tenantId, "inbox:takeover");
    return prisma.conversation.update({
      where: { id },
      data: { status: "HUMAN_TAKEOVER", takenOverByUserId: user.id },
    });
  });

  app.post("/v1/tenants/:tenantId/conversations/:id/release", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    await assertMembership(user.id, tenantId, "inbox:takeover");
    return prisma.conversation.update({
      where: { id },
      data: { status: "AI_ACTIVE", takenOverByUserId: null },
    });
  });

  app.post("/v1/tenants/:tenantId/conversations/:id/reply", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    await assertMembership(user.id, tenantId, "inbox:takeover");
    const body = z.object({ text: z.string().min(1) }).parse(req.body);
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { id, tenantId },
      include: { contact: true, whatsappAccount: true },
    });
    const token = resolveWhatsappAccessToken(
      conversation.whatsappAccount.accessTokenEnc,
    );
    const sent = await whatsapp.sendText(
      {
        accessToken: token,
        phoneNumberId: conversation.whatsappAccount.phoneNumberId,
      },
      { toWaId: conversation.contact.waId, body: body.text },
    );
    return prisma.message.create({
      data: {
        tenantId,
        conversationId: id,
        direction: "OUTBOUND",
        status: "SENT",
        waMessageId: sent.id,
        bodyText: body.text,
        payload: { human: true, userId: user.id },
      },
    });
  });

  // --- Quotes ---
  app.get("/v1/tenants/:tenantId/quotes", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "quotes:read");
    return prisma.quote.findMany({
      where: { tenantId },
      include: { lines: true, contact: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  app.post("/v1/tenants/:tenantId/quotes/:quoteId/approve", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId, quoteId } = req.params as {
      tenantId: string;
      quoteId: string;
    };
    await assertMembership(user.id, tenantId, "quotes:approve");
    const quote = await prisma.quote.findFirstOrThrow({
      where: { id: quoteId, tenantId },
    });
    if (quote.status !== "PENDING_APPROVAL" && quote.status !== "DRAFT") {
      throw new AppError("invalid_state", "Quote cannot be approved", 400);
    }
    return prisma.quote.update({
      where: { id: quoteId },
      data: { status: "DRAFT" },
    });
  });

  app.post("/v1/tenants/:tenantId/quotes/:quoteId/send", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId, quoteId } = req.params as {
      tenantId: string;
      quoteId: string;
    };
    await assertMembership(user.id, tenantId, "quotes:write");
    await quoteSendQueue.add(
      "send",
      { tenantId, quoteId },
      { removeOnComplete: 1000, jobId: `quote-send:${quoteId}` },
    );
    return { queued: true, quoteId };
  });

  app.get("/v1/tenants/:tenantId/quotes/:quoteId/document", async (req, reply) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId, quoteId } = req.params as {
      tenantId: string;
      quoteId: string;
    };
    await assertMembership(user.id, tenantId, "quotes:read");
    const quote = await prisma.quote.findFirstOrThrow({
      where: { id: quoteId, tenantId },
      include: { lines: true, contact: true },
    });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const html = renderQuoteHtml({
      tenantName: tenant.name,
      quoteNumber: quote.number,
      currency: quote.currency,
      customerName: quote.contact.profileName ?? quote.contact.waId,
      notes: quote.notes,
      lines: quote.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitCents: l.unitCents,
        totalCents: l.totalCents,
      })),
      subtotalCents: quote.subtotalCents,
      taxCents: quote.taxCents,
      totalCents: quote.totalCents,
    });
    return reply.type("text/html").send(html);
  });

  // --- Billing ---
  app.post("/v1/tenants/:tenantId/billing/checkout", async (req) => {
    const user = requireUser(req as { user?: AuthedUser | null });
    const { tenantId } = req.params as { tenantId: string };
    await assertMembership(user.id, tenantId, "billing:manage");
    const body = z
      .object({ planKey: z.enum(["starter", "growth", "scale"]) })
      .parse(req.body);
    const sub = await prisma.subscription.findUnique({ where: { tenantId } });
    return billing.createCheckoutSession({
      tenantId,
      planKey: body.planKey,
      customerEmail: user.email,
      successUrl: `${WEB_URL}/billing/success`,
      cancelUrl: `${WEB_URL}/dashboard/billing`,
      stripeCustomerId: sub?.providerCustomerId ?? undefined,
    });
  });

  app.post("/v1/billing/webhook", async (req, reply) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return reply.status(200).send({ ok: true, stub: true });
    }
    const sig = req.headers["stripe-signature"] as string | undefined;
    if (!sig) throw new AppError("invalid_signature", "Missing Stripe signature", 400);
    const raw = Buffer.from(JSON.stringify(req.body));
    const event = billing.constructWebhookEvent(raw, sig);

    if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.created"
    ) {
      const sub = event.data.object as {
        id: string;
        customer: string;
        status: string;
        cancel_at_period_end?: boolean;
        current_period_end?: number;
        metadata?: { tenantId?: string; planKey?: string };
      };
      const tenantId = sub.metadata?.tenantId;
      if (tenantId) {
        const statusMap: Record<string, "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELLED" | "UNPAID" | "INCOMPLETE"> = {
          active: "ACTIVE",
          trialing: "TRIALING",
          past_due: "PAST_DUE",
          canceled: "CANCELLED",
          unpaid: "UNPAID",
          incomplete: "INCOMPLETE",
        };
        await prisma.subscription.update({
          where: { tenantId },
          data: {
            providerSubscriptionId: sub.id,
            providerCustomerId: String(sub.customer),
            status: statusMap[sub.status] ?? "ACTIVE",
            planKey: sub.metadata?.planKey ?? "starter",
            cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
            currentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000)
              : undefined,
          },
        });
      }
    }
    return { received: true };
  });

  // --- Meta WhatsApp webhooks ---
  app.get("/v1/whatsapp/webhook", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (
      q["hub.mode"] === "subscribe" &&
      q["hub.verify_token"] ===
        (process.env.WHATSAPP_VERIFY_TOKEN ?? "autoquote-dev-verify-token")
    ) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.status(403).send("Forbidden");
  });

  app.post("/v1/whatsapp/webhook", async (req, reply) => {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (appSecret && process.env.NODE_ENV === "production") {
      const raw = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
      const sig = req.headers["x-hub-signature-256"] as string | undefined;
      if (!verifyMetaSignature(raw, sig, appSecret)) {
        throw new AppError("invalid_signature", "Bad WhatsApp signature", 401);
      }
    }

    const { messages: inbound, statuses } = whatsapp.parseWebhook(req.body);

    // Delivery receipts: advance stored message status (sent→delivered→read, or failed).
    const statusRank: Record<string, number> = {
      QUEUED: 0,
      SENT: 1,
      DELIVERED: 2,
      READ: 3,
    };
    const statusMap: Record<string, "SENT" | "DELIVERED" | "READ" | "FAILED"> = {
      sent: "SENT",
      delivered: "DELIVERED",
      read: "READ",
      failed: "FAILED",
    };
    for (const s of statuses) {
      const mapped = statusMap[s.status];
      if (!mapped) continue;
      const existing = await prisma.message.findUnique({
        where: { waMessageId: s.waMessageId },
      });
      if (!existing) continue;
      // Never regress a status (e.g. a late "sent" after "read"); failures always apply.
      if (
        mapped !== "FAILED" &&
        (statusRank[existing.status] ?? -1) >= (statusRank[mapped] ?? 0)
      ) {
        continue;
      }
      await prisma.message.update({
        where: { id: existing.id },
        data: {
          status: mapped,
          payload: {
            ...((existing.payload ?? {}) as object),
            ...(mapped === "FAILED"
              ? { error: { code: s.errorCode, title: s.errorTitle } }
              : {}),
          },
        },
      });
    }

    for (const msg of inbound) {
      const account = await prisma.whatsappAccount.findFirst({
        where: { phoneNumberId: msg.phoneNumberId, isActive: true },
      });
      if (!account) {
        req.log.warn({ phoneNumberId: msg.phoneNumberId }, "Unknown WhatsApp number");
        continue;
      }
      const existing = await prisma.message.findUnique({
        where: { waMessageId: msg.waMessageId },
      });
      if (existing) continue;

      const contact = await prisma.contact.upsert({
        where: {
          tenantId_waId: { tenantId: account.tenantId, waId: msg.fromWaId },
        },
        create: {
          tenantId: account.tenantId,
          waId: msg.fromWaId,
          profileName: msg.profileName,
          phoneE164: `+${msg.fromWaId}`,
        },
        update: { profileName: msg.profileName ?? undefined },
      });

      const conversation = await prisma.conversation.upsert({
        where: {
          tenantId_contactId_whatsappAccountId: {
            tenantId: account.tenantId,
            contactId: contact.id,
            whatsappAccountId: account.id,
          },
        },
        create: {
          tenantId: account.tenantId,
          contactId: contact.id,
          whatsappAccountId: account.id,
          lastMessageAt: new Date(),
        },
        update: { lastMessageAt: new Date() },
      });

      const saved = await prisma.message.create({
        data: {
          tenantId: account.tenantId,
          conversationId: conversation.id,
          direction: "INBOUND",
          status: "RECEIVED",
          waMessageId: msg.waMessageId,
          bodyText: msg.text,
          mediaUrl: msg.media?.id ? `wa-media:${msg.media.id}` : undefined,
          payload: {
            type: msg.type,
            ...(msg.media ? { media: msg.media } : {}),
            ...(msg.interactive ? { interactive: msg.interactive } : {}),
            ...(msg.location ? { location: msg.location } : {}),
            ...(msg.contextMessageId ? { replyTo: msg.contextMessageId } : {}),
            raw: msg.raw,
          },
        },
      });

      await conversationQueue.add(
        "process",
        {
          tenantId: account.tenantId,
          conversationId: conversation.id,
          messageId: saved.id,
        },
        {
          removeOnComplete: 1000,
          removeOnFail: 5000,
          jobId: `msg:${msg.waMessageId}`,
        },
      );
    }

    return reply.status(200).send({ ok: true });
  });

  return app;
}

const app = await buildServer();
await app.listen({ port: PORT, host: "0.0.0.0" });
