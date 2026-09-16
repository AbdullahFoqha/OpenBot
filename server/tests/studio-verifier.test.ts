import { describe, expect, test } from "bun:test";
import {
  STUDIO_VERIFIER_BOT_ID,
  buildVerifierWorkerPrompt,
  isStudioVerifierBot,
} from "../src/studio/studio-verifier";

describe("studio verifier P1.5", () => {
  test("bot id and predicate", () => {
    expect(STUDIO_VERIFIER_BOT_ID).toBe("studio-verifier");
    expect(isStudioVerifierBot("studio-verifier")).toBe(true);
    expect(isStudioVerifierBot("quality-engineer")).toBe(false);
  });

  test("worker prompt forbids feature implement", () => {
    const prompt = buildVerifierWorkerPrompt({
      goal: "Claim X",
      acceptanceCriteria: "file exists",
      verifyHint: "\n\n- `npm test`",
    });
    expect(prompt.toLowerCase()).toContain("do not implement");
    expect(prompt).toContain("Verdict");
    expect(prompt).toContain("Claim X");
  });
});
