/**
 * P0.3 — reserved “drive my Mac GUI” session (not Cursor coding).
 *
 * Uses built-in macOS tools only: `osascript` (System Events) + `screencapture`.
 * Evidence screenshots land under studio-local/ui-test/out/desktop/<stamp>/.
 *
 * Safety (hard limits for this runner):
 * - Never escalates privileges (no sudo, no admin prompts, no TCC grant flows).
 * - Destructive OS actions are OUT OF SCOPE: deleting files, Disk Utility, changing
 *   Security & Privacy, Force Quit other apps, shutdown/restart, password dialogs.
 * - One session at a time. Prefer Calculator / TextEdit / Simulator for smoke proofs.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export type DesktopStep =
  | { action: "wait"; ms: number }
  | { action: "screenshot"; name?: string }
  | { action: "activate"; app: string }
  | { action: "open"; app: string }
  | { action: "keystroke"; text: string }
  | { action: "keyCode"; code: number }
  | { action: "type"; text: string; app?: string }
  | { action: "click"; x: number; y: number }
  | { action: "quit"; app: string; saving?: "yes" | "no" | "ask" };

export type DesktopSessionInfo = {
  id: string;
  status: "starting" | "running" | "stopping" | "stopped" | "error";
  app: string | null;
  stamp: string;
  outDir: string;
  screenshots: string[];
  lastAction?: string;
  startedAt: string;
  stoppedAt?: string;
  error?: string;
  safetyNote: string;
};

const SAFETY_NOTE =
  "No privilege escalation. Destructive OS actions (delete files, security prefs, shutdown) are out of scope.";

/** Apps we refuse to drive — security / system configuration surfaces. */
const BLOCKED_APPS = new Set(
  [
    "System Settings",
    "System Preferences",
    "SecurityAgent",
    "Disk Utility",
    "Terminal",
    "iTerm",
    "iTerm2",
    "Warp",
  ].map((s) => s.toLowerCase()),
);

function repoRoot(): string {
  return process.env.STUDIO_REPO_ROOT?.trim() || process.cwd();
}

