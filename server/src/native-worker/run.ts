/**
 * Running a native command on this Mac, and being able to stop it.
 *
 * WHY A PROCESS GROUP AND NOT A PROCESS. `xcodebuild` is a parent that spawns `clang`, `swift-
 * frontend`, `ld` and a simulator daemon; `gradle` starts a daemon that outlives the invocation.
 * Killing the pid you spawned leaves all of that running, holding the derived-data lock and the
 * device, so the "cancelled" build is still compiling while its replacement starts. Every command
 * here is spawned as a group leader and the whole group is signalled.
 *
 * AND STOPPING IS TWO SIGNALS, NOT ONE. A build asked to stop should be allowed to unwind — closing
 * files, releasing the device — so it gets TERM first and KILL only if it is still there. A single
 * KILL leaves half-written DerivedData that the next build reads as a corrupt cache.
 *
 * OUTPUT IS BOUNDED AT THE READER. A test run can emit hundreds of megabytes, and a worker that
 * buffers all of it to hand a slice to a model has already spent the memory. The head and the tail
 * are what a person reads anyway, so the middle is dropped as it arrives and said to have been.
 */
import { spawn } from "node:child_process";

export type RunOutcome = {
  command: string;
  args: string[];
  cwd: string;
  /** Null when the command was signalled rather than exiting on its own. */
  exitCode: number | null;
  /** The signal that ended it, so a cancellation is distinguishable from a failure. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True when output was longer than the ceiling and the middle was dropped. */
  truncated: boolean;
  /** True when the command was still running at its deadline. */
  timedOut: boolean;
  /** True when something asked it to stop. Not a failure: a stop is a decision. */
  cancelled: boolean;
  durationMs: number;
  /** The process group, so a caller can prove the group is gone rather than assume it. */
  pgid: number | null;
};

export type RunRequest = {
  command: string;
  args: string[];
  /** Already resolved and admitted by `scope.ts`. This module does not decide where it may run. */
  cwd: string;
  /**
   * The environment, composed rather than inherited.
   *
   * A NATIVE BUILD NEEDS A REAL ENVIRONMENT — PATH, HOME, DEVELOPER_DIR — so an empty one is not an
   * option, and `process.env` wholesale is not either: the server's environment holds the database
   * URL, the encryption key and every provider secret this deployment was given, and handing that
   * to a build is handing it to whatever the build runs. The caller names what crosses.
   */
  env: Record<string, string>;
  /** Milliseconds. A long build is normal; a build with no ceiling is a slot that never returns. */
  timeoutMs: number;
  /** How much output to keep, split between the head and the tail. */
  maxOutputBytes?: number;
  /** Stops the run. The same signal the task's cancellation raises. */
  signal?: AbortSignal;
};

const DEFAULT_MAX_OUTPUT = 200_000;

/** How long a process group gets to unwind after TERM before it is killed. */
const GRACE_MS = 5_000;

/**
 * Keeps the head and the tail of a stream and drops the middle as it arrives.
 *
 * The first lines say what was run and the last say how it ended, which is what a person reads. The
 * middle of a two-hundred-megabyte build log is read by nobody and costs the memory of all of it.
 */
class BoundedText {
  private head = "";
  private tail = "";
  private dropped = false;
  constructor(private readonly limit: number) {}

  push(chunk: string) {
    if (this.head.length < this.limit / 2) {
      this.head += chunk;
      if (this.head.length > this.limit / 2) {
        this.tail = this.head.slice(this.limit / 2);
        this.head = this.head.slice(0, this.limit / 2);
      }
      return;
    }
    this.tail += chunk;
    if (this.tail.length > this.limit / 2) {
      this.tail = this.tail.slice(this.tail.length - this.limit / 2);
      this.dropped = true;
    }
  }

  get truncated() {
    return this.dropped;
  }

  text() {
    return this.dropped
      ? `${this.head}\n[... output was longer than ${this.limit} bytes; the middle is not kept ...]\n${this.tail}`
      : this.head + this.tail;
  }
}

/**
 * Is this process group still alive?
 *
 * Exported because "the build stopped" is a claim a test should be able to check rather than infer
 * from a promise resolving. Signal 0 asks without sending anything.
 */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    // Already gone. Not an error: the thing being asked for has happened.
    return false;
  }
}

export async function runNative(request: RunRequest): Promise<RunOutcome> {
  const started = Date.now();
  const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const stdout = new BoundedText(limit);
  const stderr = new BoundedText(limit);

  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    /*
     * Its own process group, which is the whole reason this module exists. Without it, `kill` reaches
     * the process that was spawned and not the compiler, linker and daemon it started.
     */
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pgid = child.pid ?? null;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

  let timedOut = false;
  let cancelled = false;

  /** TERM, then KILL if it is still there. See the module header. */
  const stop = () => {
    if (pgid === null) return;
    signalGroup(pgid, "SIGTERM");
    setTimeout(() => {
      if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
    }, GRACE_MS).unref?.();
  };

  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, request.timeoutMs);
  deadline.unref?.();

  const onAbort = () => {
    cancelled = true;
    stop();
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();

  const ended = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("error", () => resolve({ code: null, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  clearTimeout(deadline);
  request.signal?.removeEventListener("abort", onAbort);

  /*
   * The group is signalled once more on the way out, unconditionally.
   *
   * A command that exited normally may still have left a daemon in its group — gradle does exactly
   * this — and a worker that reports "finished" while a child holds the device has not finished. A
   * signal to a group that is already gone is a no-op, so this costs nothing in the ordinary case.
   */
  if (pgid !== null && groupAlive(pgid)) signalGroup(pgid, "SIGTERM");

  return {
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    exitCode: ended.code,
    signal: ended.signal,
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncated: stdout.truncated || stderr.truncated,
    timedOut,
    cancelled,
    durationMs: Date.now() - started,
    pgid,
  };
}

/**
 * The environment a native build is given.
 *
 * NAMED RATHER THAN INHERITED. The server's environment holds the database URL, the key encryption
 * key and every provider secret this deployment was configured with; a build inherits whatever it is
 * given and passes it to everything it runs, including a postinstall script from a dependency
 * nobody read. So the list is short, explicit, and everything on it is something a native toolchain
 * genuinely cannot work without.
 */
export function nativeEnvironment(
  ambient: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const carried = [
    // Finding the toolchain at all.
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    // Xcode and the simulators.
    "DEVELOPER_DIR",
    "SDKROOT",
    // Android.
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "JAVA_HOME",
    // Node toolchains a React Native build shells out to.
    "NODE_OPTIONS",
  ];
  const environment: Record<string, string> = {};
  for (const name of carried) {
    const value = ambient[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...extra };
}
