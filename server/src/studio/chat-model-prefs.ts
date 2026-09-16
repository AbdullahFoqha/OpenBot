/**
 * Per-channel Studio chat model preference (Cursor subscription vs Claude OAuth).
 *
 * Encoded OpenAI `model` field: `cursor:<id>` | `claude:<id>` so Cursor's `claude-*`
 * ids never collide with native Anthropic ids on the dual router.
 *
 * Durable store: `studio_channel_chat_models` (ensured via CREATE TABLE IF NOT EXISTS).
 * Fallback file `studio-local/chat-model-prefs.json` is only used when no database is wired.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  intelligenceChannelMappings,
  studioChannelChatModels,
} from "../db/schema";
import { chatModelForBot } from "./bot-harness";

export type ChatModelProvider = "cursor" | "claude";

export type ChatModelPreference = {
  provider: ChatModelProvider;
  modelId: string;
  /** Encoded form for the OpenAI `model` field. */
  encoded: string;
  updatedAt?: string;
};

export type ListedModel = {
  id: string;
  label: string;
  provider: ChatModelProvider;
};

const CURSOR_PREFIX = "cursor:";
const CLAUDE_PREFIX = "claude:";

/** Static curated Anthropic models for the control-model Claude SDK path. */
export const CLAUDE_CHAT_MODELS: ListedModel[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "claude" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "claude" },
  { id: "claude-opus-4-1", label: "Claude Opus 4.1", provider: "claude" },
  { id: "claude-opus-4", label: "Claude Opus 4", provider: "claude" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4", provider: "claude" },
];

/**
 * Fallback when `cursor-agent --list-models` is unavailable.
 * Includes Cursor Claude models and other paid ids the Lead channel must be able to pick.
 */
export const CURSOR_CHAT_MODELS_FALLBACK: ListedModel[] = [
  { id: "cursor-grok-4.6-high", label: "Cursor Grok 4.6 (high)", provider: "cursor" },
  {
    id: "claude-sonnet-5-thinking-high",
    label: "Cursor Claude Sonnet 5 Thinking (high)",
    provider: "cursor",
  },
  {
    id: "claude-opus-4-thinking-high",
    label: "Cursor Claude Opus 4 Thinking (high)",
    provider: "cursor",
  },
  {
    id: "claude-4.5-sonnet-thinking-high",
    label: "Cursor Claude 4.5 Sonnet Thinking (high)",
    provider: "cursor",
  },
  { id: "gpt-5.2-high", label: "GPT-5.2 (high)", provider: "cursor" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash", provider: "cursor" },
];

export function encodeChatModel(
  provider: ChatModelProvider,
  modelId: string,
): string {
  const id = modelId.trim();
  if (!id) throw new Error("modelId is required");
  if (provider === "cursor") return `${CURSOR_PREFIX}${id}`;
  if (provider === "claude") return `${CLAUDE_PREFIX}${id}`;
  throw new Error(`Unknown provider: ${provider}`);
}

export function decodeChatModel(encoded: string): {
  provider: ChatModelProvider;
  modelId: string;
} | null {
  const m = encoded.trim();
  if (m.startsWith(CURSOR_PREFIX)) {
    const modelId = m.slice(CURSOR_PREFIX.length).trim();
    return modelId ? { provider: "cursor", modelId } : null;
  }
  if (m.startsWith(CLAUDE_PREFIX)) {
    const modelId = m.slice(CLAUDE_PREFIX.length).trim();
    return modelId ? { provider: "claude", modelId } : null;
  }
  return null;
}

/**
 * Dual-router classification with back-compat for bare `cursor-grok-*` → cursor
 * and bare package defaults like `claude-haiku-4-5` → claude.
 */
export function classifyChatModel(model: string | undefined): {
  provider: ChatModelProvider;
  modelId: string;
} {
  const m = (model ?? "").trim();
  const decoded = decodeChatModel(m);
  if (decoded) return decoded;
  const lower = m.toLowerCase();
  if (lower.startsWith("cursor-grok") || lower === "cursor-grok-4.6-high") {
    return { provider: "cursor", modelId: m || "cursor-grok-4.6-high" };
  }
  if (!m) {
    return { provider: "claude", modelId: "claude-haiku-4-5" };
  }
  // Bare Anthropic / package default ids.
  return { provider: "claude", modelId: m };
}

export function listClaudeModels(): ListedModel[] {
  return [...CLAUDE_CHAT_MODELS];
}

function runCursorListModels(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("cursor-agent", ["--list-models"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      out += c;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

/** Parse `cursor-agent --list-models` output (one id per line, or JSON array). */
export function parseCursorListModelsOutput(raw: string): ListedModel[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (typeof entry === "string") {
            return {
              id: entry,
              label: entry,
              provider: "cursor" as const,
            };
          }
          if (entry && typeof entry === "object") {
            const id =
              typeof (entry as { id?: unknown }).id === "string"
                ? (entry as { id: string }).id
                : typeof (entry as { model?: unknown }).model === "string"
                  ? (entry as { model: string }).model
                  : null;
            if (!id) return null;
            const label =
              typeof (entry as { name?: unknown }).name === "string"
                ? (entry as { name: string }).name
                : typeof (entry as { label?: unknown }).label === "string"
                  ? (entry as { label: string }).label
                  : id;
            return { id, label, provider: "cursor" as const };
          }
          return null;
        })
        .filter((x): x is ListedModel => x !== null);
    }
  } catch {
    // line-oriented fallback
  }
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("#") && !/^models?:/i.test(l));
  return lines.map((id) => {
    // "id — description" or "id: description"
    const m = id.match(/^([^\s—:\[]+)(?:\s*[—:-]\s*(.+))?$/);
    const modelId = (m?.[1] ?? id).trim();
    const label = (m?.[2] ?? modelId).trim();
    return { id: modelId, label, provider: "cursor" as const };
  });
}

