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

/**
 * Optional Cursor-subscription chat bots. Empty by default: Studio chat uses the
 * Claude control-model (reliable tool loops). Pick Cursor per-channel in the UI.
 */
const CURSOR_CHAT_BOT_IDS = new Set<string>([]);

/** Explicit Claude chat bots (control-model / Claude Agent SDK). */
const CLAUDE_CHAT_BOT_IDS = new Set<string>([
  "studio-lead",
  "product-researcher",
  "technical-lead",
  "react-native-engineer",
  "quality-engineer",
  "studio-verifier",
  "product-designer",
]);

/**
 * Resolve which chat backend a built_in bot should use.
 * Default Claude — Cursor CLI chat is opt-in via the channel model picker.
 */
export function harnessForBot(botId: string): BotHarness {
  const id = botId.trim();
  if (CURSOR_CHAT_BOT_IDS.has(id)) {
    return { kind: "cursor", model: CURSOR_CHAT_MODEL };
  }
  if (CLAUDE_CHAT_BOT_IDS.has(id)) {
    return { kind: "claude", model: CLAUDE_CHAT_MODEL };
  }
  return { kind: "claude", model: CLAUDE_CHAT_MODEL };
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
