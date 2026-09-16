import { describe, expect, test } from "bun:test";
import {
  desktopEvidenceRoot,
  getDesktopSession,
  stopDesktopSession,
} from "../src/studio/desktop-session";

describe("desktop-session", () => {
  test("evidence dir under studio-local/ui-test/out/desktop", () => {
    expect(desktopEvidenceRoot()).toContain("studio-local/ui-test/out/desktop");
  });

  test("stop without session is ok", async () => {
    const result = await stopDesktopSession();
    expect(result.ok).toBe(true);
    const s = getDesktopSession();
    if (s) expect(["stopped", "error", "running", "starting", "stopping"]).toContain(s.status);
  });
});
