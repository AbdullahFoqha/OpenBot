/**
 * Maestro UI test runner for the studio.
 *
 * This module handles:
 * 1. Reserving an iOS simulator UDID via native-worker device lease
 * 2. Booting the simulator (idempotent)
 * 3. Running one Maestro YAML flow
 * 4. Collecting evidence (logs, artifacts)
 * 5. Always releasing the device lease (try/finally)
 *
 * NOT A SECOND RESERVATION SYSTEM. Device leases go through native-worker's `register`/`release`,
 * completely separate from `studio_reservations` which is about bot admission. Two agents driving
 * one simulator is not a permissions problem — it's two test runs interleaving on one screen, and
 * neither result means anything afterwards.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { NativeWorker } from "../native-worker/worker";

export const STUDIO_PREFERRED_IOS_UDID = "812A595B-0FDA-4C3F-9346-088E6C07A489";
const MAESTRO_BIN_DIR = join(homedir(), ".maestro", "bin");
const DEFAULT_APP_ID = "app.pocketlove.private";

export type MaestroEvidence = {
  udid: string;
  flow: string;
  exitCode: number | null;
  outputDir: string;
  appInstalled: boolean;
  error?: string;
  durationMs: number;
};

export type MaestroRunInput = {
  taskId: string;
  actorId: string;
  fence: number;
  projectPath: string;
  worktreePath: string;
  /** Path to Maestro YAML, relative to projectPath or absolute. */
  flow: string;
  /** iOS Simulator UDID. Defaults to STUDIO_PREFERRED_IOS_UDID. */
  udid?: string;
  /** App bundle ID to check for. Defaults to DEFAULT_APP_ID. */
  appId?: string;
  /** Evidence output directory. Defaults to worktreePath/studio-local/ui-test/out/maestro/<timestamp>. */
  outputDir?: string;
  /** Timeout in ms for the entire Maestro run. */
  timeoutMs?: number;
};

export type MaestroRunResult =
  | { ok: true; evidence: MaestroEvidence }
  | { ok: false; reason: string; evidence?: MaestroEvidence };

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "").replace("T", "T").slice(0, 15) + "Z";
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000);
        }, options.timeoutMs)
      : null;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        exitCode: timedOut ? null : code,
        stdout: stdout.slice(-50_000),
        stderr: stderr.slice(-50_000),
      });
    });
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: null, stdout, stderr: stderr + String(err) });
    });
  });
}

async function checkAppInstalled(udid: string, appId: string): Promise<boolean> {
  const result = await runCommand("xcrun", ["simctl", "get_app_container", udid, appId, "data"]);
  return result.exitCode === 0;
}

async function bootSimulator(udid: string): Promise<{ ok: boolean; output: string }> {
  const result = await runCommand("xcrun", ["simctl", "boot", udid]);
  if (result.exitCode === 0 || result.stderr.includes("Unable to boot device in current state: Booted")) {
    return { ok: true, output: result.stdout + result.stderr };
  }
  return { ok: false, output: result.stdout + result.stderr };
}

