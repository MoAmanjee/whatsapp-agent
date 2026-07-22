import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@autoquoteai/shared";

// ---------------------------------------------------------------------------
// Credentials & config
// ---------------------------------------------------------------------------

export type WhatsappCredentials = {
  accessToken: string;
  phoneNumberId: string;
};

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ---------------------------------------------------------------------------
// Outbound message shapes
// ---------------------------------------------------------------------------

export type OutboundText = {
  toWaId: string;
  body: string;
  /** WhatsApp shows a link preview when true and the body contains a URL. */
  previewUrl?: boolean;
};

export type MediaKind = "image" | "document" | "audio" | "video" | "sticker";

export type OutboundMedia = {
  toWaId: string;
  kind: MediaKind;
  /** Public https link OR a previously-uploaded Meta media id (use `mediaId`). */
  link?: string;
  mediaId?: string;
  caption?: string;
  /** Documents only. */
  filename?: string;
};

export type TemplateComponent = Record<string, unknown>;

export type OutboundTemplate = {
  toWaId: string;
  templateName: string;
  languageCode: string; // e.g. "en_US"
  components?: TemplateComponent[];
};

export type ReplyButton = { id: string; title: string };

export type OutboundButtons = {
  toWaId: string;
  bodyText: string;
  buttons: ReplyButton[]; // max 3 (Meta limit)
  headerText?: string;
  footerText?: string;
};

export type ListRow = { id: string; title: string; description?: string };
export type ListSection = { title?: string; rows: ListRow[] };

export type OutboundList = {
  toWaId: string;
  bodyText: string;
  buttonText: string; // the tappable label that opens the list
  sections: ListSection[];
  headerText?: string;
  footerText?: string;
};

// ---------------------------------------------------------------------------
// Inbound message shapes
// ---------------------------------------------------------------------------

export type InboundMessageType =
  | "text"
  | "image"
  | "document"
  | "audio"
  | "video"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "reaction"
  | "unsupported";

export type InboundMedia = {
  id: string;
  mimeType?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
};

export type InboundLocation = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

export type InboundInteractive = {
  kind: "button_reply" | "list_reply";
  id: string;
  title: string;
  description?: string;
};

export type InboundMessage = {
  waMessageId: string;
  fromWaId: string;
  phoneNumberId: string;
  profileName?: string;
  type: InboundMessageType;
  /** Best-effort human text: body for text, caption for media, chosen option title for interactive. */
  text?: string;
  media?: InboundMedia;
  location?: InboundLocation;
  interactive?: InboundInteractive;
  /** id of the message this one replies to, when present. */
  contextMessageId?: string;
  timestamp?: string;
  raw: unknown;
};

// ---------------------------------------------------------------------------
// Delivery-status receipts (Meta `statuses` array)
// ---------------------------------------------------------------------------

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed" | "deleted";

export type StatusUpdate = {
  waMessageId: string;
  status: DeliveryStatus;
  recipientWaId?: string;
  timestamp?: string;
  errorCode?: number;
  errorTitle?: string;
  raw: unknown;
};

export type ParsedWebhook = {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
};

// ---------------------------------------------------------------------------
// Media download result
// ---------------------------------------------------------------------------

export type DownloadedMedia = {
  data: Buffer;
  contentType: string;
  sha256?: string;
  fileSize?: number;
};

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface WhatsappProvider {
  sendText(creds: WhatsappCredentials, msg: OutboundText): Promise<{ id: string }>;
  sendMedia(creds: WhatsappCredentials, msg: OutboundMedia): Promise<{ id: string }>;
  sendTemplate(
    creds: WhatsappCredentials,
    msg: OutboundTemplate,
  ): Promise<{ id: string }>;
  sendInteractiveButtons(
    creds: WhatsappCredentials,
    msg: OutboundButtons,
  ): Promise<{ id: string }>;
  sendInteractiveList(
    creds: WhatsappCredentials,
    msg: OutboundList,
  ): Promise<{ id: string }>;
  markAsRead(creds: WhatsappCredentials, waMessageId: string): Promise<void>;
  getMediaUrl(
    creds: WhatsappCredentials,
    mediaId: string,
  ): Promise<{ url: string; mimeType?: string; sha256?: string; fileSize?: number }>;
  downloadMedia(
    creds: WhatsappCredentials,
    mediaId: string,
  ): Promise<DownloadedMedia>;
  parseWebhook(payload: unknown): ParsedWebhook;
  /** Back-compat: messages only. */
  parseInbound(payload: unknown): InboundMessage[];
}

