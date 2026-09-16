/**
 * After a successful project task run: record the branch, push it, and open exactly one draft PR
 * through the existing GitHub delivery module (find-before-create).
 *
 * SEPARATE FROM THE CODING TEST. The coding test uses a disposable fixture with no remote and must
 * never call this. Failures here become a blocker on the task/evidence; the worktree and branch are
 * kept so a person can still push by hand.
 */
import { spawn } from "node:child_process";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { studioBranches } from "../db/schema";
import {
  createGitHubDelivery,
  ghRunner,
  type GhRunner,
  type PullRequest,
} from "./github";

export type ProjectDeliveryResult =
  | { ok: true; pull: PullRequest; created: boolean; repository: string; baseBranch: string }
  | { ok: false; reason: string };

function runGit(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ exitCode: null, stdout: "", stderr: String(err) }),
    );
  });
}

/** Resolve owner/name and the trunk branch for this checkout. */
export async function resolveRepository(
  cwd: string,
  gh: GhRunner,
): Promise<
  { ok: true; repository: string; baseBranch: string } | { ok: false; reason: string }
> {
  const viewed = await gh(
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    { cwd },
  );
  if (viewed.exitCode === 0) {
    try {
      const parsed = JSON.parse(viewed.stdout || "{}") as {
        nameWithOwner?: string;
        defaultBranchRef?: { name?: string };
      };
      const repository = parsed.nameWithOwner?.trim();
      const baseBranch = parsed.defaultBranchRef?.name?.trim() || "main";
      if (repository) return { ok: true, repository, baseBranch };
    } catch {
      // fall through to git remotes
    }
  }

  const remote = await runGit(["remote", "get-url", "origin"], cwd);
  if (remote.exitCode !== 0 || !remote.stdout.trim()) {
    return {
      ok: false,
      reason:
        viewed.stderr.trim() ||
        "Could not resolve the GitHub repository for this project (gh repo view failed and origin is missing).",
    };
  }
  const url = remote.stdout.trim();
  const match =
    url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i) ||
    url.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!match?.[1]) {
    return {
      ok: false,
      reason: `origin URL is not a recognizable GitHub repo: ${url}`,
    };
  }
  const head = await runGit(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );
  const baseBranch = head.stdout.trim().replace(/^origin\//, "") || "main";
  return { ok: true, repository: match[1], baseBranch };
}

async function pushBranch(
  cwd: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pushed = await runGit(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], cwd);
  if (pushed.exitCode === 0) return { ok: true };
  return {
    ok: false,
    reason:
      pushed.stderr.trim() ||
      pushed.stdout.trim() ||
      `git push of ${branch} failed.`,
  };
}

/**
 * Record the branch row, push the head, open (or reconcile) one draft PR.
 * Never throws for delivery failures — returns `{ ok: false, reason }`.
 */
export async function deliverProjectDraftPr(input: {
  database: Database;
  taskId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  worktreePath: string;
  branch: string;
  projectPath: string;
  /** Injected in tests. Defaults to the real `gh` CLI. */
  gh?: GhRunner;
  /** Injected in tests to skip a real network push. */
  push?: (cwd: string, branch: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}): Promise<ProjectDeliveryResult> {
  const gh = input.gh ?? ghRunner();
  const repo = await resolveRepository(input.worktreePath, gh);
  if (!repo.ok) return repo;

  const baseCommit = await runGit(["rev-parse", "HEAD"], input.projectPath);
  const commit = baseCommit.stdout.trim() || "unknown";

  await input.database
    .insert(studioBranches)
    .values({
      taskId: input.taskId,
      branch: input.branch,
      baseCommit: commit,
      baseBranch: repo.baseBranch,
      worktreePath: input.worktreePath,
    })
    .onConflictDoUpdate({
      target: studioBranches.taskId,
      set: {
        branch: input.branch,
        baseCommit: commit,
        baseBranch: repo.baseBranch,
        worktreePath: input.worktreePath,
      },
    });

  const push = input.push ?? pushBranch;
  const pushed = await push(input.worktreePath, input.branch);
  if (!pushed.ok) return pushed;

  const body = [
    `## Goal`,
    input.goal,
    ``,
    `## Acceptance criteria`,
    input.acceptanceCriteria || "(none recorded)",
    ``,
    `Opened automatically by OpenBot Product Studio for task \`${input.taskId}\`.`,
    `Draft only — merge stays with you.`,
  ].join("\n");

  const github = createGitHubDelivery(input.database, gh);
  const opened = await github.openDraft({
    taskId: input.taskId,
    repository: repo.repository,
    headBranch: input.branch,
    baseBranch: repo.baseBranch,
    title: input.title,
    body,
    cwd: input.worktreePath,
  });

  if (!opened.ok) return { ok: false, reason: opened.reason };
  return {
    ok: true,
    pull: opened.pull,
    created: opened.created,
    repository: repo.repository,
    baseBranch: repo.baseBranch,
  };
}
