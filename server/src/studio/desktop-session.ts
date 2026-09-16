/**
 * P0.3 — Mac desktop GUI session (not Cursor coding).
 *
 * Drives local apps via osascript + /usr/sbin/screencapture. Evidence screenshots
 * land under studio-local/ui-test/out/desktop/<stamp>/.
 *
 * Safety (hard limits):
 * - Never escalates privileges (no sudo, no admin prompts automation).
 * - No arbitrary shell steps. Destructive OS actions (erase disk, change
 *   security, mass delete, password prompts) are out of scope and refused.
 * - UI click/keystroke via System Events needs macOS Accessibility for the
 *   process running the studio server; app-dictionary scripting (e.g. TextEdit
 *   text) works without Accessibility and is preferred for proves.
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
  | { action: "type"; text: string; app?: string }
  | { action: "keystroke"; text: string }
  | { action: "click"; x: number; y: number }
  | { action: "quit"; app: string; saving?: "yes" | "no" | "ask" };

export type DesktopSessionInfo = {
  id: string;
  status: "starting" | "running" | "stopping" | "stopped" | "error";
  app: string | null;
  stamp: string;
  outDir: string;
  screenshots: string[];
  log: string[];
  startedAt: string;
  stoppedAt?: string;
  error?: string;
};

/** Apps we refuse to drive (privilege / destructive surface). */
const DENIED_APPS = new Set(
  [
    "terminal",
    "iterm",
    "iterm2",
    "warp",
    "system settings",
    "system preferences",
    "securityagent",
    "disk utility",
    "keychain access",
    "users & groups",
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

function assertSafeApp(app: string): void {
  const key = app.trim().toLowerCase();
  if (!key) throw new Error("app name is required.");
  if (DENIED_APPS.has(key) || key.includes("sudo") || key.includes("password")) {
    throw new Error(
      `Refusing to drive app "${app}" — privilege/destructive OS surfaces are out of scope for studio_desktop_session.`,
    );
  }
}

function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runCommand(cmd: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: ${cmd.join(" ")}`));
    }, timeoutMs);
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
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function osascript(lines: string): Promise<string> {
  const result = await runCommand(["/usr/bin/osascript", "-e", lines], 45_000);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `osascript failed (${result.code})`);
  }
  return result.stdout;
}

let session: DesktopSessionInfo | null = null;
let abortRequested = false;
let runLock: Promise<void> | null = null;

export function getDesktopSession(): DesktopSessionInfo | null {
  return session
    ? { ...session, screenshots: [...session.screenshots], log: [...session.log] }
    : null;
}

function logLine(msg: string): void {
  if (session) session.log.push(`${new Date().toISOString()} ${msg}`);
}

async function takeShot(name: string): Promise<string> {
  if (!session) throw new Error("No active desktop session.");
  const file = name.endsWith(".png") ? name : `${name}.png`;
  const path = join(session.outDir, file);
  const result = await runCommand(["/usr/sbin/screencapture", "-x", "-t", "png", path], 20_000);
  if (result.code !== 0) {
    throw new Error(result.stderr || `screencapture failed (${result.code})`);
  }
  session.screenshots.push(path);
  logLine(`screenshot ${path}`);
  return path;
}

async function activateApp(app: string): Promise<void> {
  assertSafeApp(app);
  await osascript(`tell application "${escapeAppleScriptString(app)}" to activate`);
  session!.app = app;
  logLine(`activate ${app}`);
}

async function openApp(app: string): Promise<void> {
  assertSafeApp(app);
  const result = await runCommand(["/usr/bin/open", "-a", app], 20_000);
  if (result.code !== 0) {
    throw new Error(result.stderr || `open -a failed for ${app}`);
  }
  session!.app = app;
  logLine(`open ${app}`);
  await new Promise((r) => setTimeout(r, 400));
}

async function typeText(text: string, app?: string): Promise<void> {
  if (text.length > 4000) throw new Error("type text too long (max 4000 chars).");
  const target = (app || session?.app || "").trim();
  // Prefer app-dictionary scripting (no Accessibility) for TextEdit.
  if (!target || /^textedit$/i.test(target)) {
    assertSafeApp(target || "TextEdit");
    const escaped = escapeAppleScriptString(text);
    await osascript(`
tell application "TextEdit"
  activate
  if (count of documents) is 0 then
    make new document with properties {text:"${escaped}"}
  else
    set text of front document to (text of front document) & "${escaped}"
  end if
end tell`);
    session!.app = "TextEdit";
    logLine(`type via TextEdit dictionary (${text.length} chars)`);
    return;
  }
  // Fallback: System Events keystroke (requires Accessibility).
  assertSafeApp(target);
  await activateApp(target);
  const escaped = escapeAppleScriptString(text);
  try {
    await osascript(`
tell application "System Events"
  keystroke "${escaped}"
end tell`);
    logLine(`keystroke via System Events (${text.length} chars)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message} — Grant Accessibility to the studio server host process, or use type with app TextEdit (dictionary scripting).`,
    );
  }
}

async function keystroke(text: string): Promise<void> {
  if (text.length > 4000) throw new Error("keystroke text too long.");
  const escaped = escapeAppleScriptString(text);
  try {
    await osascript(`
tell application "System Events"
  keystroke "${escaped}"
end tell`);
    logLine(`keystroke (${text.length} chars)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message} — System Events keystroke needs macOS Accessibility for the studio server process.`,
    );
  }
}

async function clickAt(x: number, y: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click requires numeric x,y.");
  if (x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error("click coordinates out of range.");
  // Prefer cliclick when installed; else System Events (needs Accessibility).
  const which = await runCommand(["/usr/bin/which", "cliclick"], 5_000).catch(() => null);
  if (which && which.code === 0 && which.stdout) {
    const result = await runCommand([which.stdout, `c:${Math.round(x)},${Math.round(y)}`], 10_000);
    if (result.code !== 0) throw new Error(result.stderr || "cliclick failed");
    logLine(`click cliclick ${x},${y}`);
    return;
  }
  try {
    await osascript(`
tell application "System Events"
  click at {${Math.round(x)}, ${Math.round(y)}}
end tell`);
    logLine(`click System Events ${x},${y}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message} — Install cliclick or grant Accessibility for System Events click.`,
    );
  }
}

async function quitApp(app: string, saving: "yes" | "no" | "ask" = "no"): Promise<void> {
  assertSafeApp(app);
  const savingClause =
    saving === "ask" ? "" : saving === "yes" ? " saving yes" : " saving no";
  try {
    await osascript(`tell application "${escapeAppleScriptString(app)}" to quit${savingClause}`);
    logLine(`quit ${app}`);
  } catch (err) {
    logLine(`quit ${app} warning: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runDesktopSteps(steps: DesktopStep[]): Promise<void> {
  if (!session) throw new Error("No active desktop session.");
  let shotIndex = session.screenshots.length + 1;
  for (const step of steps) {
    if (abortRequested) throw new Error("Session aborted.");
    switch (step.action) {
      case "wait":
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(step.ms, 60_000))));
        logLine(`wait ${step.ms}ms`);
        break;
      case "screenshot":
        await takeShot(step.name ?? `${String(shotIndex++).padStart(2, "0")}-shot`);
        break;
      case "activate":
        await activateApp(step.app);
        break;
      case "open":
        await openApp(step.app);
        break;
      case "type":
        await typeText(step.text, step.app);
        break;
      case "keystroke":
        await keystroke(step.text);
        break;
      case "click":
        await clickAt(step.x, step.y);
        break;
      case "quit":
        await quitApp(step.app, step.saving ?? "no");
        break;
      default:
        throw new Error(`Unknown desktop step: ${(step as { action: string }).action}`);
    }
  }
}

