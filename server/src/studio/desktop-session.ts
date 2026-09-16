/**
 * P0.3 — Mac desktop GUI session (not Cursor coding).
 *
 * Drives the local Mac with osascript (System Events) + /usr/sbin/screencapture.
 * Evidence screenshots land under studio-local/ui-test/out/desktop/<stamp>/.
 *
 * Safety (hard limits — not preferences):
 * - No privilege escalation (never sudo / admin prompts / authorization).
 * - No arbitrary shell. Only activate / click / type / key / wait / screenshot.
 * - Destructive OS actions (erase disk, change security prefs, send mail as user
 *   without an explicit product tool, etc.) are OUT OF SCOPE and refused if
 *   someone tries to smuggle them via a "shell" or "open" step.
 * - One session at a time.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export type DesktopStep =
  | { action: "wait"; ms: number }
  | { action: "screenshot"; name?: string }
  | { action: "activate"; app: string }
  | { action: "click"; x: number; y: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string; modifiers?: string[] };

export type DesktopSessionInfo = {
  id: string;
  status: "starting" | "running" | "stopping" | "stopped" | "error";
  app: string | null;
  stamp: string;
  outDir: string;
  screenshots: string[];
  startedAt: string;
  stoppedAt?: string;
  error?: string;
  backend: "osascript+screencapture";
};

const ALLOWED_KEYS = new Set([
  "return",
  "enter",
  "tab",
  "escape",
  "space",
  "delete",
  "backspace",
  "up",
  "down",
  "left",
  "right",
]);

const ALLOWED_MODIFIERS = new Set(["command", "option", "control", "shift"]);

/** Apps we refuse to activate (security / privilege surfaces). */
const BLOCKED_APP_PATTERNS = [
  /system preferences/i,
  /system settings/i,
  /securityagent/i,
  /password/i,
  /keychain/i,
  /terminal/i,
  /iterm/i,
  /sudo/i,
];

function repoRoot(): string {
  return process.env.STUDIO_REPO_ROOT?.trim() || process.cwd();
}

export function desktopEvidenceRoot(): string {
  return join(repoRoot(), "studio-local", "ui-test", "out", "desktop");
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runCapture(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function osascript(script: string): Promise<void> {
  const result = await runCapture("/usr/bin/osascript", ["-"], script);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `osascript failed (${result.code})`);
  }
}