// ---------------------------------------------------------------------------
// Meta Cloud API implementation
// ---------------------------------------------------------------------------

export class MetaCloudWhatsappProvider implements WhatsappProvider {
  constructor(private readonly graphBase = GRAPH_BASE) {}

  private async post(
    creds: WhatsappCredentials,
    payload: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const url = `${this.graphBase}/${creds.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new AppError(
        "whatsapp_send_failed",
        `Meta API ${res.status}: ${body}`,
        502,
      );
    }

    const data = (await res.json()) as { messages?: Array<{ id: string }> };
    const id = data.messages?.[0]?.id;
    if (!id) {
      throw new AppError("whatsapp_send_failed", "No message id returned", 502);
    }
    return { id };
  }

  async sendText(creds: WhatsappCredentials, msg: OutboundText) {
    return this.post(creds, {
      to: msg.toWaId,
      type: "text",
      text: { body: msg.body, preview_url: msg.previewUrl ?? false },
    });
  }

  async sendMedia(creds: WhatsappCredentials, msg: OutboundMedia) {
    if (!msg.link && !msg.mediaId) {
      throw new AppError(
        "whatsapp_send_failed",
        "sendMedia requires either link or mediaId",
        400,
      );
    }
    const media: Record<string, unknown> = msg.mediaId
      ? { id: msg.mediaId }
      : { link: msg.link };
    if (msg.caption && msg.kind !== "audio" && msg.kind !== "sticker") {
      media.caption = msg.caption;
    }
    if (msg.filename && msg.kind === "document") {
      media.filename = msg.filename;
    }
    return this.post(creds, {
      to: msg.toWaId,
      type: msg.kind,
      [msg.kind]: media,
    });
  }

  async sendTemplate(creds: WhatsappCredentials, msg: OutboundTemplate) {
    return this.post(creds, {
      to: msg.toWaId,
      type: "template",
      template: {
        name: msg.templateName,
        language: { code: msg.languageCode },
        ...(msg.components ? { components: msg.components } : {}),
      },
    });
  }

  async sendInteractiveButtons(creds: WhatsappCredentials, msg: OutboundButtons) {
    if (msg.buttons.length === 0 || msg.buttons.length > 3) {
      throw new AppError(
        "whatsapp_send_failed",
        "Interactive buttons must be 1-3 items",
        400,
      );
    }
    return this.post(creds, {
      to: msg.toWaId,
      type: "interactive",
      interactive: {
        type: "button",
        ...(msg.headerText
          ? { header: { type: "text", text: msg.headerText } }
          : {}),
        body: { text: msg.bodyText },
        ...(msg.footerText ? { footer: { text: msg.footerText } } : {}),
        action: {
          buttons: msg.buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
  }

  async sendInteractiveList(creds: WhatsappCredentials, msg: OutboundList) {
    return this.post(creds, {
      to: msg.toWaId,
      type: "interactive",
      interactive: {
        type: "list",
        ...(msg.headerText
          ? { header: { type: "text", text: msg.headerText } }
          : {}),
        body: { text: msg.bodyText },
        ...(msg.footerText ? { footer: { text: msg.footerText } } : {}),
        action: {
          button: msg.buttonText,
          sections: msg.sections.map((s) => ({
            ...(s.title ? { title: s.title } : {}),
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          })),
        },
      },
    });
  }

  async markAsRead(creds: WhatsappCredentials, waMessageId: string) {
    const url = `${this.graphBase}/${creds.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: waMessageId,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AppError(
        "whatsapp_mark_read_failed",
        `Meta API ${res.status}: ${body}`,
        502,
      );
    }
  }

