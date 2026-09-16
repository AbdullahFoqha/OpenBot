import { describe, expect, test } from "bun:test";
import { CATALOGUE } from "../src/plugins/catalogue";

describe("studio MCP connectors P2.3", () => {
  test("catalogue has stable keys for install UX", () => {
    const keys = CATALOGUE.map((e) => e.key);
    expect(keys).toContain("routines");
    expect(keys).toContain("google-drive");
    expect(keys).toContain("notion");
  });

  test("auth status vocabulary", () => {
    const statuses = [
      "ready",
      "needs_install",
      "needs_auth",
      "needs_public_url",
      "error",
    ] as const;
    expect(statuses).toHaveLength(5);
  });
});