function assertSafeApp(app: string): void {
  const trimmed = app.trim();
  if (!trimmed || trimmed.length > 120) {
    throw new Error("app name/bundle is required and must be short.");
  }
  if (/[\r\n;`|$]/.test(trimmed)) {
    throw new Error("app name contains unsafe characters.");
  }
  for (const re of BLOCKED_APP_PATTERNS) {
    if (re.test(trimmed)) {
      throw new Error(`Activating “${trimmed}” is blocked for safety (privilege / shell surface).`);
    }
  }
}

function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

let session: DesktopSessionInfo | null = null;
let abortRequested = false;
let runLock: Promise<void> | null = null;
let shotIndex = 1;

export function getDesktopSession(): DesktopSessionInfo | null {
  return session ? { ...session, screenshots: [...session.screenshots] } : null;
}

async function takeShot(name?: string): Promise<string> {
  if (!session) throw new Error("No active desktop session.");
  const file = (name ?? `${String(shotIndex++).padStart(2, "0")}-shot`).replace(/\.png$/i, "") + ".png";
  const path = join(session.outDir, file);
  const result = await runCapture("/usr/sbin/screencapture", ["-x", "-T", "0", path]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `screencapture failed (${result.code})`);
  }
  session.screenshots.push(path);
  return path;
}

async function activateApp(app: string): Promise<void> {
  assertSafeApp(app);
  const safe = escapeAppleScriptString(app.trim());
  // Prefer bundle id form when it looks like one (com.apple.…)
  if (/^[a-z0-9.-]+\.[a-z0-9.-]+$/i.test(app.trim()) && app.includes(".")) {
    await osascript(`tell application id "${safe}" to activate`);
  } else if (/^TextEdit$/i.test(app.trim())) {
    // Ensure a document exists so keystroke has a target
    await osascript(`tell application "TextEdit"
  activate
  if (count of documents) is 0 then make new document
end tell`);
  } else {
    await osascript(`tell application "${safe}" to activate`);
  }
  if (session) session.app = app.trim();
}

async function runStep(step: DesktopStep): Promise<void> {
  if (abortRequested) throw new Error("Session aborted.");
  switch (step.action) {
    case "wait": {
      const ms = Math.max(0, Math.min(step.ms, 30_000));
      await new Promise((r) => setTimeout(r, ms));
      break;
    }
    case "screenshot":
      await takeShot(step.name);
      break;
    case "activate":
      await activateApp(step.app);
      break;
    case "click": {
      const x = Math.round(step.x);
      const y = Math.round(step.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) {
        throw new Error("click x/y out of range.");
      }
      await osascript(`tell application "System Events" to click at {${x}, ${y}}`);
      break;
    }
    case "type": {
      if (typeof step.text !== "string" || step.text.length > 500) {
        throw new Error("type text must be a string ≤ 500 chars.");
      }
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(step.text)) {
        throw new Error("type text contains control characters.");
      }
      const safe = escapeAppleScriptString(step.text);
      await osascript(`tell application "System Events" to keystroke "${safe}"`);
      break;
    }
    case "key": {
      const key = step.key.trim().toLowerCase();
      if (!ALLOWED_KEYS.has(key)) {
        throw new Error(`key "${step.key}" not in allowlist.`);
      }
      const mods = (step.modifiers ?? []).map((m) => m.toLowerCase());
      for (const m of mods) {
        if (!ALLOWED_MODIFIERS.has(m)) throw new Error(`modifier "${m}" not allowed.`);
      }
      const codes: Record<string, number> = {
        return: 36,
        enter: 76,
        tab: 48,
        escape: 53,
        space: 49,
        delete: 51,
        backspace: 51,
        up: 126,
        down: 125,
        left: 123,
        right: 124,
      };
      const code = codes[key];
      if (code == null) throw new Error(`unsupported key ${key}`);
      if (mods.length) {
        const using = mods.map((m) => `${m} down`).join(", ");
        await osascript(`tell application "System Events" to key code ${code} using {${using}}`);
      } else {
        await osascript(`tell application "System Events" to key code ${code}`);
      }
      break;
    }
    default:
      throw new Error(`Unknown or blocked action.`);
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
    return { ok: false, error: "Desktop sessions require macOS.", status: 400 };
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
    backend: "osascript+screencapture",
  };

  runLock = (async () => {
    try {
      if (input.app) await activateApp(input.app);
      await takeShot("01-start");
      for (const step of input.steps ?? []) {
        await runStep(step);
      }
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

export async function runDesktopActions(
  steps: DesktopStep[],
): Promise<{ ok: true; session: DesktopSessionInfo } | { ok: false; error: string; status: 400 | 409 }> {
  if (!session || session.status !== "running") {
    return { ok: false, error: "No running desktop session. Start one first.", status: 409 };
  }
  if (runLock) {
    return { ok: false, error: "Desktop session is busy.", status: 409 };
  }
  runLock = (async () => {
    for (const step of steps) await runStep(step);
    await writeFile(join(session!.outDir, "session.json"), JSON.stringify(getDesktopSession(), null, 2));
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

export async function stopDesktopSession(): Promise<{ ok: true; session: DesktopSessionInfo | null }> {
  abortRequested = true;
  if (session && (session.status === "running" || session.status === "starting")) {
    session.status = "stopping";
  }
  if (runLock) {
    try {
      await runLock;
    } catch {
      /* start already recorded */
    }
  }
  if (session) {
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

/** Parse untrusted JSON steps into DesktopStep[]; skips unknown / blocked shapes. */
export function parseDesktopSteps(raw: unknown): DesktopStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: DesktopStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    switch (s.action) {
      case "wait":
        if (typeof s.ms === "number") steps.push({ action: "wait", ms: s.ms });
        break;
      case "screenshot":
        steps.push({ action: "screenshot", name: typeof s.name === "string" ? s.name : undefined });
        break;
      case "activate":
        if (typeof s.app === "string") steps.push({ action: "activate", app: s.app });
        break;
      case "click":
        if (typeof s.x === "number" && typeof s.y === "number") {
          steps.push({ action: "click", x: s.x, y: s.y });
        }
        break;
      case "type":
        if (typeof s.text === "string") steps.push({ action: "type", text: s.text });
        break;
      case "key":
        if (typeof s.key === "string") {
          steps.push({
            action: "key",
            key: s.key,
            modifiers: Array.isArray(s.modifiers)
              ? s.modifiers.filter((m): m is string => typeof m === "string")
              : undefined,
          });
        }
        break;
      default:
        // shell / open / run — silently refused (not added)
        break;
    }
  }
  return steps;
}