export async function listCursorModels(): Promise<ListedModel[]> {
  const raw = await runCursorListModels();
  if (raw) {
    const listed = parseCursorListModelsOutput(raw);
    if (listed.length > 0) return listed;
  }
  return [...CURSOR_CHAT_MODELS_FALLBACK];
}

// --- preference store ---

type FileStore = {
  /** userId → channelId → preference */
  byUser: Record<
    string,
    Record<string, { provider: ChatModelProvider; modelId: string; updatedAt: string }>
  >;
};

function prefsFilePath(): string {
  return (
    process.env.STUDIO_CHAT_MODEL_PREFS_PATH?.trim() ||
    join(process.cwd(), "studio-local", "chat-model-prefs.json")
  );
}

async function readFileStore(): Promise<FileStore> {
  try {
    const raw = await readFile(prefsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as FileStore;
    return parsed?.byUser ? parsed : { byUser: {} };
  } catch {
    return { byUser: {} };
  }
}

async function writeFileStore(store: FileStore): Promise<void> {
  const path = prefsFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

let tableEnsured = false;

async function ensureTable(database: Database): Promise<void> {
  if (tableEnsured) return;
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS studio_channel_chat_models (
      user_id text NOT NULL,
      channel_id text NOT NULL,
      provider text NOT NULL,
      model_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, channel_id)
    )
  `);
  tableEnsured = true;
}

export type ChatModelPrefsStore = {
  get: (
    userId: string,
    channelId: string,
  ) => Promise<ChatModelPreference | null>;
  set: (
    userId: string,
    channelId: string,
    provider: ChatModelProvider,
    modelId: string,
  ) => Promise<ChatModelPreference>;
  /** Preference for a channel, or null → caller uses chatModelForBot default. */
  encodedForChannel: (
    userId: string,
    channelId: string,
  ) => Promise<string | null>;
};

export function createChatModelPrefsStore(
  database?: Database | null,
): ChatModelPrefsStore {
  return {
    async get(userId, channelId) {
      if (database) {
        await ensureTable(database);
        const [row] = await database
          .select()
          .from(studioChannelChatModels)
          .where(
            and(
              eq(studioChannelChatModels.userId, userId),
              eq(studioChannelChatModels.channelId, channelId),
            ),
          )
          .limit(1);
        if (!row) return null;
        const provider = row.provider === "claude" ? "claude" : "cursor";
        return {
          provider,
          modelId: row.modelId,
          encoded: encodeChatModel(provider, row.modelId),
          updatedAt: row.updatedAt.toISOString(),
        };
      }
      const store = await readFileStore();
      const entry = store.byUser[userId]?.[channelId];
      if (!entry) return null;
      return {
        provider: entry.provider,
        modelId: entry.modelId,
        encoded: encodeChatModel(entry.provider, entry.modelId),
        updatedAt: entry.updatedAt,
      };
    },

    async set(userId, channelId, provider, modelId) {
      const id = modelId.trim();
      if (!id) throw new Error("modelId is required");
      if (provider !== "cursor" && provider !== "claude") {
        throw new Error("provider must be cursor or claude");
      }
      const now = new Date();
      if (database) {
        await ensureTable(database);
        await database
          .insert(studioChannelChatModels)
          .values({
            userId,
            channelId,
            provider,
            modelId: id,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              studioChannelChatModels.userId,
              studioChannelChatModels.channelId,
            ],
            set: { provider, modelId: id, updatedAt: now },
          });
        return {
          provider,
          modelId: id,
          encoded: encodeChatModel(provider, id),
          updatedAt: now.toISOString(),
        };
      }
      const store = await readFileStore();
      if (!store.byUser[userId]) store.byUser[userId] = {};
      store.byUser[userId]![channelId] = {
        provider,
        modelId: id,
        updatedAt: now.toISOString(),
      };
      await writeFileStore(store);
      return {
        provider,
        modelId: id,
        encoded: encodeChatModel(provider, id),
        updatedAt: now.toISOString(),
      };
    },

    async encodedForChannel(userId, channelId) {
      const pref = await this.get(userId, channelId);
      return pref?.encoded ?? null;
    },
  };
}

/**
 * Per-request overrides: agentId → encoded model.
 * Set while building built-in agents for a channel turn so channel prefs win over chatModelForBot.
 */
const chatModelOverrideAls = new AsyncLocalStorage<Map<string, string>>();

export function withChatModelOverrides<T>(
  overrides: Map<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  return chatModelOverrideAls.run(overrides, fn);
}

/**
 * Model string for createOpenAI().chat(...).
 * Channel preference (via ALS) wins; otherwise chatModelForBot defaults.
 *
 * Limitation: when request context cannot resolve a channel, ALS is empty and defaults apply.
 * Prefer channelId-scoped prefs; agentId alone is not used as a store key.
 */
export function resolveBuiltInChatModel(
  botId: string,
  claudeDefault?: string | null,
): string {
  const override = chatModelOverrideAls.getStore()?.get(botId);
  if (override) return override;
  return chatModelForBot(botId, claudeDefault);
}

/**
 * Extract a thread id from a Copilot / AG-UI request body (best-effort).
 */
export function threadIdFromRequestBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.threadId === "string" && o.threadId.trim()) return o.threadId.trim();
  if (typeof o.thread_id === "string" && o.thread_id.trim()) return o.thread_id.trim();
  if (o.input && typeof o.input === "object") {
    const input = o.input as Record<string, unknown>;
    if (typeof input.threadId === "string" && input.threadId.trim()) {
      return input.threadId.trim();
    }
  }
  return null;
}


/** Wired once at boot from index.ts (database + channel agent join). */
export type ChatModelOverrideLoader = (
  actorId: string,
  threadId: string,
) => Promise<Map<string, string>>;

let chatModelOverrideLoader: ChatModelOverrideLoader | null = null;

export function setChatModelOverrideLoader(
  loader: ChatModelOverrideLoader | null,
): void {
  chatModelOverrideLoader = loader;
}

export function getChatModelOverrideLoader(): ChatModelOverrideLoader | null {
  return chatModelOverrideLoader;
}

/**
 * Build agentId → encoded model map for a thread's channel preference.
 * Prefer channelId-scoped prefs; applied to every agent seated on that channel.
 */
export async function loadChatModelOverridesForThread(
  database: Database,
  actorId: string,
  threadId: string,
): Promise<Map<string, string>> {
  const store = createChatModelPrefsStore(database);
  const [mapped] = await database
    .select({ channelId: intelligenceChannelMappings.channelId })
    .from(intelligenceChannelMappings)
    .where(
      and(
        eq(intelligenceChannelMappings.userId, actorId),
        eq(intelligenceChannelMappings.threadId, threadId),
      ),
    )
    .limit(1);
  if (!mapped) return new Map();
  const encoded = await store.encodedForChannel(actorId, mapped.channelId);
  if (!encoded) return new Map();
  const agents = await database
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, mapped.channelId));
  const map = new Map<string, string>();
  for (const row of agents) {
    map.set(row.agentId, encoded);
  }
  return map;
}
