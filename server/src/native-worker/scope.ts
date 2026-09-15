/**
 * What a worker on this Mac is allowed to touch, and how that is decided.
 *
 * THE PROBLEM THIS EXISTS FOR. A coding agent given a working directory is not confined to it. It
 * has a shell; a shell has `cd`, `..`, symlinks and absolute paths. Setting `cwd` tells a process
 * where to start, which is not the same promise as telling it where it may go, and reading it as
 * the second is how "the agent works in a worktree" becomes "the agent has the developer's home
 * directory". Cursor's own SDK documents that local agents run tools automatically by default.
 *
 * SO CONTAINMENT IS DECIDED HERE, AGAINST THE REAL FILESYSTEM. Every path is resolved with symlinks
 * followed before it is compared, because a symlink inside a registered root that points outside it
 * is the oldest way through a prefix check, and a prefix check is what a string comparison is.
 *
 * AND A PATH IS NOT AUTHORISATION. A root is registered against a task and an actor, so a job that
 * names a perfectly real directory is still refused unless that directory was registered for that
 * task. An absolute path a model produced is a request, never a grant.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** What a registration allows, so a build grant is not also a `git push` grant. */
export type OperationClass =
  /** Reading and writing files under a registered root. */
  | "workspace"
  /** Running the project's own build and test commands. */
  | "build"
  /** Driving a simulator or a device that was registered for this task. */
  | "device"
  /**
   * Asking the toolchain what exists: `simctl list`, `avdmanager list`, `xcodebuild -version`.
   *
   * SEPARATE FROM `device` BECAUSE LISTING IS NOT DRIVING. A `device` job must name a device it
   * reserved, which is the right rule for installing a build or tapping a screen and the wrong one
   * for finding out which simulators there are — a task cannot reserve a device before it knows
   * which devices exist. Folding the two together made discovery impossible, which is how a
   * capability ends up being granted more broadly than it needs: the obvious fix is to hand out
   * `device` for everything.
   *
   * It reserves nothing and touches no device, so it is the weakest class here.
   */
  | "discovery"
  /** Git operations in a registered root, including pushing a branch. */
  | "vcs";

export const OPERATION_CLASSES: OperationClass[] = [
  "workspace",
  "build",
  "device",
  "discovery",
  "vcs",
];

export type Registration = {
  taskId: string;
  /** The person this work is for. A job presenting a different one is refused. */
  actorId: string;
  /** Absolute, symlink-resolved roots this task may touch. */
  roots: string[];
  /** Simulator UDIDs or adb serials this task has reserved. */
  devices: string[];
  /** What this task may do at all. Absent classes are refused, not warned about. */
  operations: OperationClass[];
  /**
   * The fence the reservation was admitted with.
   *
   * Carried here so a job from a worker whose task was taken away is refused by the same comparison
   * that stops it acting anywhere else. Without it this service would be the one place a replaced
   * worker could still reach the filesystem.
   */
  fence: number;
};

export type ScopeRefusal = { ok: false; reason: string };
export type ScopeVerdict<T> = { ok: true; value: T } | ScopeRefusal;

/**
 * Is `candidate` really inside `root`?
 *
 * `relative()` rather than `startsWith`, because `/tmp/work` is a prefix of `/tmp/work-other` and a
 * string comparison says yes. A path inside a root produces a relative path that neither starts with
 * `..` nor is absolute; anything else is outside it. The equal case is inside: the root itself is
 * the root.
 */
export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Resolve a path the way the filesystem sees it, or say it cannot be resolved.
 *
 * SYMLINKS FOLLOWED FIRST, ALWAYS. `path.resolve` collapses `..` textually and knows nothing about
 * links, so a `node_modules/escape -> /Users/someone` inside a registered worktree passes every
 * textual check and lands wherever it points.
 *
 * A path that does not exist yet is resolved against its nearest existing ancestor, because writing
 * a NEW file is ordinary and `realpath` refuses a path with no inode. The ancestor is what the
 * containment question is really about: a new file under a real directory inside the root is inside
 * the root.
 *
 * THAT FALLBACK IS WRONG FOR A ROOT, which is what `mustExist` is for. A root is a place that is
 * there; a mistyped one resolving quietly to its parent would register the parent — so a typo in
 * `~/Developer/openbot-studio` would hand the task the whole of `~/Developer`. Registration asks
 * for the strict answer and a job's path asks for the forgiving one, and the difference is named
 * rather than left to whichever caller happened to be written first.
 */
