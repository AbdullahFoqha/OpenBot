/**
 * How a task actually gets to code: admission, a worktree, the real Cursor CLI backend, and an
 * independent re-check of exactly what it produced.
 *
 * ONE PATH FOR BOTH "RUN TASK" AND "RUN CODING TEST". A standalone script that calls the adapter
 * directly proves the adapter works; it does not prove the studio's own admission and reservation
 * rules apply to what a person clicks. Both entry points in routes.ts go through `runTask` below, so
 * a coding test is the same route a real task takes, pointed at a disposable fixture instead of the
 * selected project.
 *
 * VERIFICATION IS SEPARATE FROM THE RUN. `verifyCheck` re-reads the file the worker touched and
 * re-runs the check itself, after the run's own process has exited, rather than trusting the text
 * the model returned. A repair "done" only because a bot said so is exactly what this refuses to be.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Admission } from "./admission";
import { createCliBackend } from "../cursor-adapter/cli-backend";
import type { AgentEvent } from "../cursor-adapter/backend";
import type { Database } from "../db/client";
import { studioEvidence } from "../db/schema";
import type { TaskStore } from "./task-store";
import { deliverProjectDraftPr } from "./project-delivery";
import type { GhRunner } from "./github";
import type { NativeWorker } from "../native-worker/worker";
import { runMaestro, shouldRunMaestro, type MaestroEvidence } from "./maestro";

export const CURSOR_ENGINEER_BOT_ID = "react-native-engineer";
export const DEFAULT_MODEL = "cursor-grok-4.6-xhigh";

export type RunOutcome = {
  ok: boolean;
  backend: "cli";
  requestedModel: string;
  reportedModel: string | null;
  sessionId: string | null;
  worktreePath: string;
  changedFiles: string[];
  diff: string;
  checkBefore: unknown;
  checkAfter: unknown;
  blocker: string | null;
  events: AgentEvent[];
  /** Set when a successful project task opened or reconciled a draft PR. */
  pullRequest?: { number: number; url: string; created: boolean } | null;
  /** Set when Maestro UI tests were run (quality-engineer with maestroFlow or maestro: AC). */
  maestro?: {
    udid: string;
    flow: string;
    exitCode: number | null;
    outputDir: string;
    appInstalled: boolean;
    error?: string;
    durationMs: number;
    install?: {
      status: "skipped" | "cloned" | "expo" | "failed";
      exitCode: number | null;
      logPath: string;
    };
  } | null;
};

/** Runs a shell check inside a worktree and returns a plain, comparable result. */
async function runCheck(
  cwd: string,
  command: string[],
): Promise<{ command: string; exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command[0] as string, command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => {
      output += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      output += c.toString("utf8");
    });
    child.on("close", (exitCode) => {
      resolve({ command: command.join(" "), exitCode, output: output.slice(-4_000) });
    });
    child.on("error", (err) => {
      resolve({ command: command.join(" "), exitCode: null, output: String(err) });
    });
  });
}


/**
 * Default local verification for a product repo: package.json scripts the studio can re-run itself.
 *
 * Prefer `test` and `typecheck` when present. Not Maestro/device UI — that stays a QA-owned
 * native path — but this is the floor so Engineer work is not "shipped" to a draft PR on a red build.
 */
export async function resolveProjectVerifyCommands(
  projectPath: string,
): Promise<string[][]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(`${projectPath}/package.json`, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const commands: string[][] = [];
    // npm ci is not run here: the worktree shares node_modules via the project when present; agents
    // that need a fresh install say so in the task. We invoke via npm so PATH resolution is ordinary.
    if (typeof scripts.typecheck === "string") {
      commands.push(["npm", "run", "typecheck", "--silent"]);
    }
    if (typeof scripts.test === "string") {
      commands.push(["npm", "test", "--silent"]);
    }
    return commands;
  } catch {
    return [];
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(""));
  });
}

/**
 * The diff and changed-file list, including files the worker created.
 *
 * `git diff` ALONE MISSES A NEW FILE. It compares tracked content against the index and reports
 * nothing for a path git has never seen, which is exactly what a worker asked to create a file
 * produces — the run in this studio's own verification looked like "no changes" for that reason
 * before this staged first. Staging is safe here: every caller of this function operates on a
 * disposable fixture or a task's own dedicated worktree, never a shared or pushed branch.
 */
