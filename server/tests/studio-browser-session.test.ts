import { describe, expect, test } from "bun:test";
import {
  browserEvidenceRoot,
  browserProfileDir,
  getBrowserSession,
  stopBrowserSession,
} from "../src/studio/browser-session";

describe("browser-session paths", () => {
  test("profile and evidence dirs live under studio-local", () => {
    expect(browserProfileDir()).toContain("studio-local/browser-profile");
    expect(browserEvidenceRoot()).toContain("studio-local/ui-test/out/browser");
  });

  test("stop without a session is ok", async () => {
    const result = await stopBrowserSession();
    expect(result.ok).toBe(true);
    // may be null or a prior stopped session from other tests
    const s = getBrowserSession();
    if (s) expect(["stopped", "error", "running", "starting", "stopping"]).toContain(s.status);
  });
});
