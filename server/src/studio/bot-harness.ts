/**
 * Per-bot chat harness: most Studio bots bill Cursor subscription (cursor-agent via
 * the dual router at OPENAI_BASE_URL); product-designer stays on Claude control-model.
 *
 * Coding workers (studio_run_task) are pinned separately in runner.ts via
 * resolveCursorHarnessModel — this file is for Bot *chat* only.
 */
export const CURSOR_CHAT_MODEL = "cursor:cursor-grok-4.6-high" as const;

/**
 * Fallback Claude control-model id when BOT_MODEL / package default is unavailable.
 * Prefer passing the runtime package default into chatModelForBot for designer.
 */
export const CLAUDE_CHAT_MODEL = "claude-haiku-4-5" as const;

export type BotHarnessKind = "cursor" | "claude";

export type BotHarness = {
  kind: BotHarnessKind;
  model: string;
};

/** Built-in (and verifier) bots that should chat on Cursor subscription. */
const CURSOR_CHAT_BOT_IDS = new Set<string>([
  "studio-lead",
  "product-researcher",
  "technical-lead",
  "react-native-engineer",
  "quality-engineer",
  "studio-verifier",
]);

/** Explicit Claude chat bots (control-model / Claude Agent SDK). */
const CLAUDE_CHAT_BOT_IDS = new Set<string>(["product-designer"]);

/**
 * Resolve which chat backend a built_in bot should use.
 * Unknown / dynamic bots default to Cursor so new studio bots do not silently
 * reopen Claude spend.
 */
export function harnessForBot(botId: string): BotHarness {
  const id = botId.trim();
  if (CLAUDE_CHAT_BOT_IDS.has(id)) {
    return { kind: "claude", model: CLAUDE_CHAT_MODEL };
  }
  if (CURSOR_CHAT_BOT_IDS.has(id)) {
    return { kind: "cursor", model: CURSOR_CHAT_MODEL };
  }
  return { kind: "cursor", model: CURSOR_CHAT_MODEL };
}

/**
 * Model string for createOpenAI().chat(...).
 * Claude bots keep `claudeDefault` (package / BOT_MODEL) when provided.
 */
export function chatModelForBot(
  botId: string,
  claudeDefault?: string | null,
): string {
  const harness = harnessForBot(botId);
  if (harness.kind === "claude") {
    const trimmed = claudeDefault?.trim();
    const id = trimmed && trimmed.length > 0 ? trimmed : CLAUDE_CHAT_MODEL;
    return id.startsWith("claude:") || id.startsWith("cursor:")
      ? id
      : `claude:${id}`;
  }
  return harness.model.startsWith("cursor:") || harness.model.startsWith("claude:")
    ? harness.model
    : `cursor:${harness.model}`;
}
