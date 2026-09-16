/**
 * Remove a single studio task worktree after the run is terminal.
 *
 * Gated by STUDIO_PRUNE_ON_COMPLETE (default ON). Set to 0/false/off to skip.
 * Never removes anything while the task is still in_progress.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const TERMINAL_PRUNE_STATES = new Set([
  "in_review",
  "integrated",
  "blocked",
  "interrupted",
  "failed",
  "done",
]);

export function isPruneOnCompleteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.STUDIO_PRUNE_ON_COMPLETE ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export type PruneWorktreeResult = {
  pruned: boolean;
  reason: string;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveMainRepo(worktreePath: string): Promise<string | null> {
  const gitfile = resolve(worktreePath, ".git");
  try {
    const text = await readFile(gitfile, "utf8");
    const line = text.split("\n").find((l) => l.startsWith("gitdir:"));
    if (!line) return null;
    const gitdir = line.slice("gitdir:".length).trim();
    // .../repo/.git/worktrees/<name> → repo
    return dirname(dirname(dirname(gitdir)));
  } catch {
    return null;
  }
}

function runGit(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => {
      output += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      output += c.toString("utf8");
    });
    child.on("close", (code) => resolvePromise({ ok: code === 0, output }));
    child.on("error", (err) =>
      resolvePromise({ ok: false, output: String(err) }),
    );
  });
}

/**
 * Best-effort prune of one `*.studio-worktree` path for a terminal task.
 * Failures are returned as reason — callers should not fail the task on prune errors.
 */
export async function pruneTaskWorktree(input: {
  worktreePath: string | null | undefined;
  state: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PruneWorktreeResult> {
  if (!isPruneOnCompleteEnabled(input.env)) {
    return { pruned: false, reason: "STUDIO_PRUNE_ON_COMPLETE disabled" };
  }
  if (input.state === "in_progress") {
    return { pruned: false, reason: "refusing: task still in_progress" };
  }
  if (!TERMINAL_PRUNE_STATES.has(input.state)) {
    return { pruned: false, reason: `refusing: state ${input.state} not terminal` };
  }
  const worktreePath = (input.worktreePath ?? "").trim();
  if (!worktreePath) {
    return { pruned: false, reason: "no worktreePath" };
  }
  if (!worktreePath.endsWith(".studio-worktree")) {
    return { pruned: false, reason: "path is not a *.studio-worktree" };
  }
  if (!(await pathExists(worktreePath))) {
    return { pruned: false, reason: "worktree already absent" };
  }

  const mainRepo = await resolveMainRepo(worktreePath);
  if (mainRepo && (await pathExists(mainRepo))) {
    const removed = await runGit(
      ["worktree", "remove", "--force", worktreePath],
      mainRepo,
    );
    if (removed.ok) {
      return { pruned: true, reason: "git worktree remove" };
    }
  }

  // Fallback: directory delete if git registration already gone
  const rm = await runGit(["-C", worktreePath, "status"], worktreePath).catch(
    () => ({ ok: false, output: "" }),
  );
  void rm;
  try {
    const { rm: fsRm } = await import("node:fs/promises");
    await fsRm(worktreePath, { recursive: true, force: true });
    return { pruned: true, reason: "rm fallback" };
  } catch (err) {
    return { pruned: false, reason: `remove failed: ${String(err)}` };
  }
}
