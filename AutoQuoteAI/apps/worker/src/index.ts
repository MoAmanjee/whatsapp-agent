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

import { Worker } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { prisma } from "@autoquoteai/db";
import {
  QUEUE_NAMES,
  type ConversationProcessJob,
  type QuoteSendJob,
} from "@autoquoteai/shared";
import {
  createQuoteDraft,
  registerAllIndustries,
  resolveWhatsappAccessToken,
  searchCatalogForTenant,
} from "@autoquoteai/core";
import { getIndustry } from "@autoquoteai/industry-sdk";
import { runQuoteSalesWorkflow, createLlm } from "@autoquoteai/ai";
import { createWhatsappProvider } from "@autoquoteai/whatsapp";
import {
  formatQuoteWhatsappText,
  writeQuoteDocument,
} from "@autoquoteai/quotes";

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

registerAllIndustries();

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const whatsapp = createWhatsappProvider();
const llm = createLlm();
if (llm) {
  console.info(`[worker] LLM enabled: ${llm.provider}`);
} else {
  console.info("[worker] LLM disabled — using deterministic extraction");
}

async function processConversation(job: ConversationProcessJob) {
  const { tenantId, conversationId, messageId } = job;

  const conversation = await prisma.conversation.findFirstOrThrow({
    where: { id: conversationId, tenantId },
    include: {
      contact: true,
      whatsappAccount: true,
      tenant: true,
    },
  });

  if (conversation.status === "HUMAN_TAKEOVER" || conversation.status === "CLOSED") {
    return { skipped: true, reason: conversation.status };
  }

  const message = await prisma.message.findFirstOrThrow({
    where: { id: messageId, tenantId },
  });

  const industry = getIndustry(conversation.tenant.industryKey);
  const settings = (conversation.tenant.settings ?? {}) as {
    requireQuoteApproval?: boolean;
  };

  const aiRun = await prisma.aiRun.create({
    data: {
      tenantId,
      conversationId,
      workflowKey: "quote_sales",
      status: "RUNNING",
      input: { messageId, text: message.bodyText },
    },
  });

  try {
    const result = await runQuoteSalesWorkflow({
      tenantId,
      currency: conversation.tenant.currency,
      locale: conversation.tenant.locale,
      customerText: message.bodyText ?? "",
      slots: (conversation.slots ?? {}) as Record<string, unknown>,
      industry,
      requireQuoteApproval: Boolean(settings.requireQuoteApproval),
      llm,
      businessName: conversation.tenant.name,
      tools: {
        searchCatalog: (hints) => searchCatalogForTenant(tenantId, hints),
        createQuote: async (input) => {
          const quote = await createQuoteDraft({
            tenantId,
            contactId: conversation.contactId,
            conversationId,
            currency: conversation.tenant.currency,
            lines: input.lines,
            notes: input.notes,
          });
          if (settings.requireQuoteApproval) {
            await prisma.quote.update({
              where: { id: quote.id },
              data: { status: "PENDING_APPROVAL" },
            });
          }
          return {
            quoteId: quote.id,
            number: quote.number,
            totalCents: quote.totalCents,
          };
        },
        escalateToHuman: async (reason) => {
          const prev = (conversation.slots ?? {}) as Record<string, unknown>;
          await prisma.conversation.update({
            where: { id: conversationId },
            data: {
              status: "HUMAN_TAKEOVER",
              slots: { ...prev, escalateReason: reason },
            },
          });
        },
      },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        slots: toJson(result.slots),
        status:
          result.action === "escalated"
            ? "HUMAN_TAKEOVER"
            : result.action === "quote_pending_approval"
              ? "AWAITING_APPROVAL"
              : "AI_ACTIVE",
      },
    });

    const accessToken = resolveWhatsappAccessToken(
      conversation.whatsappAccount.accessTokenEnc,
    );

    const sent = await whatsapp.sendText(
      {
        accessToken,
        phoneNumberId: conversation.whatsappAccount.phoneNumberId,
      },
      {
        toWaId: conversation.contact.waId,
        body: result.replyText,
      },
    );

    await prisma.message.create({
      data: {
        tenantId,
        conversationId,
        direction: "OUTBOUND",
        status: "SENT",
        waMessageId: sent.id,
        bodyText: result.replyText,
        payload: { quoteId: result.quoteId, action: result.action },
      },
    });

    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: {
        status: "SUCCEEDED",
        output: toJson(result),
        trace: toJson(result.trace),
        finishedAt: new Date(),
      },
    });

    return result;
  } catch (err) {
    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: {
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      },
    });
    throw err;
  }
}

async function processQuoteSend(job: QuoteSendJob) {
  const { tenantId, quoteId } = job;
  const quote = await prisma.quote.findFirstOrThrow({
    where: { id: quoteId, tenantId },
    include: {
      lines: true,
      contact: true,
      conversation: { include: { whatsappAccount: true } },
    },
  });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

  const docInput = {
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
  };

  const objectKey = `quotes/${tenantId}/${quote.number}.html`;
  await writeQuoteDocument(docInput, objectKey);

  const account =
    quote.conversation?.whatsappAccount ??
    (await prisma.whatsappAccount.findFirst({
      where: { tenantId, isActive: true },
    }));

  if (!account) {
    throw new Error("No WhatsApp account to send quote");
  }

  const text = formatQuoteWhatsappText(docInput);
  const sent = await whatsapp.sendText(
    {
      accessToken: resolveWhatsappAccessToken(account.accessTokenEnc),
      phoneNumberId: account.phoneNumberId,
    },
    { toWaId: quote.contact.waId, body: text },
  );

  if (quote.conversationId) {
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: quote.conversationId,
        direction: "OUTBOUND",
        status: "SENT",
        waMessageId: sent.id,
        bodyText: text,
        payload: { quoteId, type: "quote_send" },
      },
    });
  }

  await prisma.quote.update({
    where: { id: quoteId },
    data: {
      status: "SENT",
      sentAt: new Date(),
      pdfObjectKey: objectKey,
    },
  });

  return { sent: true, waMessageId: sent.id };
}

const conversationWorker = new Worker(
  QUEUE_NAMES.conversationProcess,
  async (job) => processConversation(job.data as ConversationProcessJob),
  { connection, concurrency: 5 },
);

const quoteSendWorker = new Worker(
  QUEUE_NAMES.quoteSend,
  async (job) => processQuoteSend(job.data as QuoteSendJob),
  { connection, concurrency: 3 },
);

conversationWorker.on("ready", () => {
  console.info("[worker] conversation.process ready");
});
quoteSendWorker.on("ready", () => {
  console.info("[worker] quote.send ready");
});
conversationWorker.on("failed", (job, err) => {
  console.error("[worker] conversation failed", job?.id, err);
});
quoteSendWorker.on("failed", (job, err) => {
  console.error("[worker] quote send failed", job?.id, err);
});

process.on("SIGINT", async () => {
  await conversationWorker.close();
  await quoteSendWorker.close();
  await connection.quit();
  process.exit(0);
});
