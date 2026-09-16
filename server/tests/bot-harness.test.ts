import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CHAT_MODEL,
  CURSOR_CHAT_MODEL,
  chatModelForBot,
  harnessForBot,
} from "../src/studio/bot-harness";
import {
  DEFAULT_MODEL,
  resolveCursorHarnessModel,
} from "../src/studio/runner";

describe("bot chat harness map", () => {
  test("built-in Studio bots default to Claude chat", () => {
    for (const id of [
      "studio-lead",
      "product-researcher",
      "technical-lead",
      "react-native-engineer",
      "quality-engineer",
      "studio-verifier",
      "product-designer",
    ]) {
      expect(harnessForBot(id).kind).toBe("claude");
      expect(chatModelForBot(id)).toBe(`claude:${CLAUDE_CHAT_MODEL}`);
    }
  });

  test("product-designer prefers package Claude default when provided", () => {
    expect(chatModelForBot("product-designer", "claude-sonnet-4-5")).toBe(
      "claude:claude-sonnet-4-5",
    );
  });

  test("unknown bots default to Claude chat", () => {
    expect(harnessForBot("custom-researcher-demo").kind).toBe("claude");
    expect(chatModelForBot("custom-researcher-demo")).toBe(
      `claude:${CLAUDE_CHAT_MODEL}`,
    );
  });

  test("CURSOR_CHAT_MODEL encoding remains available for picker", () => {
    expect(CURSOR_CHAT_MODEL.startsWith("cursor:")).toBe(true);
  });
});

describe("coding harness pin still high (not xhigh)", () => {
  test("resolveCursorHarnessModel pins to cursor-grok-4.6-high", () => {
    expect(DEFAULT_MODEL).toBe("cursor-grok-4.6-high");
    expect(resolveCursorHarnessModel("cursor-grok-4.6-high")).toBe(
      "cursor-grok-4.6-high",
    );
    expect(resolveCursorHarnessModel("cursor-grok-4.6-xhigh")).toBe(
      DEFAULT_MODEL,
    );
    expect(resolveCursorHarnessModel("auto")).toBe(DEFAULT_MODEL);
  });
});
