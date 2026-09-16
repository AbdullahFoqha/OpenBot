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
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { NativeWorker } from "../native-worker/worker";

export const STUDIO_PREFERRED_IOS_UDID = "812A595B-0FDA-4C3F-9346-088E6C07A489";
const MAESTRO_BIN_DIR = join(homedir(), ".maestro", "bin");
const DEFAULT_APP_ID = process.env.STUDIO_APP_ID?.trim() || "app.pocketlove.private";

export type InstallResult = {
  status: "skipped" | "cloned" | "release" | "expo" | "failed";
  exitCode: number | null;
  logPath: string;
};

export type ResetResult = {
  status: "skipped" | "wiped" | "failed";
  exitCode: number | null;
  logPath: string;
};

export type MaestroEvidence = {
  udid: string;
  flow: string;
  exitCode: number | null;
  outputDir: string;
  appInstalled: boolean;
  error?: string;
  durationMs: number;
  install?: InstallResult;
  reset?: ResetResult;
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
  /**
   * When true, attempt to install the app if missing.
   * Also triggered by STUDIO_MAESTRO_INSTALL=1 environment variable.
   */
  autoInstall?: boolean;
  /** Timeout for app installation (expo builds can take minutes). Defaults to 10 minutes. */
  installTimeoutMs?: number;
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


/**
 * Install mode for Maestro sim installs.
 * Default **release** (embedded JS) unless STUDIO_INSTALL_MODE or an explicit mode is set.
 * Avoids Debug Metro RedBox on unattended QE runs.
 */
export function resolveStudioInstallMode(
  explicit?: "release" | "clone" | "expo" | "auto" | string,
  env: NodeJS.ProcessEnv = process.env,
): "release" | "clone" | "expo" | "auto" {
  const raw = String(explicit ?? env.STUDIO_INSTALL_MODE ?? "release").trim().toLowerCase();
  if (raw === "clone" || raw === "expo" || raw === "auto" || raw === "release") {
    return raw;
  }
  return "release";
}

/**
 * Attempt to install the app onto the simulator.
 *
 * Prefers spawning `studio-local/install-app-on-sim.sh` relative to the openbot-studio repo root.
 * Falls back to in-process Release DerivedData / clone / expo Release if the script is unavailable.
 *
 * Install strategies (default mode=release; STUDIO_INSTALL_MODE overrides):
 * 1. studio-local/install-app-on-sim.sh when present (Release DerivedData → …)
 * 2. Release DerivedData PocketLove.app via simctl install
 * 3. Clone from another sim (auto/clone)
 * 4. Expo Release: npx expo run:ios --device <udid> --configuration Release --no-bundler
 */
export async function installApp(input: {
  projectPath: string;
  udid: string;
  appId: string;
  outputDir: string;
  /** Override to force a specific install mode. */
  mode?: "release" | "clone" | "expo" | "auto";
  /** Timeout for the install process (expo builds can take minutes). */
  timeoutMs?: number;
  /** Inject for testing. */
  runCommand?: typeof runCommand;
}): Promise<InstallResult> {
  const run = input.runCommand ?? runCommand;
  const logPath = join(input.outputDir, "install.log");
  const mode = resolveStudioInstallMode(input.mode);
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  let logs = `install: mode=${mode} udid=${input.udid} appId=${input.appId} (default release unless STUDIO_INSTALL_MODE/mode set)\n`;

  const appendLog = async (text: string) => {
    logs += text + "\n";
    await writeFile(logPath, logs).catch(() => {});
  };

  const scriptEnv = {
    ...process.env,
    STUDIO_INSTALL_MODE: mode,
  };

  try {
    // Prefer the Mac shell helper (Release DerivedData → clone → expo Release).
    // Skip when runCommand is injected (unit tests exercise in-process strategies).
    const scriptCandidates = input.runCommand
      ? ([] as string[])
      : [
      join(process.cwd(), "studio-local", "install-app-on-sim.sh"),
      join(process.cwd(), "..", "studio-local", "install-app-on-sim.sh"),
    ];
    for (const script of scriptCandidates) {
      try {
        await access(script);
        await appendLog(`SCRIPT: ${script} STUDIO_INSTALL_MODE=${mode}`);
        const result = await run(script, [input.projectPath, input.udid, input.appId], {
          timeoutMs,
          env: scriptEnv,
        });
        await appendLog(result.stdout);
        if (result.stderr) await appendLog(`stderr: ${result.stderr}`);
        await appendLog(`SCRIPT: exit=${result.exitCode}`);
        if (result.exitCode === 0) {
          const status =
            mode === "clone" ? "cloned" : mode === "expo" ? "expo" : "release";
          return { status, exitCode: 0, logPath };
        }
        await appendLog("SCRIPT: non-zero — falling back to in-process strategies");
        break;
      } catch {
        /* script missing — try next / fallback */
      }
    }

    if (mode === "release" || mode === "auto") {
      await appendLog("Attempting Release DerivedData .app install...");
      const releaseResult = await tryInstallReleaseApp(input.udid, input.appId, run);
      if (releaseResult.ok) {
        await appendLog(`RELEASE: success from ${releaseResult.appPath}`);
        return { status: "release", exitCode: 0, logPath };
      }
      await appendLog(`RELEASE: failed - ${releaseResult.reason}`);
      if (mode === "release") {
        return { status: "failed", exitCode: 1, logPath };
      }
    }

    if (mode === "auto" || mode === "clone") {
      await appendLog("Attempting clone from another simulator...");
      const cloneResult = await tryCloneFromOtherSim(input.udid, input.appId, run);
      if (cloneResult.ok) {
        await appendLog(`CLONE: success from ${cloneResult.donorUdid}`);
        return { status: "cloned", exitCode: 0, logPath };
      }
      await appendLog(`CLONE: failed - ${cloneResult.reason}`);
    }

    if (mode === "clone") {
      await appendLog("ERROR: clone-only mode requested but no donor sim available");
      return { status: "failed", exitCode: 1, logPath };
    }

    // Expo fallback: Release embeds JS (no Metro).
    await appendLog(
      `EXPO: npx expo run:ios --device ${input.udid} --configuration Release --no-bundler`,
    );
    await appendLog(`cwd=${input.projectPath}`);

    const expoResult = await run(
      "npx",
      ["expo", "run:ios", "--device", input.udid, "--configuration", "Release", "--no-bundler"],
      { cwd: input.projectPath, timeoutMs, env: scriptEnv },
    );

    await appendLog(`EXPO: exit=${expoResult.exitCode}`);
    await appendLog(expoResult.stdout);
    if (expoResult.stderr) await appendLog(`stderr: ${expoResult.stderr}`);

    if (expoResult.exitCode === 0) {
      return { status: "expo", exitCode: 0, logPath };
    }

    return { status: "failed", exitCode: expoResult.exitCode, logPath };
  } catch (err) {
    await appendLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "failed", exitCode: null, logPath };
  }
}

