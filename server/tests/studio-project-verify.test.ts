import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectVerifyCommands } from "../src/studio/runner";

describe("resolveProjectVerifyCommands", () => {
  test("picks typecheck and test from package.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-verify-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: "jest", typecheck: "tsc -p .", start: "expo start" },
      }),
    );
    const cmds = await resolveProjectVerifyCommands(dir);
    expect(cmds).toEqual([
      ["npm", "run", "typecheck", "--silent"],
      ["npm", "test", "--silent"],
    ]);
  });

  test("returns empty when no package.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-verify-empty-"));
    await mkdir(dir, { recursive: true });
    expect(await resolveProjectVerifyCommands(dir)).toEqual([]);
  });
});
