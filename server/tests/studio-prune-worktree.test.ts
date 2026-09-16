import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  isPruneOnCompleteEnabled,
  pruneTaskWorktree,
} from "../src/studio/prune-worktree";

async function git(args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(args.join(" ")))));
    child.on("error", reject);
  });
}

describe("isPruneOnCompleteEnabled", () => {
  test("defaults ON", () => {
    expect(isPruneOnCompleteEnabled({})).toBe(true);
  });
  test("OFF for 0/false/off/no", () => {
    expect(isPruneOnCompleteEnabled({ STUDIO_PRUNE_ON_COMPLETE: "0" })).toBe(false);
    expect(isPruneOnCompleteEnabled({ STUDIO_PRUNE_ON_COMPLETE: "false" })).toBe(false);
    expect(isPruneOnCompleteEnabled({ STUDIO_PRUNE_ON_COMPLETE: "off" })).toBe(false);
  });
  test("ON for 1", () => {
    expect(isPruneOnCompleteEnabled({ STUDIO_PRUNE_ON_COMPLETE: "1" })).toBe(true);
  });
});

describe("pruneTaskWorktree", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("refuses in_progress", async () => {
    const r = await pruneTaskWorktree({
      worktreePath: "/tmp/x.studio-worktree",
      state: "in_progress",
      env: { STUDIO_PRUNE_ON_COMPLETE: "1" },
    });
    expect(r.pruned).toBe(false);
    expect(r.reason).toContain("in_progress");
  });

  test("skips when env disabled", async () => {
    const r = await pruneTaskWorktree({
      worktreePath: "/tmp/x.studio-worktree",
      state: "in_review",
      env: { STUDIO_PRUNE_ON_COMPLETE: "0" },
    });
    expect(r.pruned).toBe(false);
    expect(r.reason).toContain("disabled");
  });

  test("removes a real git worktree when terminal", async () => {
    root = await mkdtemp(join(tmpdir(), "studio-prune-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(["init", "-q"], repo);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base"], repo);
    const wt = join(root, "demo-abcdef.studio-worktree");
    await git(["worktree", "add", "-b", "studio/demo-abcdef", wt], repo);

    const r = await pruneTaskWorktree({
      worktreePath: wt,
      state: "in_review",
      env: { STUDIO_PRUNE_ON_COMPLETE: "1" },
    });
    expect(r.pruned).toBe(true);
    let gone = false;
    try {
      await access(wt);
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
  });
});
