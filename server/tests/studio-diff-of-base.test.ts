/**
 * A worker that commits its edits must still count as having changed the tree.
 * Regression: diff --cached vs HEAD was empty after commit → false "no changes".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function gitOut(args: string[], cwd: string) {
  return await new Promise<string>((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

describe("studio change detection against base commit", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("committed new file is visible vs base commit, not vs HEAD cached", async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-diff-"));
    await git(["init", "-q"], dir);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base"], dir);
    const base = await gitOut(["rev-parse", "HEAD"], dir);
    await writeFile(join(dir, "new.ts"), "export const X = 1;\n");
    await git(["add", "-A"], dir);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add"], dir);

    const cached = await gitOut(["diff", "--cached", "--name-only"], dir);
    const sinceBase = await gitOut(["diff", "--name-only", base], dir);
    expect(cached).toBe("");
    expect(sinceBase).toContain("new.ts");
  });
});
