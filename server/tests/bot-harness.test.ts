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
  test("Cursor chat bots map to cursor-grok-4.6-high", () => {
    for (const id of [
      "studio-lead",
      "product-researcher",
      "technical-lead",
      "react-native-engineer",
      "quality-engineer",
      "studio-verifier",
    ]) {
      expect(harnessForBot(id)).toEqual({
        kind: "cursor",
        model: CURSOR_CHAT_MODEL,
      });
      expect(chatModelForBot(id)).toBe(CURSOR_CHAT_MODEL);
    }
  });

  test("product-designer stays on Claude (package default preferred)", () => {
    expect(harnessForBot("product-designer").kind).toBe("claude");
    expect(chatModelForBot("product-designer")).toBe(CLAUDE_CHAT_MODEL);
    expect(chatModelForBot("product-designer", "claude-sonnet-4-5")).toBe(
      "claude-sonnet-4-5",
    );
  });

  test("unknown bots default to Cursor chat", () => {
    expect(harnessForBot("custom-researcher-demo").kind).toBe("cursor");
    expect(chatModelForBot("custom-researcher-demo")).toBe(CURSOR_CHAT_MODEL);
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
