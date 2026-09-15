import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  groupAlive,
  nativeEnvironment,
  runNative,
} from "../src/native-worker/run";
import { resolveReal, within } from "../src/native-worker/scope";
import { createNativeWorker } from "../src/native-worker/worker";

/**
 * A worker that really runs things on this Mac, tested by really running things.
 *
 * Nothing here is mocked, because every property worth having is a property of the operating system:
 * whether a symlink out of a worktree is followed, whether killing a build kills the compiler it
 * started, and whether a command that ignores TERM is still there afterwards. A fake answers all
 * three the way its author hoped, and this is the one module in the studio whose mistakes land on
 * somebody's actual laptop.
 */

let root: string;
let worktree: string;
let outside: string;

const ACTOR = "person-1";
const TASK = `task-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-native-"));
  worktree = join(root, "worktree");
  outside = join(root, "outside");
  await mkdir(worktree, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(worktree, "inside.txt"), "inside\n");
  await writeFile(join(outside, "secret.txt"), "not yours\n");
  // The oldest way through a prefix check: a link inside the root pointing out of it.
  await symlink(outside, join(worktree, "escape"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function workerWith() {
  return createNativeWorker({
    token: "worker-secret",
    ambientEnvironment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Two secrets a real server's environment would hold. Neither is on the carried list.
      DATABASE_URL: "postgres://user:password@localhost/openbot",
      KEY_ENCRYPTION_KEY: "an-actual-secret",
    },
  });
}

async function registered(
  over: Partial<Parameters<ReturnType<typeof workerWith>["register"]>[0]> = {},
) {
  const worker = workerWith();
  const outcome = await worker.register({
    taskId: TASK,
    actorId: ACTOR,
    fence: 1,
    roots: [worktree],
    operations: ["workspace", "build"],
    ...over,
  });
  expect(outcome.ok).toBe(true);
  return worker;
}

describe("where a worker may reach", () => {
  test("containment is a path relationship, not a string prefix", () => {
    // `/tmp/work` is a prefix of `/tmp/work-other`, and a `startsWith` check says yes.
    expect(within("/tmp/work", "/tmp/work/src/app.ts")).toBe(true);
    expect(within("/tmp/work", "/tmp/work")).toBe(true);
    expect(within("/tmp/work", "/tmp/work-other/app.ts")).toBe(false);
    expect(within("/tmp/work", "/tmp")).toBe(false);
    expect(within("/tmp/work", "/tmp/work/../outside")).toBe(false);
  });

  test("a symlink out of a registered root is refused, because links are followed first", async () => {
    const worker = await registered();
    const escaped = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      fence: 1,
      operation: "workspace",
      command: "/bin/cat",
      args: ["secret.txt"],
      cwd: join(worktree, "escape"),
    });
    /*
     * The path is inside the worktree by every textual measure. `path.resolve` would collapse it and
     * agree. Only asking the filesystem where it really goes catches this, which is why the check
     * resolves before it compares.
     */
    expect(escaped.ok).toBe(false);
    expect(escaped.ok === false && escaped.reason).toContain(
      "outside every directory registered",
    );
  });

  test("a relative path is refused rather than resolved against whatever the worker is doing", async () => {
    expect((await resolveReal("../etc")).ok).toBe(false);
    expect((await resolveReal("src/app.ts")).ok).toBe(false);
  });

  test("a file that does not exist yet is placed by its nearest real ancestor", async () => {
    // Writing a NEW file is ordinary, and `realpath` refuses a path with no inode. The question
    // containment is really asking is about the directory it would land in.
    const resolved = await resolveReal(join(worktree, "src", "new-file.ts"));
    expect(resolved.ok).toBe(true);
    expect(
      resolved.ok &&
        within(
          await Bun.$`realpath ${worktree}`.text().then((t) => t.trim()),
          resolved.path,
        ),
    ).toBe(true);
  });

  test("an absolute path outside every root is refused however real it is", async () => {
    const worker = await registered();
    const outcome = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      fence: 1,
      operation: "workspace",
      command: "/bin/cat",
      args: ["secret.txt"],
      cwd: outside,
    });
    expect(outcome.ok).toBe(false);
  });

  test("an unregistered task is refused, because a path is a request rather than a grant", async () => {
    const worker = workerWith();
    const outcome = await worker.run({
      taskId: "never-registered",
      actorId: ACTOR,
      fence: 1,
      operation: "workspace",
      command: "/bin/echo",
      args: ["hello"],
      cwd: worktree,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(
      "a request, not a grant",
    );
  });

  test("a job for the wrong person, or an operation this task was not registered for, is refused", async () => {
    const worker = await registered();
    const wrongPerson = await worker.run({
      taskId: TASK,
      actorId: "somebody-else",
      fence: 1,
      operation: "workspace",
      command: "/bin/echo",
      args: ["hi"],
      cwd: worktree,
    });
    expect(wrongPerson.ok).toBe(false);

    // Registered for workspace and build, never for pushing a branch.
    const wrongOperation = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      fence: 1,
      operation: "vcs",
      command: "/usr/bin/git",
      args: ["push"],
      cwd: worktree,
    });
    expect(wrongOperation.ok).toBe(false);
    expect(wrongOperation.ok === false && wrongOperation.reason).toContain(
      "not registered for vcs",
    );
  });

  test("a worker whose task was handed on cannot still reach the filesystem", async () => {
    const worker = await registered();
    const stale = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      // The fence it was admitted with, after somebody reclaimed the task.
      fence: 1 - 1 + 0,
      operation: "workspace",
      command: "/bin/echo",
      args: ["hi"],
      cwd: worktree,
    });
    /*
     * Without this, the native worker is the one door a fenced-off worker can still walk through,
     * and it is the door that reaches the filesystem.
     */
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.reason).toContain(
      "another worker holds it now",
    );
  });

  test("a registration naming a root that does not exist is refused rather than silently empty", async () => {
    const worker = workerWith();
    const outcome = await worker.register({
      taskId: "typo",
      actorId: ACTOR,
      fence: 1,
      roots: [join(root, "no-such-worktree")],
      operations: ["workspace"],
    });
    // A typo that registers nothing is a registration that refuses everything for reasons nobody
    // can see from the outside.
    expect(outcome.ok).toBe(false);
  });

  test("a registration with no operations is refused rather than stored as a no-op", async () => {
    const worker = workerWith();
    expect(
      (
        await worker.register({
          taskId: "empty",
          actorId: ACTOR,
          fence: 1,
          roots: [worktree],
          operations: [],
        })
      ).ok,
    ).toBe(false);
  });
});

describe("finding out what exists, which is not the same as driving it", () => {
  test("listing simulators needs no device, because a task cannot reserve one it has not found", async () => {
    const worker = await registered({ operations: ["discovery"] });
    const outcome = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      fence: 1,
      operation: "discovery",
      command: "/usr/bin/xcrun",
      args: ["simctl", "list", "devices", "available"],
      cwd: worktree,
      timeoutMs: 120_000,
    });
    /*
     * Folded into `device`, this was impossible: a `device` job must name a device it reserved, and
     * nothing can reserve a device before discovering it. The obvious workaround is to hand out
     * `device` for everything, which is how a capability ends up granted more broadly than it needs.
     */
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result.exitCode).toBe(0);
  }, 130_000);

  test("discovery does not become a way to drive a device that was never reserved", async () => {
    const worker = await registered({ operations: ["discovery"] });
    const outcome = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      fence: 1,
      operation: "device",
      command: "/usr/bin/xcrun",
      args: ["simctl", "boot", "SOME-UDID"],
      cwd: worktree,
    });
    // The weakest class stays the weakest class.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(
      "not registered for device",
    );
  });
});

describe("devices, which are reserved rather than shared", () => {
  test("two tasks cannot hold one simulator", async () => {
    const worker = await registered({
      devices: ["SIM-UDID-1"],
      operations: ["device"],
    });
    const second = await worker.register({
      taskId: "other-task",
      actorId: ACTOR,
      fence: 1,
      roots: [worktree],
      devices: ["SIM-UDID-1"],
      operations: ["device"],
    });
    /*
     * Not a permissions problem. Two test runs interleaving on one screen produce two results,
     * neither of which means anything afterwards.
     */
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toContain("already reserved");
  });

  test("releasing a task frees its device and its ports", async () => {
    const worker = await registered({
      devices: ["SIM-UDID-2"],
      operations: ["device"],
    });
    worker.takePort({ taskId: TASK, purpose: "metro" });
    worker.release(TASK);
    expect(worker.ports()).toHaveLength(0);
    expect(
      (
        await worker.register({
          taskId: "other-task",
          actorId: ACTOR,
          fence: 1,
          roots: [worktree],
          devices: ["SIM-UDID-2"],
          operations: ["device"],
        })
      ).ok,
    ).toBe(true);
  });
});

describe("ports, because two worktrees both want 8081", () => {
  test("two worktrees get two ports", async () => {
    const worker = await registered();
    const first = worker.takePort({ taskId: TASK, purpose: "metro" });
    const second = worker.takePort({ taskId: "other-task", purpose: "metro" });
    expect(first.ok && second.ok).toBe(true);
    /*
     * The failure this prevents is not a crash. The second build attaches to the FIRST worktree's
     * bundler, tests code from the wrong branch, and reports the right one.
     */
    expect(first.ok && second.ok && first.lease.port).not.toBe(
      second.ok ? second.lease.port : -1,
    );
  });

  test("asking twice for the same purpose returns the same port", async () => {
    const worker = await registered();
    const first = worker.takePort({ taskId: TASK, purpose: "metro" });
    const again = worker.takePort({ taskId: TASK, purpose: "metro" });
    // A restarted worker wants the port it already has, not a second one and not a refusal.
    expect(first.ok && again.ok && first.lease.port).toBe(
      again.ok ? again.lease.port : -1,
    );
  });
});

describe("running something, and stopping it", () => {
  test("an allowed command runs and reports its real exit code", async () => {
    const worker = await registered();
    const outcome = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      fence: 1,
      operation: "workspace",
      command: "/bin/cat",
      args: ["inside.txt"],
      cwd: worktree,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result.stdout.trim()).toBe("inside");
    expect(outcome.ok && outcome.result.exitCode).toBe(0);
  });

  test("a failing command is reported as failing rather than as an error", async () => {
    const worker = await registered();
    const outcome = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      fence: 1,
      operation: "build",
      command: "/bin/sh",
      args: ["-c", "echo building; echo broke >&2; exit 65"],
      cwd: worktree,
    });
    // 65 is what xcodebuild returns for a compile failure. A build that failed is information, not
    // an outage, so the exit code and both streams come back intact.
    expect(outcome.ok && outcome.result.exitCode).toBe(65);
    expect(outcome.ok && outcome.result.stderr).toContain("broke");
  });

  test("cancelling a build kills the whole process group, not just the command", async () => {
    const controller = new AbortController();
    /*
     * A parent that spawns a long-lived child and exits is exactly `xcodebuild` and `gradle`:
     * killing the pid that was spawned leaves the compiler, the linker and the daemon running,
     * holding the derived-data lock and the device while the "cancelled" build's replacement starts.
     */
    const started = Date.now();
    const promise = runNative({
      command: "/bin/sh",
      args: ["-c", "sleep 60 & sleep 60"],
      cwd: worktree,
      env: nativeEnvironment(process.env),
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await Bun.sleep(300);
    controller.abort();
    const result = await promise;

    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
    // The group, asked directly, rather than inferred from the promise having resolved.
    expect(result.pgid === null || !groupAlive(result.pgid)).toBe(true);
  });

  test("a command that ignores TERM is killed rather than waited on forever", async () => {
    const controller = new AbortController();
    const promise = runNative({
      command: "/bin/sh",
      args: ["-c", "trap '' TERM; sleep 60"],
      cwd: worktree,
      env: nativeEnvironment(process.env),
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await Bun.sleep(300);
    controller.abort();
    const result = await promise;
    // TERM first so a build can unwind and release the device; KILL because a build that will not
    // unwind must still stop.
    expect(result.cancelled).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  }, 30_000);

  test("a command that runs past its deadline is stopped and said to have timed out", async () => {
    const result = await runNative({
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: worktree,
      env: nativeEnvironment(process.env),
      timeoutMs: 400,
    });
    // A long build is normal; a build with no ceiling is a slot that never comes back.
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
  }, 30_000);

  test("enormous output keeps the head and the tail and says the middle went", async () => {
    const result = await runNative({
      command: "/bin/sh",
      args: [
        "-c",
        "i=0; while [ $i -lt 4000 ]; do echo line-$i; i=$((i+1)); done",
      ],
      cwd: worktree,
      env: nativeEnvironment(process.env),
      timeoutMs: 20_000,
      maxOutputBytes: 2_000,
    });
    expect(result.truncated).toBe(true);
    // The first lines say what was run and the last say how it ended, which is what a person reads.
    expect(result.stdout).toContain("line-0");
    expect(result.stdout).toContain("line-3999");
    expect(result.stdout).toContain("the middle is not kept");
  }, 30_000);
});

describe("what a build is allowed to inherit", () => {
  test("the deployment's secrets do not cross into a native command", async () => {
    const worker = await registered();
    const outcome = await worker.run({
      taskId: TASK,
      actorId: ACTOR,
      fence: 1,
      operation: "build",
      command: "/usr/bin/env",
      args: [],
      cwd: worktree,
    });
    const environment = outcome.ok ? outcome.result.stdout : "";
    /*
     * A build inherits whatever it is given and passes it to everything it runs, including a
     * postinstall script from a dependency nobody read. The server's environment holds the database
     * URL and the key encryption key.
     */
    expect(environment).not.toContain("DATABASE_URL");
    expect(environment).not.toContain("an-actual-secret");
    // And it still has what a toolchain cannot work without.
    expect(environment).toContain("PATH=");
  });

  test("the carried list is what it says it is", () => {
    const composed = nativeEnvironment({
      PATH: "/usr/bin",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      ANDROID_HOME: "/Users/someone/Library/Android/sdk",
      AWS_SECRET_ACCESS_KEY: "should not travel",
      OPENAI_API_KEY: "should not travel",
    });
    expect(Object.keys(composed).sort()).toEqual([
      "ANDROID_HOME",
      "DEVELOPER_DIR",
      "PATH",
    ]);
  });
});
