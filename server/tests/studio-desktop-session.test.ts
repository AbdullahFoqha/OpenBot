import { describe, expect, test } from "bun:test";
import {
  desktopEvidenceRoot,
  parseDesktopSteps,
  stopDesktopSession,
  getDesktopSession,
} from "../src/studio/desktop-session";

describe("desktop-session", () => {
  test("evidence root under studio-local/ui-test/out/desktop", () => {
    expect(desktopEvidenceRoot()).toContain("studio-local/ui-test/out/desktop");
  });

  test("parseDesktopSteps accepts known actions", () => {
    const steps = parseDesktopSteps([
      { action: "wait", ms: 100 },
      { action: "activate", app: "Calculator" },
      { action: "open", app: "TextEdit" },
      { action: "type", text: "hi", app: "TextEdit" },
      { action: "keystroke", text: "2" },
      { action: "click", x: 10, y: 20 },
      { action: "quit", app: "Calculator", saving: "no" },
      { action: "nope" },
    ]);
    expect(steps).toHaveLength(7);
    expect(steps[2]).toEqual({ action: "open", app: "TextEdit" });
  });

  test("stop without session is ok", async () => {
    const result = await stopDesktopSession();
    expect(result.ok).toBe(true);
    const s = getDesktopSession();
    if (s) expect(["stopped", "error", "running", "starting", "stopping"]).toContain(s.status);
  });
});
