/**
 * The scoped Mac worker.
 *
 * A deliberate new execution capability on somebody's actual laptop, which is why almost all of this
 * file is about what it will NOT do. The existing `host_run_command` path is not this: it prompts a
 * person for each exact command and runs it in an offline Linux container, and it stays exactly as
 * it is. Removing its checks and quietly making its shell a macOS shell would have been the small
 * change; it would also have turned an audited, approved, sandboxed door into an unsandboxed one
 * under the same name.
 *
 * WHAT IT IS FOR. `xcodebuild`, `simctl`, `gradle`, `adb` and Maestro cannot run in a Linux
 * container and cannot be driven by a browser. A studio that cannot build the app it is writing is
 * a studio that reviews diffs, so this exists — bounded by registration rather than by trust.
 *
 * THE SCOPE IS DECLARED BEFORE EXECUTION, NOT DURING IT. Registration names the task's roots, its
 * reserved devices and which classes of operation it may perform. That is what makes routine
 * authorised builds possible without a prompt for every command, and it is also what makes the
 * refusals specific: a task registered for `build` in one worktree cannot read another worktree,
 * cannot touch a device it did not reserve, and cannot push a branch.
 */
import { createServer } from "node:http";
import {
  admitJob,
  type OperationClass,
  type Registration,
  resolveRoots,
} from "./scope";
import { nativeEnvironment, type RunOutcome, runNative } from "./run";

export type NativeWorkerOptions = {
  /**
   * The shared secret the deployment presents.
   *
   * This service must never be reachable without one. It runs commands on somebody's laptop, so
   * "only bound to loopback" is not a boundary on a machine where anything the person runs is also
   * on loopback.
   */
  token: string;
  /** Composed from this rather than from `process.env`. See `nativeEnvironment`. */
  ambientEnvironment?: Record<string, string | undefined>;
  /** Injected so tests do not spawn anything. */
  run?: typeof runNative;
  /** Injected so a test can pin them. */
  now?: () => number;
};

/**
 * A port set aside for one worktree.
 *
 * WHY THIS IS HERE AT ALL. Two React Native worktrees both start Metro on 8081, and the second one
 * either fails or — worse — the second build attaches to the FIRST worktree's bundler and tests code
 * from the wrong branch while reporting the right one. Ports are a resource like a device, so they
 * are reserved like one.
 */
export type PortLease = { taskId: string; port: number; purpose: string };

export type NativeWorker = {
  /** Declare a task's scope. Refused unless every root really exists. */
  register: (input: {
    taskId: string;
    actorId: string;
    fence: number;
    roots: string[];
    devices?: string[];
    operations: OperationClass[];
  }) => Promise<
    { ok: true; registration: Registration } | { ok: false; reason: string }
  >;
  /** Drop a task's scope. Always allowed; see `admission.ts`'s note on revoking. */
  release: (taskId: string) => void;
  registration: (taskId: string) => Registration | undefined;
  /** Run one command, if the task is registered for it and the directory is inside its roots. */
  run: (input: {
    taskId: string;
    actorId: string;
    fence: number;
    operation: OperationClass;
    command: string;
    args: string[];
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }) => Promise<
    { ok: true; result: RunOutcome } | { ok: false; reason: string }
  >;
  /** Take a port for one worktree, or say who has it. */
  takePort: (input: {
    taskId: string;
    purpose: string;
    from?: number;
  }) => { ok: true; lease: PortLease } | { ok: false; reason: string };
  ports: () => PortLease[];
  /** The loopback service, for a worker running outside this process. */
  serve: (port: number) => { stop: () => Promise<void>; port: number };
};

/** The longest one command may take. A full clean iOS build on a cold cache is minutes, not hours. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/** Where per-worktree ports are handed out from. Above the ranges the usual tools default to. */
const PORT_FLOOR = 18_000;
const PORT_CEILING = 18_500;