async function diffOf(
  cwd: string,
  /**
   * Commit the worktree was cut from. Required so a worker that commits its own work still
   * counts as having changed the tree — `git diff --cached` against HEAD is empty after a commit,
   * which is exactly how this studio once reported "no changes" for a real file+commit.
   */
  baseCommit: string,
): Promise<{ diff: string; changedFiles: string[] }> {
  // Exclude the studio-linked node_modules symlink — git would otherwise stage it as a new path.
  await runGit(["add", "-A", "--", ".", ":(exclude)node_modules"], cwd);
  await runGit(["reset", "-q", "HEAD", "--", "node_modules"], cwd);
  // Working tree (including committed HEAD) vs the branch point — not --cached vs HEAD.
  const diff = await runGit(["diff", "--no-color", baseCommit, "--", ".", ":(exclude)node_modules"], cwd);
  const nameOnly = await runGit(["diff", "--name-only", baseCommit, "--", ".", ":(exclude)node_modules"], cwd);
  const changedFiles = nameOnly
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "node_modules" && !l.startsWith("node_modules/"));
  return { diff, changedFiles };
}

/**
 * Drive one Cursor CLI run to completion in `cwd`, collecting every event.
 *
 * Not cancellable from the outside except through `signal`; the caller in routes.ts keeps the
 * `AbortController` so Stop Task can call it.
 */