async function waitForBoot(udid: string, maxWaitMs = 45_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const result = await runCommand("xcrun", ["simctl", "list", "devices"]);
    if (result.stdout.includes(udid) && result.stdout.includes("(Booted)")) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Parse acceptanceCriteria for a `maestro:` line.
 * Returns the path if found, undefined otherwise.
 */
export function parseMaestroFromCriteria(criteria: string | undefined): string | undefined {
  if (!criteria) return undefined;
  const match = criteria.match(/^maestro:\s*(.+)$/m);
  return match?.[1]?.trim();
}

/**
 * Parse acceptanceCriteria for a `device:` line (UDID).
 */
export function parseDeviceFromCriteria(criteria: string | undefined): string | undefined {
  if (!criteria) return undefined;
  const match = criteria.match(/^device:\s*([A-F0-9-]{36})$/im);
  return match?.[1]?.trim();
}

/**
 * Run a Maestro flow with device reservation through native-worker.
 *
 * This function:
 * 1. Registers a device lease via nativeWorker.register (NOT studio_reservations)
 * 2. Boots the simulator
 * 3. Checks app is installed (fails clearly if not)
 * 4. Runs the Maestro flow
 * 5. Collects evidence
 * 6. Always releases the lease in finally
 */
export async function runMaestro(
  nativeWorker: NativeWorker,
  input: MaestroRunInput,
): Promise<MaestroRunResult> {
  const started = Date.now();
  const udid = input.udid ?? STUDIO_PREFERRED_IOS_UDID;
  const appId = input.appId ?? DEFAULT_APP_ID;
  const stamp = timestamp();
  const outputDir = input.outputDir ?? join(input.worktreePath, "studio-local", "ui-test", "out", "maestro", stamp);

  const flowPath = isAbsolute(input.flow)
    ? input.flow
    : resolve(input.projectPath, input.flow);

  await mkdir(outputDir, { recursive: true });

  const evidence: MaestroEvidence = {
    udid,
    flow: flowPath,
    exitCode: null,
    outputDir,
    appInstalled: false,
    durationMs: 0,
  };

  const registerResult = await nativeWorker.register({
    taskId: input.taskId,
    actorId: input.actorId,
    fence: input.fence,
    roots: [input.worktreePath, dirname(flowPath)],
    devices: [udid],
    operations: ["discovery", "device", "build"],
  });

  if (!registerResult.ok) {
    evidence.durationMs = Date.now() - started;
    evidence.error = registerResult.reason;
    await writeFile(join(outputDir, "error.txt"), `Registration failed: ${registerResult.reason}\n`);
    return { ok: false, reason: `Device registration failed: ${registerResult.reason}`, evidence };
  }

  try {
    const bootResult = await bootSimulator(udid);
    await writeFile(join(outputDir, "boot.log"), bootResult.output);

    if (!bootResult.ok) {
      evidence.durationMs = Date.now() - started;
      evidence.error = "Failed to boot simulator";
      return { ok: false, reason: `Failed to boot simulator ${udid}`, evidence };
    }

    const booted = await waitForBoot(udid);
    if (!booted) {
      evidence.durationMs = Date.now() - started;
      evidence.error = "Simulator did not reach Booted state in time";
      return { ok: false, reason: `Simulator ${udid} did not boot in time`, evidence };
    }

    evidence.appInstalled = await checkAppInstalled(udid, appId);
    if (!evidence.appInstalled) {
      evidence.durationMs = Date.now() - started;
      evidence.error = `App ${appId} not installed on ${udid}`;
      const blockerPath = join(outputDir, "blocker.txt");
      await writeFile(
        blockerPath,
        `APP_NOT_INSTALLED:${appId} on ${udid} — install Debug build, then re-run.\n` +
          `Hint: preferred free sim is iPhone 17 Pro (${STUDIO_PREFERRED_IOS_UDID}).\n`,
      );
      return {
        ok: false,
        reason: `App ${appId} not installed on simulator ${udid}. Install the Debug build first.`,
        evidence,
      };
    }

    const metaPath = join(outputDir, "meta.txt");
    const maestroBin = join(MAESTRO_BIN_DIR, "maestro");
    const env = {
      ...process.env,
      PATH: `${MAESTRO_BIN_DIR}:${process.env.PATH ?? ""}`,
    };

    let maestroVersion = "unknown";
    const versionResult = await runCommand(maestroBin, ["--version"], { env });
    if (versionResult.exitCode === 0) {
      maestroVersion = versionResult.stdout.trim().split("\n")[0] ?? "unknown";
    }

    await writeFile(
      metaPath,
      `maestro=${maestroVersion}\n` +
        `udid=${udid}\n` +
        `flow=${flowPath}\n` +
        `out=${outputDir}\n` +
        `appId=${appId}\n` +
        `started=${new Date().toISOString()}\n`,
    );

    const artifactsDir = join(outputDir, "artifacts");
    const debugDir = join(outputDir, "debug");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(debugDir, { recursive: true });

    const maestroResult = await runCommand(
      maestroBin,
      [
        "test",
        "--udid",
        udid,
        "--test-output-dir",
        artifactsDir,
        "--debug-output",
        debugDir,
        "--flatten-debug-output",
        flowPath,
      ],
      {
        cwd: input.projectPath,
        env,
        timeoutMs: input.timeoutMs ?? 10 * 60_000,
      },
    );

    evidence.exitCode = maestroResult.exitCode;
    evidence.durationMs = Date.now() - started;

    await writeFile(join(outputDir, "maestro.log"), maestroResult.stdout + "\n" + maestroResult.stderr);
    await writeFile(
      metaPath,
      await readFile(metaPath, "utf8").catch(() => "") +
        `exit=${maestroResult.exitCode}\n` +
        `durationMs=${evidence.durationMs}\n`,
    );

    if (maestroResult.exitCode === 0) {
      return { ok: true, evidence };
    }

    evidence.error = `Maestro exited with code ${maestroResult.exitCode}`;
    return {
      ok: false,
      reason: `Maestro flow failed (exit ${maestroResult.exitCode}). Check ${outputDir}/maestro.log`,
      evidence,
    };
  } finally {
    nativeWorker.release(input.taskId);
  }
}

/**
 * Check if Maestro should run for this task.
 * Maestro runs when:
 * 1. maestroFlow is explicitly provided, OR
 * 2. acceptanceCriteria contains a `maestro:` line AND ownerBotId is quality-engineer
 */
export function shouldRunMaestro(input: {
  maestroFlow?: string;
  acceptanceCriteria?: string;
  ownerBotId: string;
}): { run: boolean; flow?: string; udid?: string } {
  if (input.maestroFlow) {
    return { run: true, flow: input.maestroFlow };
  }

  if (input.ownerBotId === "quality-engineer") {
    const flowFromCriteria = parseMaestroFromCriteria(input.acceptanceCriteria);
    const udidFromCriteria = parseDeviceFromCriteria(input.acceptanceCriteria);
    if (flowFromCriteria) {
      return { run: true, flow: flowFromCriteria, udid: udidFromCriteria };
    }
  }

  return { run: false };
}
