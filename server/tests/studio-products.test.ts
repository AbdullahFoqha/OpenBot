import { describe, expect, test } from "bun:test";
import { resolveProjectPath } from "../src/studio/project-path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function git(args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(args.join(" ")))));
    child.on("error", reject);
  });
}

describe("resolveProjectPath", () => {
  test("rejects relative", async () => {
    const r = await resolveProjectPath("relative/path");
    expect(r.ok).toBe(false);
  });

  test("accepts absolute git root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-prod-"));
    try {
      await git(["init", "-q"], dir);
      await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "b"], dir);
      const r = await resolveProjectPath(dir);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.gitRoot).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