  async getMediaUrl(creds: WhatsappCredentials, mediaId: string) {
    const res = await fetch(`${this.graphBase}/${mediaId}`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AppError(
        "whatsapp_media_lookup_failed",
        `Meta API ${res.status}: ${body}`,
        502,
      );
    }
    const data = (await res.json()) as {
      url?: string;
      mime_type?: string;
      sha256?: string;
      file_size?: number;
    };
    if (!data.url) {
      throw new AppError(
        "whatsapp_media_lookup_failed",
        "No media URL returned",
        502,
      );
    }
    return {
      url: data.url,
      mimeType: data.mime_type,
      sha256: data.sha256,
      fileSize: data.file_size,
    };
  }

  async downloadMedia(creds: WhatsappCredentials, mediaId: string) {
    const meta = await this.getMediaUrl(creds, mediaId);
    // Meta media URLs require the bearer token on the download request too.
    const res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AppError(
        "whatsapp_media_download_failed",
        `Media download ${res.status}: ${body}`,
        502,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      data: buf,
      contentType:
        res.headers.get("content-type") ?? meta.mimeType ?? "application/octet-stream",
      sha256: meta.sha256,
      fileSize: meta.fileSize ?? buf.byteLength,
    };
  }

  parseWebhook(payload: unknown): ParsedWebhook {
    return parseWebhookPayload(payload);
  }

  parseInbound(payload: unknown): InboundMessage[] {
    return parseWebhookPayload(payload).messages;
  }
}

// ---------------------------------------------------------------------------
// Shared webhook parser (used by both real and stub providers)
// ---------------------------------------------------------------------------

type RawMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type?: string;
  context?: { id?: string };
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; sha256?: string; caption?: string };
  video?: { id?: string; mime_type?: string; sha256?: string; caption?: string };
  audio?: { id?: string; mime_type?: string; sha256?: string; voice?: boolean };
  sticker?: { id?: string; mime_type?: string; sha256?: string };
  document?: {
    id?: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
    filename?: string;
  };
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  reaction?: { emoji?: string; message_id?: string };
};

type RawStatus = {
  id: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
};

function mediaFrom(
  m: { id?: string; mime_type?: string; sha256?: string; caption?: string; filename?: string } | undefined,
): InboundMedia | undefined {
  if (!m?.id) return undefined;
  return {
    id: m.id,
    mimeType: m.mime_type,
    sha256: m.sha256,
    caption: m.caption,
    filename: m.filename,
  };
}

export function parseWebhookPayload(payload: unknown): ParsedWebhook {
  const root = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          metadata?: { phone_number_id?: string };
          contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
          messages?: RawMessage[];
          statuses?: RawStatus[];
        };
      }>;
    }>;
  };

  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id ?? "";
      const profileName = value.contacts?.[0]?.profile?.name;

      for (const m of value.messages ?? []) {
        const type = (m.type ?? "unsupported") as InboundMessageType;
        const base = {
          waMessageId: m.id,
          fromWaId: m.from,
          phoneNumberId,
          profileName,
          contextMessageId: m.context?.id,
          timestamp: m.timestamp,
          raw: m,
        };

        switch (type) {
          case "text":
            messages.push({ ...base, type, text: m.text?.body });
            break;
          case "image":
            messages.push({
              ...base,
              type,
              media: mediaFrom(m.image),
              text: m.image?.caption,
            });
            break;
          case "video":
            messages.push({
              ...base,
              type,
              media: mediaFrom(m.video),
              text: m.video?.caption,
            });
            break;
          case "audio":
            messages.push({ ...base, type, media: mediaFrom(m.audio) });
            break;
          case "sticker":
            messages.push({ ...base, type, media: mediaFrom(m.sticker) });
            break;
          case "document":
            messages.push({
              ...base,
              type,
              media: mediaFrom(m.document),
              text: m.document?.caption ?? m.document?.filename,
            });
            break;
          case "location":
            messages.push({
              ...base,
              type,
              location:
                m.location?.latitude != null && m.location?.longitude != null
                  ? {
                      latitude: m.location.latitude,
                      longitude: m.location.longitude,
                      name: m.location.name,
                      address: m.location.address,
                    }
                  : undefined,
            });
            break;
          case "button":
            // Quick-reply button from a template message.
            messages.push({ ...base, type, text: m.button?.text });
            break;
          case "interactive": {
            const ir = m.interactive;
            if (ir?.button_reply) {
              messages.push({
                ...base,
                type,
                text: ir.button_reply.title,
                interactive: {
                  kind: "button_reply",
                  id: ir.button_reply.id ?? "",
                  title: ir.button_reply.title ?? "",
                },
              });
            } else if (ir?.list_reply) {
              messages.push({
                ...base,
                type,
                text: ir.list_reply.title,
                interactive: {
                  kind: "list_reply",
                  id: ir.list_reply.id ?? "",
                  title: ir.list_reply.title ?? "",
                  description: ir.list_reply.description,
                },
              });
            } else {
              messages.push({ ...base, type: "unsupported" });
            }
            break;
          }
          default:
            messages.push({ ...base, type: "unsupported" });
        }
      }

      for (const s of value.statuses ?? []) {
        statuses.push({
          waMessageId: s.id,
          status: (s.status ?? "sent") as DeliveryStatus,
          recipientWaId: s.recipient_id,
          timestamp: s.timestamp,
          errorCode: s.errors?.[0]?.code,
          errorTitle: s.errors?.[0]?.title ?? s.errors?.[0]?.message,
          raw: s,
        });
      }
    }
  }

  return { messages, statuses };
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Meta X-Hub-Signature-256)
// ---------------------------------------------------------------------------

