import { describe, expect, test } from "bun:test";
import {
  classifyChatModel,
  decodeChatModel,
  encodeChatModel,
  listClaudeModels,
  parseCursorListModelsOutput,
} from "../src/studio/chat-model-prefs";
import { resolveCursorHarnessModel, DEFAULT_MODEL } from "../src/studio/runner";

describe("encode/decode chat model", () => {
  test("encodes cursor and claude without collision", () => {
    expect(encodeChatModel("cursor", "claude-sonnet-5-thinking-high")).toBe(
      "cursor:claude-sonnet-5-thinking-high",
    );
    expect(encodeChatModel("claude", "claude-haiku-4-5")).toBe(
      "claude:claude-haiku-4-5",
    );
    expect(encodeChatModel("cursor", "cursor-grok-4.6-high")).toBe(
      "cursor:cursor-grok-4.6-high",
    );
  });

  test("decodes prefixed models", () => {
    expect(decodeChatModel("cursor:claude-sonnet-5-thinking-high")).toEqual({
      provider: "cursor",
      modelId: "claude-sonnet-5-thinking-high",
    });
    expect(decodeChatModel("claude:claude-haiku-4-5")).toEqual({
      provider: "claude",
      modelId: "claude-haiku-4-5",
    });
    expect(decodeChatModel("bare-model")).toBeNull();
  });
});

describe("dual router classification", () => {
  test("prefixed cursor claude ids route to cursor", () => {
    expect(classifyChatModel("cursor:claude-sonnet-5-thinking-high")).toEqual({
      provider: "cursor",
      modelId: "claude-sonnet-5-thinking-high",
    });
    expect(classifyChatModel("cursor:cursor-grok-4.6-high")).toEqual({
      provider: "cursor",
      modelId: "cursor-grok-4.6-high",
    });
  });

  test("prefixed native claude routes to claude", () => {
    expect(classifyChatModel("claude:claude-haiku-4-5")).toEqual({
      provider: "claude",
      modelId: "claude-haiku-4-5",
    });
  });

  test("back-compat bare cursor-grok → cursor", () => {
    expect(classifyChatModel("cursor-grok-4.6-high").provider).toBe("cursor");
    expect(classifyChatModel("cursor-grok-4.6-high").modelId).toBe(
      "cursor-grok-4.6-high",
    );
  });

  test("back-compat bare package default → claude", () => {
    expect(classifyChatModel("claude-haiku-4-5")).toEqual({
      provider: "claude",
      modelId: "claude-haiku-4-5",
    });
  });
});

describe("lists", () => {
  test("claude list is curated and non-empty", () => {
    const list = listClaudeModels();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((m) => m.provider === "claude")).toBe(true);
    expect(list.some((m) => m.id === "claude-haiku-4-5")).toBe(true);
  });

  test("parses line-oriented cursor-agent --list-models", () => {
    const parsed = parseCursorListModelsOutput(
      "Available models\n\nauto - Auto (default)\ncursor-grok-4.6-high - Cursor Grok 4.6\nclaude-sonnet-5-thinking-high - Claude Sonnet\n",
    );
    expect(parsed.map((m) => m.id)).not.toContain("Available models");
    expect(parsed.map((m) => m.id)).toContain("auto");
    expect(parsed.map((m) => m.id)).toContain("cursor-grok-4.6-high");
    expect(parsed.map((m) => m.id)).toContain("claude-sonnet-5-thinking-high");
  });
});

describe("coding pin untouched", () => {
  test("resolveCursorHarnessModel still high-only", () => {
    expect(resolveCursorHarnessModel("cursor-grok-4.6-xhigh")).toBe(
      DEFAULT_MODEL,
    );
    expect(resolveCursorHarnessModel("claude-sonnet-5-thinking-high")).toBe(
      DEFAULT_MODEL,
    );
  });
});