export function createNativeWorker(options: NativeWorkerOptions): NativeWorker {
  const registrations = new Map<string, Registration>();
  const leases: PortLease[] = [];
  const run = options.run ?? runNative;
  const ambient = options.ambientEnvironment ?? process.env;

  const worker: NativeWorker = {
    async register(input) {
      const roots = await resolveRoots(input.roots);
      if (!roots.ok) return { ok: false, reason: roots.reason };
      if (input.operations.length === 0) {
        return {
          ok: false,
          reason:
            "A registration with no operations permits nothing. Name what this task may do.",
        };
      }
      /*
       * Devices are reserved exclusively, across tasks.
       *
       * Two agents driving one simulator is not a permissions problem: it is two test runs
       * interleaving on one screen, and neither result means anything afterwards.
       */
      for (const device of input.devices ?? []) {
        for (const [otherTask, other] of registrations) {
          if (otherTask !== input.taskId && other.devices.includes(device)) {
            return {
              ok: false,
              reason: `${device} is already reserved by ${otherTask}.`,
            };
          }
        }
      }
      const registration: Registration = {
        taskId: input.taskId,
        actorId: input.actorId,
        fence: input.fence,
        roots: roots.roots,
        devices: input.devices ?? [],
        operations: input.operations,
      };
      registrations.set(input.taskId, registration);
      return { ok: true, registration };
    },

    release(taskId) {
      registrations.delete(taskId);
      for (let index = leases.length - 1; index >= 0; index -= 1) {
        if (leases[index]?.taskId === taskId) leases.splice(index, 1);
      }
    },

    registration: (taskId) => registrations.get(taskId),

    async run(input) {
      const admitted = await admitJob(registrations.get(input.taskId), {
        taskId: input.taskId,
        actorId: input.actorId,
        fence: input.fence,
        operation: input.operation,
        path: input.cwd,
      });
      if (!admitted.ok) return { ok: false, reason: admitted.reason };

      const result = await run({
        command: input.command,
        args: input.args,
        // The RESOLVED path, not the one that was asked for. A caller that passed a symlink gets the
        // place it actually points at, which is the place that was checked.
        cwd: admitted.value.path as string,
        env: nativeEnvironment(ambient, input.env ?? {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { ok: true, result };
    },

    takePort(input) {
      const existing = leases.find(
        (lease) =>
          lease.taskId === input.taskId && lease.purpose === input.purpose,
      );
      // Idempotent: a worker that restarts and asks again wants the port it already has, not a
      // second one, and certainly not a refusal.
      if (existing) return { ok: true, lease: existing };
      const taken = new Set(leases.map((lease) => lease.port));
      for (
        let port = Math.max(input.from ?? PORT_FLOOR, PORT_FLOOR);
        port < PORT_CEILING;
        port += 1
      ) {
        if (taken.has(port)) continue;
        const lease = { taskId: input.taskId, port, purpose: input.purpose };
        leases.push(lease);
        return { ok: true, lease };
      }
      return {
        ok: false,
        reason: `Every port between ${PORT_FLOOR} and ${PORT_CEILING} is already leased.`,
      };
    },

    ports: () => leases.map((lease) => ({ ...lease })),

    serve(port) {
      /*
       * Loopback AND a token.
       *
       * The address stops another machine; the token stops everything else on this one. A service
       * that runs commands on a laptop is not protected by being local, because everything the
       * person runs is also local.
       */
      const server = createServer(async (request, response) => {
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (request.headers["x-openbot-worker-token"] !== options.token) {
          return send(401, { error: "Not authorised." });
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return send(400, { error: "A JSON body is required." });
        }
        try {
          if (request.url === "/register") {
            return send(200, await worker.register(body as never));
          }
          if (request.url === "/run") {
            return send(200, await worker.run(body as never));
          }
          if (request.url === "/port") {
            return send(200, worker.takePort(body as never));
          }
          if (request.url === "/release") {
            worker.release(String((body as { taskId?: unknown }).taskId ?? ""));
            return send(200, { ok: true });
          }
          return send(404, { error: "No such operation." });
        } catch (error) {
          // The reason, never the stack: a stack from this process names paths and module layout on
          // somebody's laptop, and the caller is a model.
          return send(500, {
            error: error instanceof Error ? error.message : "Unknown failure.",
          });
        }
      });
      server.listen(port, "127.0.0.1");
      return {
        port,
        stop: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      };
    },
  };

  return worker;
}