export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
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

// ---------------------------------------------------------------------------
// Dev stub — logs instead of calling Meta. Parsing is identical to real.
// ---------------------------------------------------------------------------

export class StubWhatsappProvider implements WhatsappProvider {
  private log(kind: string, detail: Record<string, unknown>): { id: string } {
    const id = `stub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.info(`[whatsapp:stub] ${kind}`, { ...detail, id });
    return { id };
  }

  async sendText(_c: WhatsappCredentials, msg: OutboundText) {
    return this.log("text", { to: msg.toWaId, body: msg.body });
  }
  async sendMedia(_c: WhatsappCredentials, msg: OutboundMedia) {
    return this.log("media", { to: msg.toWaId, kind: msg.kind, link: msg.link });
  }
  async sendTemplate(_c: WhatsappCredentials, msg: OutboundTemplate) {
    return this.log("template", { to: msg.toWaId, template: msg.templateName });
  }
  async sendInteractiveButtons(_c: WhatsappCredentials, msg: OutboundButtons) {
    return this.log("buttons", { to: msg.toWaId, buttons: msg.buttons.length });
  }
  async sendInteractiveList(_c: WhatsappCredentials, msg: OutboundList) {
    return this.log("list", { to: msg.toWaId, sections: msg.sections.length });
  }
  async markAsRead(_c: WhatsappCredentials, waMessageId: string) {
    console.info("[whatsapp:stub] markAsRead", { waMessageId });
  }
  async getMediaUrl(_c: WhatsappCredentials, mediaId: string) {
    return { url: `stub://media/${mediaId}`, mimeType: "application/octet-stream" };
  }
  async downloadMedia(_c: WhatsappCredentials, mediaId: string) {
    return {
      data: Buffer.from(`stub-media:${mediaId}`),
      contentType: "application/octet-stream",
    };
  }
  parseWebhook(payload: unknown): ParsedWebhook {
    return parseWebhookPayload(payload);
  }
  parseInbound(payload: unknown): InboundMessage[] {
    return parseWebhookPayload(payload).messages;
  }
}

export function createWhatsappProvider(): WhatsappProvider {
  if (process.env.WHATSAPP_DEV_ACCESS_TOKEN) {
    return new MetaCloudWhatsappProvider();
  }
  return new StubWhatsappProvider();
}

/** True when Meta credentials are configured (else the stub is in use). */
export function isLiveWhatsapp(): boolean {
  return Boolean(process.env.WHATSAPP_DEV_ACCESS_TOKEN);
}