async function tryInstallReleaseApp(
  targetUdid: string,
  appId: string,
  run: typeof runCommand,
): Promise<{ ok: true; appPath: string } | { ok: false; reason: string }> {
  const derived = join(homedir(), "Library/Developer/Xcode/DerivedData");
  const findResult = await run("find", [
    derived,
    "-path",
    "*Release-iphonesimulator/PocketLove.app",
    "-type",
    "d",
  ]);
  if (findResult.exitCode !== 0 || !findResult.stdout.trim()) {
    return { ok: false, reason: "No Release-iphonesimulator PocketLove.app under DerivedData" };
  }
  const apps = findResult.stdout
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  // Prefer the last path find returned (often newest enough); shell script sorts by mtime.
  const appPath = apps[apps.length - 1]!;
  await run("xcrun", ["simctl", "uninstall", targetUdid, appId]);
  const installResult = await run("xcrun", ["simctl", "install", targetUdid, appPath]);
  if (installResult.exitCode !== 0) {
    return { ok: false, reason: `simctl install failed: ${installResult.stderr}` };
  }
  return { ok: true, appPath };
}

async function tryCloneFromOtherSim(
  targetUdid: string,
  appId: string,
  run: typeof runCommand,
): Promise<{ ok: true; donorUdid: string } | { ok: false; reason: string }> {
  const listResult = await run("xcrun", ["simctl", "list", "devices", "available"]);
  if (listResult.exitCode !== 0) {
    return { ok: false, reason: "Failed to list available devices" };
  }

  const udidRegex = /\(([A-F0-9-]{36})\)/gi;
  const matches = listResult.stdout.matchAll(udidRegex);

  for (const match of matches) {
    const donorUdid = match[1];
    if (!donorUdid || donorUdid === targetUdid) continue;

    const hasApp = await run("xcrun", ["simctl", "get_app_container", donorUdid, appId, "data"]);
    if (hasApp.exitCode !== 0) continue;

    const appPathResult = await run("xcrun", ["simctl", "get_app_container", donorUdid, appId, "app"]);
    if (appPathResult.exitCode !== 0 || !appPathResult.stdout.trim()) continue;

    const appPath = appPathResult.stdout.trim();
    const installResult = await run("xcrun", ["simctl", "install", targetUdid, appPath]);
    if (installResult.exitCode === 0) {
      return { ok: true, donorUdid };
    }
  }

  return { ok: false, reason: "No donor simulator found with the app installed" };
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

/**
 * Wipe app data via uninstall+reinstall of the same .app (no expo rebuild).
 * Makes needsOnboarding true again. Skip with STUDIO_MAESTRO_RESET=0.
 */
export async function resetApp(input: {
  udid: string;
  appId?: string;
  outputDir: string;
  timeoutMs?: number;
}): Promise<ResetResult> {
  const udid = input.udid;
  const appId = input.appId ?? DEFAULT_APP_ID;
  const logPath = join(input.outputDir, "reset.log");
  const lines: string[] = [];

  if (process.env.STUDIO_MAESTRO_RESET === "0") {
    lines.push("SKIP: STUDIO_MAESTRO_RESET=0");
    await writeFile(logPath, lines.join("\n") + "\n");
    return { status: "skipped", exitCode: 0, logPath };
  }

  if (!(await checkAppInstalled(udid, appId))) {
    lines.push(`SKIP: ${appId} not installed on ${udid}`);
    await writeFile(logPath, lines.join("\n") + "\n");
    return { status: "skipped", exitCode: 0, logPath };
  }

  const scriptCandidates = [
    join(process.cwd(), "studio-local", "reset-app-on-sim.sh"),
    join(process.cwd(), "..", "studio-local", "reset-app-on-sim.sh"),
  ];
  let script: string | null = null;
  for (const candidate of scriptCandidates) {
    try {
      await access(candidate);
      script = candidate;
      break;
    } catch {
      /* continue */
    }
  }

  if (script) {
    const result = await runCommand(script, [udid, appId], {
      timeoutMs: input.timeoutMs ?? 120_000,
      env: { ...process.env, STUDIO_MAESTRO_RESET: "1" },
    });
    lines.push(result.stdout, result.stderr, `exit=${result.exitCode}`);
    await writeFile(logPath, lines.join("\n") + "\n");
    if (result.exitCode !== 0) {
      return { status: "failed", exitCode: result.exitCode, logPath };
    }
    return { status: "wiped", exitCode: 0, logPath };
  }

  const stashDir = await mkdtemp(join(tmpdir(), "studio-reset-"));
  const stashApp = join(stashDir, "app.app");
  const getApp = await runCommand("xcrun", ["simctl", "get_app_container", udid, appId, "app"]);
  if (getApp.exitCode !== 0) {
    lines.push(`FAILED: get_app_container: ${getApp.stderr}`);
    await writeFile(logPath, lines.join("\n") + "\n");
    return { status: "failed", exitCode: getApp.exitCode, logPath };
  }
  const appSrc = getApp.stdout.trim();
  lines.push(`STASH: ${appSrc} → ${stashApp}`);
  await runCommand("cp", ["-R", appSrc, stashApp]);
  await runCommand("xcrun", ["simctl", "terminate", udid, appId]);
  await runCommand("xcrun", ["simctl", "uninstall", udid, appId]);
  const inst = await runCommand("xcrun", ["simctl", "install", udid, stashApp], {
    timeoutMs: input.timeoutMs ?? 120_000,
  });
  await runCommand("rm", ["-rf", stashDir]);
  lines.push(inst.stdout, inst.stderr, `install_exit=${inst.exitCode}`);
  await writeFile(logPath, lines.join("\n") + "\n");
  const ok = await checkAppInstalled(udid, appId);
  return { status: ok ? "wiped" : "failed", exitCode: inst.exitCode, logPath };
}

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
    const forceInstall = process.env.STUDIO_MAESTRO_INSTALL === "1";

    if (!evidence.appInstalled || forceInstall) {
      const shouldInstall = input.autoInstall || forceInstall;

      if (shouldInstall) {
        const installResult = await installApp({
          projectPath: input.projectPath,
          udid,
          appId,
          outputDir,
          timeoutMs: input.installTimeoutMs,
        });

        evidence.install = installResult;

        if (installResult.status === "skipped") {
          evidence.appInstalled = true;
        } else if (installResult.status === "cloned" || installResult.status === "expo") {
          evidence.appInstalled = await checkAppInstalled(udid, appId);
        }

        if (!evidence.appInstalled) {
          evidence.durationMs = Date.now() - started;
          evidence.error = `App ${appId} not installed on ${udid} after install attempt (${installResult.status})`;
          const blockerPath = join(outputDir, "blocker.txt");
          await writeFile(
            blockerPath,
            `APP_INSTALL_FAILED:${appId} on ${udid}\n` +
              `Install status: ${installResult.status}, exit code: ${installResult.exitCode}\n` +
              `See ${installResult.logPath} for details.\n`,
          );
          return {
            ok: false,
            reason: `App ${appId} install failed on simulator ${udid}. Check ${installResult.logPath}`,
            evidence,
          };
        }
      } else {
        evidence.durationMs = Date.now() - started;
        evidence.error = `App ${appId} not installed on ${udid}`;
        const blockerPath = join(outputDir, "blocker.txt");
        await writeFile(
          blockerPath,
          `APP_NOT_INSTALLED:${appId} on ${udid} — install Release build, then re-run.\n` +
            `Hint: preferred free sim is iPhone 17 Pro (${STUDIO_PREFERRED_IOS_UDID}).\n` +
            `Set STUDIO_MAESTRO_INSTALL=1 to force auto-install.\n`,
        );
        return {
          ok: false,
          reason: `App ${appId} not installed on simulator ${udid}. Install the Release build first, or set STUDIO_MAESTRO_INSTALL=1.`,
          evidence,
        };
      }
    } else {
      evidence.install = {
        status: "skipped",
        exitCode: null,
        logPath: join(outputDir, "install.log"),
      };
      await writeFile(
        join(outputDir, "install.log"),
        `install: skipped (app already present on ${udid})\n`,
      ).catch(() => {});
    }

    if (process.env.STUDIO_MAESTRO_RESET !== "0" && (await checkAppInstalled(udid, appId))) {
      const resetResult = await resetApp({ udid, appId, outputDir });
      evidence.reset = resetResult;
      if (resetResult.status === "failed") {
        evidence.durationMs = Date.now() - started;
        evidence.error = `App reset failed on ${udid}`;
        return {
          ok: false,
          reason: `App reset failed on ${udid}. See ${resetResult.logPath}`,
          evidence,
        };
      }
    } else {
      evidence.reset = {
        status: "skipped",
        exitCode: null,
        logPath: join(outputDir, "reset.log"),
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