export async function resolveReal(
  candidate: string,
  options: { mustExist?: boolean } = {},
): Promise<{ ok: true; path: string } | ScopeRefusal> {
  if (!isAbsolute(candidate)) {
    return {
      ok: false,
      reason:
        "A path must be absolute. A relative one is resolved against whatever the worker's process happens to be doing, which is not a boundary.",
    };
  }
  let probe = resolve(candidate);
  const trailing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await realpath(probe);
      return {
        ok: true,
        path: trailing.length ? resolve(real, ...trailing) : real,
      };
    } catch {
      if (options.mustExist) {
        return { ok: false, reason: "That path does not exist." };
      }
      const parent = resolve(probe, "..");
      if (parent === probe) {
        return { ok: false, reason: "That path could not be resolved." };
      }
      trailing.unshift(relative(parent, probe));
      probe = parent;
    }
  }
  return { ok: false, reason: "That path is nested too deeply to resolve." };
}

export type JobClaim = {
  taskId: string;
  actorId: string;
  fence: number;
  operation: OperationClass;
  /** Where the job wants to run or act. Checked against the registration, never trusted. */
  path?: string;
  /** Which device, for a device operation. */
  device?: string;
};

/**
 * May this job run?
 *
 * Every question asked in one place, so a new kind of job cannot be added without answering all of
 * them. Order matters only for the message: identity first, because "you are not who you say" is a
 * different problem from "you may not do that here", and reporting the second when the first is
 * also true sends somebody looking in the wrong place.
 */
export async function admitJob(
  registration: Registration | undefined,
  claim: JobClaim,
): Promise<ScopeVerdict<{ path?: string; device?: string }>> {
  if (!registration) {
    return {
      ok: false,
      reason: `No work is registered for ${claim.taskId}. A path is a request, not a grant: register the task's roots and devices first.`,
    };
  }
  if (registration.actorId !== claim.actorId) {
    return { ok: false, reason: "This job is for a different person." };
  }
  if (registration.fence !== claim.fence) {
    /*
     * The same comparison that stops a replaced worker acting anywhere else.
     *
     * Without it this service is the one door a fenced-off worker can still walk through, and it is
     * the door that reaches the filesystem.
     */
    return {
      ok: false,
      reason:
        "This task has been handed to another process. Stop: another worker holds it now.",
    };
  }
  if (!registration.operations.includes(claim.operation)) {
    return {
      ok: false,
      reason: `This task is not registered for ${claim.operation} operations.`,
    };
  }

  if (claim.operation === "device") {
    if (!claim.device) {
      return { ok: false, reason: "A device operation must name a device." };
    }
    if (!registration.devices.includes(claim.device)) {
      /*
       * Reserved, not merely present. Two agents driving one simulator is not a permissions
       * problem, it is two test runs interleaving on one screen and neither result meaning anything.
       */
      return {
        ok: false,
        reason: `${claim.device} is not reserved for this task. Another task may be using it.`,
      };
    }
    return { ok: true, value: { device: claim.device } };
  }

  if (!claim.path) {
    return { ok: false, reason: "This job must say where it runs." };
  }
  const resolved = await resolveReal(claim.path);
  if (!resolved.ok) return resolved;
  if (!registration.roots.some((root) => within(root, resolved.path))) {
    return {
      ok: false,
      reason: `${claim.path} is outside every directory registered for this task.`,
    };
  }
  return { ok: true, value: { path: resolved.path } };
}

/**
 * Register roots, resolving them the same way a job's path will be resolved.
 *
 * DONE ONCE, AT REGISTRATION, so a root recorded as a symlink and a job path resolved through it
 * cannot compare unequal. Registering a path that does not exist is refused: a root is a place that
 * is there, and a typo silently registering nothing is a registration that refuses everything for
 * reasons nobody can see.
 */
export async function resolveRoots(
  roots: string[],
): Promise<{ ok: true; roots: string[] } | ScopeRefusal> {
  if (roots.length === 0) {
    return { ok: false, reason: "A registration must name at least one root." };
  }
  const resolved: string[] = [];
  for (const root of roots) {
    // Strict: see the note on `mustExist`. A mistyped root that resolved to its parent would
    // register the parent, which is how one typo hands a task an entire home directory.
    const outcome = await resolveReal(root, { mustExist: true });
    if (!outcome.ok) {
      return {
        ok: false,
        reason: `${root} could not be registered: ${outcome.reason}`,
      };
    }
    resolved.push(outcome.path);
  }
  return { ok: true, roots: resolved };
}