export function desktopEvidenceRoot(): string {
  return join(repoRoot(), "studio-local", "ui-test", "out", "desktop");
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function runCommand(
  cmd: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${options?.timeoutMs ?? 30_000}ms`));
    }, options?.timeoutMs ?? 30_000);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (options?.input != null) {
      child.stdin.write(options.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function osascript(source: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("desktop_session is only supported on macOS.");
  }
  const result = await runCommand("/usr/bin/osascript", [], {
    input: source,
    timeoutMs: 45_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `osascript exit ${result.code}`);
  }
  return result.stdout.trim();
}

function assertAppAllowed(app: string): void {
  const key = app.trim().toLowerCase();
  if (!key) throw new Error("app name is required.");
  if (BLOCKED_APPS.has(key)) {
    throw new Error(`Activating “${app}” is blocked by desktop_session safety policy.`);
  }
  // Soft refuse path-looking / shell-looking names
  if (app.includes("/") || app.includes("..")) {
    throw new Error("app must be a display name or bundle id, not a path.");
  }
}

let session: DesktopSessionInfo | null = null;
let abortRequested = false;
let runLock: Promise<void> | null = null;
let shotIndex = 1;

export function getDesktopSession(): DesktopSessionInfo | null {
  return session
    ? { ...session, screenshots: [...session.screenshots], safetyNote: SAFETY_NOTE }
    : null;
}

async function takeShot(name?: string): Promise<string> {
  if (!session) throw new Error("No active desktop session.");
  const file = name
    ? name.endsWith(".png")
      ? name
      : `${name}.png`
    : `${String(shotIndex).padStart(2, "0")}-desktop.png`;
  if (!name) shotIndex += 1;
  const path = join(session.outDir, file);
  const result = await runCommand("/usr/sbin/screencapture", ["-x", path], { timeoutMs: 20_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `screencapture failed (${result.code})`);
  }
  session.screenshots.push(path);
  session.lastAction = `screenshot:${file}`;
  return path;
}

async function runOneStep(step: DesktopStep): Promise<void> {
  if (!session) throw new Error("No active desktop session.");
  if (abortRequested) throw new Error("Session aborted.");
  switch (step.action) {
    case "wait":
      await sleep(Math.min(Math.max(0, step.ms), 60_000));
      session.lastAction = `wait:${step.ms}`;
      break;
    case "screenshot":
      await takeShot(step.name);
      break;
    case "activate":
    case "open": {
      assertAppAllowed(step.app);
      const appName = step.app.trim();
      const app = escapeAppleScriptString(appName);
      try {
        await osascript(`tell application "${app}" to activate`);
      } catch {
        const opened = await runCommand("/usr/bin/open", ["-a", appName], { timeoutMs: 20_000 });
        if (opened.code !== 0) {
          throw new Error(opened.stderr.trim() || `open -a ${appName} failed`);
        }
        await sleep(400);
        await osascript(`tell application "${app}" to activate`);
      }
      session.app = appName;
      session.lastAction = `${step.action}:${appName}`;
      break;
    }
    case "keystroke": {
      const text = escapeAppleScriptString(step.text);
      await osascript(`tell application "System Events" to keystroke "${text}"`);
      session.lastAction = `keystroke:${step.text.slice(0, 40)}`;
      break;
    }
    case "type": {
      if (step.app?.trim()) {
        assertAppAllowed(step.app);
        const appName = step.app.trim();
        const app = escapeAppleScriptString(appName);
        await osascript(`tell application "${app}" to activate`);
        session.app = appName;
        await sleep(300);
        if (appName.toLowerCase() === "textedit") {
          const body = escapeAppleScriptString(step.text);
          await osascript(`tell application "TextEdit"
  if (count of documents) is 0 then make new document
  set text of front document to (text of front document) & "${body}"
end tell`);
        } else {
          const text = escapeAppleScriptString(step.text);
          await osascript(`tell application "System Events" to keystroke "${text}"`);
        }
      } else {
        const text = escapeAppleScriptString(step.text);
        await osascript(`tell application "System Events" to keystroke "${text}"`);
      }
      session.lastAction = `type:${step.text.slice(0, 40)}`;
      break;
    }
    case "keyCode": {
      const code = Math.floor(step.code);
      if (!Number.isFinite(code) || code < 0 || code > 255) {
        throw new Error("keyCode must be 0–255.");
      }
      await osascript(`tell application "System Events" to key code ${code}`);
      session.lastAction = `keyCode:${code}`;
      break;
    }
    case "click": {
      const x = Math.floor(step.x);
      const y = Math.floor(step.y);
      if (![x, y].every((n) => Number.isFinite(n) && n >= 0 && n < 10000)) {
        throw new Error("click x/y must be finite screen coordinates.");
      }
      await osascript(`tell application "System Events" to click at {${x}, ${y}}`);
      session.lastAction = `click:${x},${y}`;
      break;
    }
    case "quit": {
      assertAppAllowed(step.app);
      const app = escapeAppleScriptString(step.app.trim());
      const saving = step.saving ?? "no";
      if (saving === "ask") {
        await osascript(`tell application "${app}" to quit`);
      } else {
        const savingBool = saving === "yes" ? "true" : "false";
        await osascript(`tell application "${app}" to quit saving ${savingBool}`);
      }
      session.lastAction = `quit:${step.app}`;
      break;
    }
    default:
      throw new Error(`Unknown desktop step.`);
  }
}

export async function runDesktopActions(
  steps: DesktopStep[],
): Promise<{ ok: true; session: DesktopSessionInfo } | { ok: false; error: string; status: 400 | 409 }> {
  if (!session || (session.status !== "running" && session.status !== "starting")) {
    return { ok: false, error: "No running desktop session. Start one first.", status: 409 };
  }
  if (runLock) {
    return { ok: false, error: "A desktop action is already in progress.", status: 409 };
  }
  runLock = (async () => {
    for (const step of steps) {
      if (abortRequested) throw new Error("Session aborted.");
      await runOneStep(step);
    }
    await writeFile(join(session!.outDir, "session.json"), JSON.stringify(getDesktopSession(), null, 2));
  })();
  try {
    await runLock;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (session) {
      session.status = "error";
      session.error = message;
    }
    runLock = null;
    return { ok: false, error: message, status: 400 };
  } finally {
    runLock = null;
  }
  return { ok: true, session: getDesktopSession()! };
}

export async function startDesktopSession(input: {
  app?: string;
  steps?: DesktopStep[];
}): Promise<{ ok: true; session: DesktopSessionInfo } | { ok: false; error: string; status: 400 | 409 }> {
  if (process.platform !== "darwin") {
    return { ok: false, error: "desktop_session is only supported on macOS.", status: 400 };
  }
  if (session && (session.status === "running" || session.status === "starting")) {
    return { ok: false, error: "A desktop session is already running. Stop it first.", status: 409 };
  }
  if (runLock) {
    return { ok: false, error: "A desktop start/stop is already in progress.", status: 409 };
  }

  abortRequested = false;
  shotIndex = 1;
  const stamp = stampNow();
  const outDir = join(desktopEvidenceRoot(), stamp);
  await mkdir(outDir, { recursive: true });

  session = {
    id: `desktop-${randomUUID().slice(0, 8)}`,
    status: "starting",
    app: input.app?.trim() || null,
    stamp,
    outDir,
    screenshots: [],
    startedAt: new Date().toISOString(),
    safetyNote: SAFETY_NOTE,
  };

  const bootstrap: DesktopStep[] = [];
  if (input.app?.trim()) {
    bootstrap.push({ action: "activate", app: input.app.trim() });
    bootstrap.push({ action: "wait", ms: 400 });
  }
  bootstrap.push({ action: "screenshot", name: "01-after-start" });
  const extra = input.steps ?? [];

  runLock = (async () => {
    for (const step of [...bootstrap, ...extra]) {
      if (abortRequested) throw new Error("Session aborted.");
      await runOneStep(step);
    }
    session!.status = "running";
    await writeFile(join(outDir, "session.json"), JSON.stringify(getDesktopSession(), null, 2));
  })();

  try {
    await runLock;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (session) {
      session.status = "error";
      session.error = message;
      session.stoppedAt = new Date().toISOString();
    }
    runLock = null;
    return { ok: false, error: message, status: 400 };
  } finally {
    runLock = null;
  }

  return { ok: true, session: getDesktopSession()! };
}

export async function stopDesktopSession(): Promise<{
  ok: true;
  session: DesktopSessionInfo | null;
}> {
  abortRequested = true;
  if (session && (session.status === "running" || session.status === "starting")) {
    session.status = "stopping";
  }
  if (runLock) {
    try {
      await runLock;
    } catch {
      // start/action already recorded
    }
  }
  if (session) {
    if (session.status !== "error") session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    try {
      await writeFile(join(session.outDir, "session.json"), JSON.stringify(getDesktopSession(), null, 2));
    } catch {
      // ignore
    }
  }
  return { ok: true, session: getDesktopSession() };
}

export function parseDesktopSteps(raw: unknown): DesktopStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: DesktopStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (s.action === "wait" && typeof s.ms === "number") {
      steps.push({ action: "wait", ms: s.ms });
    } else if (s.action === "screenshot") {
      steps.push({
        action: "screenshot",
        name: typeof s.name === "string" ? s.name : undefined,
      });
    } else if (s.action === "activate" && typeof s.app === "string") {
      steps.push({ action: "activate", app: s.app });
    } else if (s.action === "open" && typeof s.app === "string") {
      steps.push({ action: "open", app: s.app });
    } else if (s.action === "keystroke" && typeof s.text === "string") {
      steps.push({ action: "keystroke", text: s.text });
    } else if (s.action === "type" && typeof s.text === "string") {
      steps.push({
        action: "type",
        text: s.text,
        app: typeof s.app === "string" ? s.app : undefined,
      });
    } else if (s.action === "keyCode" && typeof s.code === "number") {
      steps.push({ action: "keyCode", code: s.code });
    } else if (s.action === "click" && typeof s.x === "number" && typeof s.y === "number") {
      steps.push({ action: "click", x: s.x, y: s.y });
    } else if (s.action === "quit" && typeof s.app === "string") {
      const saving =
        s.saving === "yes" || s.saving === "no" || s.saving === "ask" ? s.saving : undefined;
      steps.push({ action: "quit", app: s.app, saving });
    }
  }
  return steps;
}
