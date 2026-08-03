import Anthropic from "@anthropic-ai/sdk";

export type Provider = "anthropic" | "openrouter";

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-opus-5",
  openrouter: "anthropic/claude-opus-5",
};

/** Explicit CARTOGRAPH_LLM_PROVIDER wins; otherwise whichever key is set. */
export function detectProvider(): Provider | null {
  const explicit = process.env.CARTOGRAPH_LLM_PROVIDER;
  if (explicit === "anthropic" || explicit === "openrouter") return explicit;
  if (explicit) throw new Error(`Unknown CARTOGRAPH_LLM_PROVIDER: ${explicit}`);
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return null;
}

// A description pass that never returns is worse than one that fails: the caller in cli.ts
// falls back to rule-based output, but only once the request actually gives up.
const TIMEOUT_MS = 120_000;

export async function generateText(prompt: string): Promise<string> {
  const provider = detectProvider();
  if (!provider) {
    throw new Error("No LLM credentials: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.");
  }
  const model = process.env.CARTOGRAPH_MODEL || DEFAULT_MODEL[provider];

  if (provider === "anthropic") {
    const response = await new Anthropic({ timeout: TIMEOUT_MS }).messages.create({
      model,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error(`Unexpected OpenRouter response: ${JSON.stringify(body).slice(0, 300)}`);
  return text;
}
