// Provider-agnostic LLM client used only for (a) structured slot/intent
// extraction from free-text customer messages and (b) natural phrasing of a
// deterministic outcome. It NEVER chooses products or prices — those come
// exclusively from catalog tools in the deterministic workflow.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface Llm {
  readonly provider: "anthropic" | "openai";
  /** Returns raw text completion for a chat. */
  complete(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<{
    text: string;
    tokensIn: number;
    tokensOut: number;
  }>;
}

class AnthropicLlm implements Llm {
  readonly provider = "anthropic" as const;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(messages: ChatMessage[], opts?: { maxTokens?: number }) {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const rest = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts?.maxTokens ?? 512,
        ...(system ? { system } : {}),
        messages: rest,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return {
      text,
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
    };
  }
}

class OpenAiLlm implements Llm {
  readonly provider = "openai" as const;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(messages: ChatMessage[], opts?: { maxTokens?: number }) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts?.maxTokens ?? 512,
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  }
}

/**
 * Returns an Llm if credentials are configured, else null (caller falls back
 * to the deterministic regex path). Anthropic wins if both keys are present,
 * unless LLM_PROVIDER pins one.
 */
export function createLlm(): Llm | null {
  const pin = process.env.LLM_PROVIDER?.toLowerCase();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (pin === "openai" && openaiKey) {
    return new OpenAiLlm(openaiKey, process.env.OPENAI_MODEL ?? "gpt-4o-mini");
  }
  if (pin === "anthropic" && anthropicKey) {
    return new AnthropicLlm(
      anthropicKey,
      process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    );
  }
  if (anthropicKey) {
    return new AnthropicLlm(
      anthropicKey,
      process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    );
  }
  if (openaiKey) {
    return new OpenAiLlm(openaiKey, process.env.OPENAI_MODEL ?? "gpt-4o-mini");
  }
  return null;
}

/** Extract the first JSON object from an LLM response, tolerating fences/prose. */
export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export type SlotExtraction = {
  slots: Record<string, unknown>;
  /** true when the model judges the message off-topic / abusive → escalate. */
  outOfScope?: boolean;
};

/**
 * Ask the LLM to pull structured slot values out of a free-text message.
 * Only fills the fields named in `wantedSlots`; prices/products are never asked for.
 */
export async function llmExtractSlots(
  llm: Llm,
  args: {
    customerText: string;
    currentSlots: Record<string, unknown>;
    wantedSlots: string[];
    industryName: string;
  },
): Promise<SlotExtraction> {
  const sys =
    "You are a sales-intake parser for a WhatsApp quoting agent in the " +
    `${args.industryName} industry. Extract only the requested fields from the ` +
    "customer's message. Never invent values. Never output prices or product " +
    "recommendations. Reply with a single JSON object and nothing else.";

  const user = [
    `Fields to fill (only include those clearly present): ${JSON.stringify(args.wantedSlots)}`,
    `Already known: ${JSON.stringify(args.currentSlots)}`,
    `Customer message: ${JSON.stringify(args.customerText)}`,
    'Respond as {"slots": { ... }, "outOfScope": boolean}. Omit fields not present.',
  ].join("\n");

  const { text } = await llm.complete(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { maxTokens: 300 },
  );

  const parsed = extractJson<SlotExtraction>(text);
  if (!parsed || typeof parsed.slots !== "object" || parsed.slots === null) {
    return { slots: {} };
  }
  return { slots: parsed.slots, outOfScope: Boolean(parsed.outOfScope) };
}

/** Rephrase a deterministic reply in a warmer, on-brand WhatsApp tone. */
export async function llmComposeReply(
  llm: Llm,
  args: { businessName: string; draft: string; locale: string },
): Promise<string> {
  const { text } = await llm.complete(
    [
      {
        role: "system",
        content:
          `You write short, friendly WhatsApp replies for ${args.businessName}. ` +
          `Locale: ${args.locale}. Keep all facts, numbers, prices and quote ` +
          "numbers EXACTLY as given — never change or add figures. One or two " +
          "sentences. No markdown headings.",
      },
      { role: "user", content: `Rewrite this reply:\n${args.draft}` },
    ],
    { maxTokens: 200 },
  );
  const out = text.trim();
  return out.length > 0 ? out : args.draft;
}
