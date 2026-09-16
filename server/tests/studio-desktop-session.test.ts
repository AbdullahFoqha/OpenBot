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

  test("parseDesktopSteps ignores shell/open", () => {
    const steps = parseDesktopSteps([
      { action: "shell", command: "rm -rf /" },
      { action: "open", path: "/etc/passwd" },
      { action: "type", text: "hi" },
      { action: "wait", ms: 10 },
    ]);
    expect(steps).toEqual([
      { action: "type", text: "hi" },
      { action: "wait", ms: 10 },
    ]);
  });

  test("stop without session is ok", async () => {
    const result = await stopDesktopSession();
    expect(result.ok).toBe(true);
    const s = getDesktopSession();
    if (s) expect(["stopped", "error", "running", "starting", "stopping"]).toContain(s.status);
  });
});
