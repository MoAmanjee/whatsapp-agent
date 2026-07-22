import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@autoquoteai/shared";

export type WhatsappCredentials = {
  accessToken: string;
  phoneNumberId: string;
};

export type OutboundText = {
  toWaId: string;
  body: string;
};

export type InboundMessage = {
  waMessageId: string;
  fromWaId: string;
  phoneNumberId: string;
  profileName?: string;
  text?: string;
  timestamp?: string;
  raw: unknown;
};

export interface WhatsappProvider {
  sendText(creds: WhatsappCredentials, msg: OutboundText): Promise<{ id: string }>;
  parseInbound(payload: unknown): InboundMessage[];
}

export class MetaCloudWhatsappProvider implements WhatsappProvider {
  constructor(
    private readonly graphBase = "https://graph.facebook.com/v21.0",
  ) {}

  async sendText(
    creds: WhatsappCredentials,
    msg: OutboundText,
  ): Promise<{ id: string }> {
    const url = `${this.graphBase}/${creds.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msg.toWaId,
        type: "text",
        text: { body: msg.body },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new AppError(
        "whatsapp_send_failed",
        `Meta API ${res.status}: ${body}`,
        502,
      );
    }

    const data = (await res.json()) as {
      messages?: Array<{ id: string }>;
    };
    const id = data.messages?.[0]?.id;
    if (!id) {
      throw new AppError("whatsapp_send_failed", "No message id returned", 502);
    }
    return { id };
  }

  parseInbound(payload: unknown): InboundMessage[] {
    const root = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            metadata?: { phone_number_id?: string };
            contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
            messages?: Array<{
              id: string;
              from: string;
              timestamp?: string;
              type?: string;
              text?: { body?: string };
            }>;
          };
        }>;
      }>;
    };

    const out: InboundMessage[] = [];
    for (const entry of root.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages?.length) continue;
        const phoneNumberId = value.metadata?.phone_number_id ?? "";
        const profileName = value.contacts?.[0]?.profile?.name;
        for (const m of value.messages) {
          out.push({
            waMessageId: m.id,
            fromWaId: m.from,
            phoneNumberId,
            profileName,
            text: m.type === "text" ? m.text?.body : undefined,
            timestamp: m.timestamp,
            raw: m,
          });
        }
      }
    }
    return out;
  }
}

export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(received, "utf8"),
    );
  } catch {
    return false;
  }
}

/** Dev stub — logs instead of calling Meta */
export class StubWhatsappProvider implements WhatsappProvider {
  async sendText(
    _creds: WhatsappCredentials,
    msg: OutboundText,
  ): Promise<{ id: string }> {
    const id = `stub_${Date.now()}`;
    console.info("[whatsapp:stub] send", { to: msg.toWaId, body: msg.body, id });
    return { id };
  }

  parseInbound(payload: unknown): InboundMessage[] {
    return new MetaCloudWhatsappProvider().parseInbound(payload);
  }
}

export function createWhatsappProvider(): WhatsappProvider {
  if (process.env.WHATSAPP_DEV_ACCESS_TOKEN) {
    return new MetaCloudWhatsappProvider();
  }
  return new StubWhatsappProvider();
}