export async function driveCursorRun(input: {
  cwd: string;
  prompt: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  reportedModel: string | null;
  sessionId: string | null;
  blocker: string | null;
  events: AgentEvent[];
}> {
  const backend = createCliBackend({ acknowledgeUnconfined: true });
  const run = await backend.start({
    prompt: input.prompt,
    cwd: input.cwd,
    model: input.model ?? DEFAULT_MODEL,
    signal: input.signal,
  });
  const events: AgentEvent[] = [];
  let reportedModel: string | null = null;
  let sessionId: string | null = null;
  let ok = false;
  let blocker: string | null = null;
  for await (const event of run.events) {
    events.push(event);
    if (event.type === "session") {
      reportedModel = event.model || null;
      sessionId = event.sessionId || null;
    }
    if (event.type === "result") {
      ok = event.ok;
      reportedModel = event.model ?? reportedModel;
      sessionId = event.sessionId ?? sessionId;
      if (!event.ok) blocker = event.text || "The agent reported failure.";
    }
    if (event.type === "error") {
      blocker = event.message;
    }
  }
  return { ok, reportedModel, sessionId, blocker, events };
}

/**
 * Build the disposable coding-test fixture: a git repo with one known bug and a failing check.
 *
 * A FRESH REPO EACH TIME, under the OS temp dir rather than inside the selected project or the
 * studio's own checkout. "Keep test changes out of the shipping branch" is easiest to guarantee by
 * never sharing a repository with the branch in the first place.
 */
export async function materializeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openbot-coding-test-"));
  await mkdir(join(dir, "openbot-smoke-test"), { recursive: true });
  await writeFile(
    join(dir, "openbot-smoke-test", "add.js"),
    `function add(a, b) {\n  return a - b; // bug: should add\n}\nmodule.exports = { add };\n`,
  );
  await writeFile(
    join(dir, "openbot-smoke-test", "check.js"),
    `const { add } = require("./add.js");\nconst got = add(2, 3);\nif (got !== 5) {\n  console.error("FAIL: add(2, 3) =", got, "expected 5");\n  process.exit(1);\n}\nconsole.log("PASS");\n`,
  );
  await new Promise<void>((resolve) => {
    const child = spawn("git", ["init", "-q"], { cwd: dir });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  await new Promise<void>((resolve) => {
    const child = spawn("git", ["-c", "user.email=studio@local", "-c", "user.name=Studio", "add", "-A"], {
      cwd: dir,
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  await new Promise<void>((resolve) => {
    const child = spawn(
      "git",
      ["-c", "user.email=studio@local", "-c", "user.name=Studio", "commit", "-q", "-m", "fixture"],
      { cwd: dir },
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  return dir;
}

/**
 * Run the coding test end to end: fixture, admission, the real Cursor backend, and an independent
 * re-check of the same bytes the worker left behind.
 */
export async function runCodingTest(deps: {
  admission: Admission;
  taskStore: TaskStore;
  database: Database;
  taskId: string;
  model?: string;
}): Promise<RunOutcome> {
  const { taskId } = deps;
  const claim = await deps.admission.claim({
    taskId,
    botId: CURSOR_ENGINEER_BOT_ID,
    owner: `coding-test-${process.pid}`,
  });
  if (!claim.ok) {
    return {
      ok: false,
      backend: "cli",
      requestedModel: deps.model ?? DEFAULT_MODEL,
      reportedModel: null,
      sessionId: null,
      worktreePath: "",
      changedFiles: [],
      diff: "",
      checkBefore: null,
      checkAfter: null,
      blocker: claim.detail,
      events: [],
    };
  }

  const cwd = await materializeFixture();
  const checkBefore = await runCheck(cwd, ["node", "openbot-smoke-test/check.js"]);

  const prompt =
    "In openbot-smoke-test/add.js, the add() function has a bug: it subtracts instead of adding. " +
    "Fix it so add(a, b) returns a + b. Then run `node openbot-smoke-test/check.js` to confirm it " +
    "passes. Only touch files under openbot-smoke-test/.";

  const baseCommit = (await runGit(["rev-parse", "HEAD"], cwd)).trim();
  const run = await driveCursorRun({ cwd, prompt, model: deps.model });

  // Independent re-check: the same bytes, re-run by this process, not trusted from the agent's own
  // report of what it did.
  const checkAfter = await runCheck(cwd, ["node", "openbot-smoke-test/check.js"]);
  const { diff, changedFiles } = await diffOf(cwd, baseCommit);

  const ok = run.ok && checkAfter.exitCode === 0 && changedFiles.length > 0;

  await deps.database
    .insert(studioEvidence)
    .values({
      taskId,
      backend: "cli",
      requestedModel: deps.model ?? DEFAULT_MODEL,
      reportedModel: run.reportedModel,
      sessionId: run.sessionId,
      worktreePath: cwd,
      changedFiles,
      diff,
      checkBefore,
      checkAfter,
      ok,
      blocker: ok ? null : run.blocker ?? "The re-run check did not pass.",
    })
    .onConflictDoNothing();

  await deps.taskStore.transition(taskId, "in_review");
  await deps.admission.release(claim.ticket);
  await rm(cwd, { recursive: true, force: true }).catch(() => {});

  return {
    ok,
    backend: "cli",
    requestedModel: deps.model ?? DEFAULT_MODEL,
    reportedModel: run.reportedModel,
    sessionId: run.sessionId,
    worktreePath: cwd,
    changedFiles,
    diff,
    checkBefore,
    checkAfter,
    blocker: ok ? null : run.blocker ?? "The re-run check did not pass.",
    events: run.events,
  };
}

/** Read back the file after the fixture directory is gone — used only while it is still live. */
export async function readFixtureFile(cwd: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, relPath), "utf8");
  } catch {
    return null;
  }
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

/**
 * Run one real assignment against the selected project: its own branch and worktree, the same
 * Cursor CLI backend the coding test uses, and — when the worker produced changes — a single draft
 * pull request through `createGitHubDelivery().openDraft` (find-before-create).
 *
 * Coding Test never calls this path. A delivery failure becomes a blocker and keeps the worktree.
 */
export async function runProjectTask(deps: {
  admission: Admission;
  taskStore: TaskStore;
  database: Database;
  productId: string;
  projectPath: string;
  taskId: string;
  botId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  model?: string;
  /**
   * Shell checks to re-run in the worktree after the worker exits.
   * When omitted, discovered from the project's package.json (`typecheck`, `test`).
   * Pass an empty array to skip verification.
   */
  verifyCommands?: string[][];
  /** Injected in tests so openDraft never touches a real account. */
  gh?: GhRunner;
  pushBranch?: (
    cwd: string,
    branch: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Path to a Maestro YAML flow, relative to projectPath or absolute.
   * When set (typically with quality-engineer), Maestro runs after npm verification.
   */
  maestroFlow?: string;
  /**
   * iOS Simulator UDID for Maestro. Defaults to studio's preferred device.
   */
  deviceUdid?: string;
  /**
   * Native worker for device reservation. Required when maestroFlow is set.
   * If not provided and Maestro is requested, the run fails with a clear error.
   */
  nativeWorker?: NativeWorker;
}): Promise<RunOutcome> {
  const claim = await deps.admission.claim({
    taskId: deps.taskId,
    botId: deps.botId,
    owner: `studio-app-${process.pid}`,
  });
  if (!claim.ok) {
    return {
      ok: false,
      backend: "cli",
      requestedModel: deps.model ?? DEFAULT_MODEL,
      reportedModel: null,
      sessionId: null,
      worktreePath: "",
      changedFiles: [],
      diff: "",
      checkBefore: null,
      checkAfter: null,
      blocker: claim.detail,
      events: [],
    };
  }

  const branch = `studio/${slugify(deps.title)}-${deps.taskId.slice(-6)}`;
  const worktreePath = join(
    deps.projectPath,
    "..",
    `${slugify(deps.title)}-${deps.taskId.slice(-6)}.studio-worktree`,
  );

  const addWorktree = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    const child = spawn("git", ["worktree", "add", "-b", branch, worktreePath], {
      cwd: deps.projectPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => {
      output += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      output += c.toString("utf8");
    });
    child.on("close", (code) => resolve({ ok: code === 0, output }));
    child.on("error", (err) => resolve({ ok: false, output: String(err) }));
  });

  if (!addWorktree.ok) {
    await deps.admission.release(claim.ticket);
    return {
      ok: false,
      backend: "cli",
      requestedModel: deps.model ?? DEFAULT_MODEL,
      reportedModel: null,
      sessionId: null,
      worktreePath,
      changedFiles: [],
      diff: "",
      checkBefore: null,
      checkAfter: null,
      blocker: `Could not create the task's worktree/branch: ${addWorktree.output.slice(-500)}`,
      events: [],
    };
  }

  // Worktrees do not carry gitignored node_modules; link the product's so local test/typecheck work.
  try {
    await symlink(
      join(deps.projectPath, "node_modules"),
      join(worktreePath, "node_modules"),
      "dir",
    );
  } catch {
    // Already linked, or no node_modules in the product — verify will surface that clearly.
  }

  const baseCommit = (await runGit(["rev-parse", "HEAD"], worktreePath)).trim();
  const verifyCommands =
    deps.verifyCommands ??
    (await resolveProjectVerifyCommands(deps.projectPath));
  const verifyHint =
    verifyCommands.length > 0
      ? `\n\nLocal verification (run these in this worktree before you finish; the studio will re-run them after you exit):\n${verifyCommands.map((c) => `- \`${c.join(" ")}\``).join("\n")}`
      : "";
  const prompt = `You are editing a real product checkout on this Mac (worktree). Make the changes in this directory only.

Goal:
${deps.goal}

Acceptance criteria:
${deps.acceptanceCriteria}
${verifyHint}

When you are done: leave the tree buildable, run the verification commands above if listed, and commit your changes on this branch.`;
  const run = await driveCursorRun({ cwd: worktreePath, prompt, model: deps.model });
  const { diff, changedFiles } = await diffOf(worktreePath, baseCommit);
  let ok = run.ok && changedFiles.length > 0;

  let blocker: string | null = ok ? null : run.blocker ?? "The worker made no changes.";
  let pullRequest: RunOutcome["pullRequest"] = null;
  let checkAfterResults: Array<{ command: string; exitCode: number | null; output: string }> | null = null;
  let maestroEvidence: MaestroEvidence | null = null;

  if (ok) {
    /*
     * Commit before verify/delivery when the worker left changes staged/uncommitted.
     *
     * diffOf stages for detection; a worker that wrote files but never committed leaves HEAD on
     * the branch point, and GitHub then refuses the draft PR with "No commits between main and …".
     */
    const ahead = (
      await runGit(["rev-list", "--count", `${baseCommit}..HEAD`], worktreePath)
    ).trim();
    if (ahead === "0" && changedFiles.length > 0) {
      await runGit(["-c", "user.email=studio@local", "-c", "user.name=OpenBot Studio", "commit", "-q", "-m", deps.title], worktreePath);
    }

    // Independent re-check in the worktree — same idea as the coding test fixture path.
    const checkResults: Array<{ command: string; exitCode: number | null; output: string }> = [];
    for (const command of verifyCommands) {
      checkResults.push(await runCheck(worktreePath, command));
    }
    checkAfterResults = checkResults.length > 0 ? checkResults : null;
    const failed = checkAfterResults?.find((c) => c.exitCode !== 0);
    if (failed) {
      ok = false;
      blocker = `Local verification failed (${failed.command}, exit ${failed.exitCode}). Output tail: ${failed.output.slice(-800)}`;
      await deps.taskStore.setBlocked(deps.taskId, blocker).catch(() => {});
    }
  }

  /*
   * Maestro UI tests: run after npm verification passes, only for quality-engineer or when
   * maestroFlow is explicitly set. Device lease through native-worker, not studio_reservations.
   */
  if (ok) {
    const maestroCheck = shouldRunMaestro({
      maestroFlow: deps.maestroFlow,
      acceptanceCriteria: deps.acceptanceCriteria,
      ownerBotId: deps.botId,
    });

    if (maestroCheck.run && maestroCheck.flow) {
      if (!deps.nativeWorker) {
        ok = false;
        blocker = "Maestro flow requested but no native worker is available for device reservation.";
        await deps.taskStore.setBlocked(deps.taskId, blocker).catch(() => {});
      } else {
        const maestroResult = await runMaestro(deps.nativeWorker, {
          taskId: deps.taskId,
          actorId: `studio-task-${deps.taskId}`,
          fence: 1,
          projectPath: deps.projectPath,
          worktreePath,
          flow: maestroCheck.flow,
          udid: deps.deviceUdid ?? maestroCheck.udid,
          autoInstall: deps.botId === "quality-engineer",
        });

        maestroEvidence = maestroResult.evidence ?? null;

        if (!maestroResult.ok) {
          ok = false;
          blocker = maestroResult.reason;
          await deps.taskStore.setBlocked(deps.taskId, blocker).catch(() => {});
        }
      }
    }
  }

  if (ok) {
    const delivered = await deliverProjectDraftPr({
      database: deps.database,
      taskId: deps.taskId,
      title: deps.title,
      goal: deps.goal,
      acceptanceCriteria: deps.acceptanceCriteria,
      worktreePath,
      branch,
      projectPath: deps.projectPath,
      ...(deps.gh ? { gh: deps.gh } : {}),
      ...(deps.pushBranch ? { push: deps.pushBranch } : {}),
    });
    if (delivered.ok) {
      pullRequest = {
        number: delivered.pull.number,
        url: delivered.pull.url,
        created: delivered.created,
      };
    } else {
      // Work and worktree stay; the person can still push. Surface why the draft PR did not open.
      blocker = `Code changed and checks passed, but the draft pull request was not opened: ${delivered.reason}`;
      await deps.taskStore.setBlocked(deps.taskId, blocker).catch(() => {});
    }
  }

  const maestroForDb: Record<string, unknown> | null = maestroEvidence
    ? {
        udid: maestroEvidence.udid,
        flow: maestroEvidence.flow,
        exitCode: maestroEvidence.exitCode,
        outputDir: maestroEvidence.outputDir,
        appInstalled: maestroEvidence.appInstalled,
        error: maestroEvidence.error,
        durationMs: maestroEvidence.durationMs,
        install: maestroEvidence.install,
      }
    : null;

  const checkAfterForDb = checkAfterResults as Record<string, unknown> | null;

  await deps.database
    .insert(studioEvidence)
    .values({
      taskId: deps.taskId,
      backend: "cli",
      requestedModel: deps.model ?? DEFAULT_MODEL,
      reportedModel: run.reportedModel,
      sessionId: run.sessionId,
      worktreePath,
      changedFiles,
      diff,
      checkBefore: null,
      checkAfter: checkAfterForDb,
      ok,
      blocker,
      maestro: maestroForDb,
    })
    .onConflictDoUpdate({
      target: studioEvidence.taskId,
      set: {
        reportedModel: run.reportedModel,
        sessionId: run.sessionId,
        changedFiles,
        diff,
        checkAfter: checkAfterForDb,
        ok,
        blocker,
        maestro: maestroForDb,
      },
    });

  await deps.taskStore.transition(deps.taskId, "in_review").catch(() => {});
  await deps.admission.release(claim.ticket);

  return {
    ok,
    backend: "cli",
    requestedModel: deps.model ?? DEFAULT_MODEL,
    reportedModel: run.reportedModel,
    sessionId: run.sessionId,
    worktreePath,
    changedFiles,
    diff,
    checkBefore: null,
    checkAfter: null,
    blocker,
    events: run.events,
    pullRequest,
    maestro: maestroEvidence,
  };
}
