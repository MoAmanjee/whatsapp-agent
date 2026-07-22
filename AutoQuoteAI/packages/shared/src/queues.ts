export const QUEUE_NAMES = {
  conversationProcess: "conversation.process",
  quotePdf: "quote.pdf",
  quoteSend: "quote.send",
  billingSync: "billing.sync",
} as const;

export type ConversationProcessJob = {
  tenantId: string;
  conversationId: string;
  messageId: string;
};

export type QuoteSendJob = {
  tenantId: string;
  quoteId: string;
};
