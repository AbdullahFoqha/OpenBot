import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { eq, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  studioBranches,
  studioEvidence,
  studioProducts,
  studioPullRequests,
  studioReservations,
  studioTasks,
} from "../src/db/schema";
import type { GhRunner } from "../src/studio/github";
import { deliverProjectDraftPr } from "../src/studio/project-delivery";
import { createTaskStore } from "../src/studio/task-store";
import { testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), { max: 3 });
const suite = randomUUID().slice(0, 8);
const PRODUCT = `pd-product-${suite}`;
const tasks = createTaskStore(database);

async function clean() {
  for (const table of [
    studioEvidence,
    studioPullRequests,
    studioBranches,
    studioReservations,
  ]) {
    await database.delete(table).where(like(table.taskId, `${suite}-%`));
  }
  await database.delete(studioTasks).where(like(studioTasks.id, `${suite}-%`));
  await database.delete(studioProducts);
}

beforeEach(async () => {
  await clean();
  await tasks.activateProduct({ id: PRODUCT, name: "Project delivery" });
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

function run(cmd: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd, stdio: "ignore" });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd.join(" ")} -> ${code}`)),
    );
    child.on("error", reject);
  });
}

async function gitFixture(): Promise<{ root: string; worktree: string; branch: string }> {
  const root = await mkdtemp(join(tmpdir(), "studio-pd-"));
  await run(["git", "init"], root);
  await run(["git", "config", "user.email", "studio@test"], root);
  await run(["git", "config", "user.name", "Studio Test"], root);
  await writeFile(join(root, "README.md"), "hi\n");
  await run(["git", "add", "."], root);
  await run(["git", "commit", "-m", "init"], root);
  const branch = `studio/pd-${suite}`;
  const worktree = join(root, "..", `${suite}-wt`);
  await run(["git", "worktree", "add", "-b", branch, worktree], root);
  return { root, worktree, branch };
}

describe("deliverProjectDraftPr", () => {
  test("opens a draft PR once through openDraft (mocked gh)", async () => {
    const { root, worktree, branch } = await gitFixture();
    const taskId = `${suite}-ok`;
    await tasks.createTask({
      id: taskId,
      productId: PRODUCT,
      title: "Empty state",
      state: "in_progress",
    });

    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "repo" && args[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            nameWithOwner: "AbdullahFoqha/fixture",
            defaultBranchRef: { name: "main" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "list") {
        // First list: none. After create: the PR.
        const created = calls.some((c) => c[0] === "pr" && c[1] === "create");
        return {
          exitCode: 0,
          stdout: created
            ? JSON.stringify([
                {
                  number: 42,
                  url: "https://github.com/AbdullahFoqha/fixture/pull/42",
                  baseRefName: "main",
                  headRefName: branch,
                  isDraft: true,
                  state: "OPEN",
                },
              ])
            : "[]",
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "create") {
        return { exitCode: 0, stdout: "https://github.com/AbdullahFoqha/fixture/pull/42\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
    };

    const pushes: string[] = [];
    const first = await deliverProjectDraftPr({
      database,
      taskId,
      title: "Empty state",
      goal: "Show nothing when empty",
      acceptanceCriteria: "Blank slate renders",
      worktreePath: worktree,
      branch,
      projectPath: root,
      gh,
      push: async (_cwd, b) => {
        pushes.push(b);
        return { ok: true };
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.pull.number).toBe(42);
    expect(pushes).toEqual([branch]);
    expect(calls.filter((c) => c[0] === "pr" && c[1] === "create")).toHaveLength(1);

    const [branchRow] = await database
      .select()
      .from(studioBranches)
      .where(eq(studioBranches.taskId, taskId));
    expect(branchRow?.branch).toBe(branch);

    // Retry must not create a second PR.
    const second = await deliverProjectDraftPr({
      database,
      taskId,
      title: "Empty state",
      goal: "Show nothing when empty",
      acceptanceCriteria: "Blank slate renders",
      worktreePath: worktree,
      branch,
      projectPath: root,
      gh,
      push: async () => ({ ok: true }),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(calls.filter((c) => c[0] === "pr" && c[1] === "create")).toHaveLength(1);

    await rm(worktree, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  test("delivery failure returns a reason and does not throw", async () => {
    const { root, worktree, branch } = await gitFixture();
    const taskId = `${suite}-fail`;
    await tasks.createTask({
      id: taskId,
      productId: PRODUCT,
      title: "Will fail delivery",
      state: "in_progress",
    });

    const gh: GhRunner = async (args) => {
      if (args[0] === "repo" && args[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            nameWithOwner: "AbdullahFoqha/fixture",
            defaultBranchRef: { name: "main" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        return { exitCode: 1, stdout: "", stderr: "HTTP 401: Bad credentials" };
      }
      return { exitCode: 1, stdout: "", stderr: "nope" };
    };

    const outcome = await deliverProjectDraftPr({
      database,
      taskId,
      title: "Will fail delivery",
      goal: "x",
      acceptanceCriteria: "y",
      worktreePath: worktree,
      branch,
      projectPath: root,
      gh,
      push: async () => ({ ok: true }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("401");

    // Worktree still on disk
    const { access } = await import("node:fs/promises");
    await access(worktree);

    await rm(worktree, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
});

describe("coding test path stays free of delivery", () => {
  test("runCodingTest is a separate export that does not import deliverProjectDraftPr at call sites", async () => {
    // Structural: runner.ts must keep runCodingTest free of deliverProjectDraftPr calls.
    const source = await Bun.file(
      new URL("../src/studio/runner.ts", import.meta.url),
    ).text();
    const codingStart = source.indexOf("export async function runCodingTest");
    const projectStart = source.indexOf("export async function runProjectTask");
    expect(codingStart).toBeGreaterThan(-1);
    expect(projectStart).toBeGreaterThan(codingStart);
    const codingBody = source.slice(codingStart, projectStart);
    expect(codingBody).not.toContain("deliverProjectDraftPr");
    expect(source.slice(projectStart)).toContain("deliverProjectDraftPr");
  });
});