export async function startDesktopSession(input: {
  app?: string;
  steps?: DesktopStep[];
}): Promise<{ ok: true; session: DesktopSessionInfo } | { ok: false; error: string; status: 400 | 409 }> {
  if (session && (session.status === "running" || session.status === "starting")) {
    return { ok: false, error: "A desktop session is already running. Stop it first.", status: 409 };
  }
  if (runLock) {
    return { ok: false, error: "A desktop session start/stop is already in progress.", status: 409 };
  }
  if (process.platform !== "darwin") {
    return { ok: false, error: "studio_desktop_session only runs on macOS.", status: 400 };
  }

  abortRequested = false;
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
    log: [],
    startedAt: new Date().toISOString(),
  };

  runLock = (async () => {
    try {
      if (input.app?.trim()) {
        await openApp(input.app.trim());
        await new Promise((r) => setTimeout(r, 500));
      }
      await takeShot("01-start");
      if (input.steps?.length) await runDesktopSteps(input.steps);
      if (abortRequested) throw new Error("Session aborted.");
      session!.status = "running";
      await writeFile(join(outDir, "session.json"), JSON.stringify(getDesktopSession(), null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (session) {
        session.status = "error";
        session.error = message;
        session.stoppedAt = new Date().toISOString();
      }
      throw err;
    }
  })();

  try {
    await runLock;
  } catch (err) {
    runLock = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: 400 };
  } finally {
    runLock = null;
  }

  return { ok: true, session: getDesktopSession()! };
}

export async function actionDesktopSession(
  steps: DesktopStep[],
): Promise<{ ok: true; session: DesktopSessionInfo } | { ok: false; error: string; status: 400 | 409 }> {
  if (!session || session.status !== "running") {
    return { ok: false, error: "No running desktop session. Start one first.", status: 409 };
  }
  if (!steps.length) return { ok: false, error: "steps required.", status: 400 };
  if (runLock) return { ok: false, error: "Session busy.", status: 409 };
  runLock = runDesktopSteps(steps)
    .then(async () => {
      await writeFile(join(session!.outDir, "session.json"), JSON.stringify(getDesktopSession(), null, 2));
    })
    .finally(() => {
      runLock = null;
    });
  try {
    await runLock;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: 400 };
  }
  return { ok: true, session: getDesktopSession()! };
}

export async function stopDesktopSession(): Promise<{ ok: true; session: DesktopSessionInfo | null }> {
  abortRequested = true;
  if (session && (session.status === "running" || session.status === "starting")) {
    session.status = "stopping";
  }
  if (runLock) {
    try {
      await runLock;
    } catch {
      /* ignore */
    }
  }
  if (session) {
    try {
      await takeShot("99-stop").catch(() => undefined);
    } catch {
      /* ignore */
    }
    if (session.status !== "error") session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    try {
      await writeFile(join(session.outDir, "session.json"), JSON.stringify(getDesktopSession(), null, 2));
    } catch {
      /* ignore */
    }
  }
  return { ok: true, session: getDesktopSession() };
}
