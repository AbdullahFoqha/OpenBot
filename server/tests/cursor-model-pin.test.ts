import { describe, expect, test } from "bun:test";
import {
  ALLOWED_CURSOR_MODELS,
  DEFAULT_MODEL,
  resolveCursorHarnessModel,
} from "../src/studio/runner";

describe("Cursor harness model pin", () => {
  test("default is cursor-grok-4.6-xhigh", () => {
    expect(DEFAULT_MODEL).toBe("cursor-grok-4.6-xhigh");
    expect(ALLOWED_CURSOR_MODELS).toEqual(["cursor-grok-4.6-xhigh"]);
  });

  test("allowlisted passthrough", () => {
    expect(resolveCursorHarnessModel("cursor-grok-4.6-xhigh")).toBe(
      "cursor-grok-4.6-xhigh",
    );
  });

  test("rejects Composer / Auto / Claude / GPT aliases", () => {
    for (const bad of [
      "composer",
      "auto",
      "claude-4-sonnet",
      "gpt-5",
      "cursor-pro",
      "",
      null,
      undefined,
    ]) {
      expect(resolveCursorHarnessModel(bad as string | null | undefined)).toBe(
        DEFAULT_MODEL,
      );
    }
  });
});
