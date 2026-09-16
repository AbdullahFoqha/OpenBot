/**
 * P0.4 — unattended Chromium session with a persistent profile under studio-local
 * and evidence screenshots under studio-local/ui-test/out/browser/<stamp>/.
 *
 * One session at a time (in-process). Prefer Playwright launchPersistentContext so
 * cookies/logins survive stop/start the way a desktop browser does.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright";

export type BrowserStep =
  | { action: "wait"; ms: number }
  | { action: "screenshot"; name?: string }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string };

export type BrowserSessionInfo = {
  id: string;
  status: "starting" | "running" | "stopping" | "stopped" | "error";
  url: string | null;
  stamp: string;
  outDir: string;
  profileDir: string;
  screenshots: string[];
  startedAt: string;
  stoppedAt?: string;
  error?: string;
};

function repoRoot(): string {
  return process.env.STUDIO_REPO_ROOT?.trim() || process.cwd();
}

export function browserProfileDir(): string {
  return join(repoRoot(), "studio-local", "browser-profile");
}

export function browserEvidenceRoot(): string {
  return join(repoRoot(), "studio-local", "ui-test", "out", "browser");
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

let context: BrowserContext | null = null;
let page: Page | null = null;
let session: BrowserSessionInfo | null = null;
let abortRequested = false;
let runLock: Promise<void> | null = null;

export function getBrowserSession(): BrowserSessionInfo | null {
  return session ? { ...session, screenshots: [...session.screenshots] } : null;
}

async function closeBrowserQuietly(): Promise<void> {
  const ctx = context;
  context = null;
  page = null;
  if (!ctx) return;
  try {
    await ctx.close();
  } catch {
    // ignore — stop must be idempotent
  }
}

async function takeShot(name: string): Promise<string> {
  if (!page || !session) throw new Error("No active browser page.");
  const file = name.endsWith(".png") ? name : `${name}.png`;
  const path = join(session.outDir, file);
  await page.screenshot({ path, fullPage: true });
  session.screenshots.push(path);
  return path;
}

async function runSteps(steps: BrowserStep[]): Promise<void> {
  if (!page || !session) return;
  let shotIndex = 2;
  for (const step of steps) {
    if (abortRequested) throw new Error("Session aborted.");
    switch (step.action) {
      case "wait":
        await page.waitForTimeout(Math.max(0, Math.min(step.ms, 60_000)));
        break;
      case "screenshot":
        await takeShot(step.name ?? `${String(shotIndex++).padStart(2, "0")}-step`);
        break;
      case "click":
        await page.click(step.selector, { timeout: 15_000 });
        break;
      case "type":
        await page.fill(step.selector, step.text, { timeout: 15_000 });
        break;
      default:
        break;
    }
  }
}

export async function startBrowserSession(input: {
  url: string;
  steps?: BrowserStep[];
  headless?: boolean;
}): Promise<{ ok: true; session: BrowserSessionInfo } | { ok: false; error: string; status: 409 | 400 }> {
  const url = input.url?.trim();
  if (!url) return { ok: false, error: "url is required.", status: 400 };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "url must start with http:// or https://.", status: 400 };
  }
  if (session && (session.status === "running" || session.status === "starting")) {
    return { ok: false, error: "A browser session is already running. Stop it first.", status: 409 };
  }
  if (runLock) {
    return { ok: false, error: "A browser session start/stop is already in progress.", status: 409 };
  }

  abortRequested = false;
  const stamp = stampNow();
  const outDir = join(browserEvidenceRoot(), stamp);
  const profileDir = browserProfileDir();
  await mkdir(outDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  session = {
    id: `browser-${randomUUID().slice(0, 8)}`,
    status: "starting",
    url,
    stamp,
    outDir,
    profileDir,
    screenshots: [],
    startedAt: new Date().toISOString(),
  };

  const headless = input.headless !== false; // default headless for unattended

  runLock = (async () => {
    try {
      // Prefer system Chrome (same as studio-local/ui-test proves). Override with
      // STUDIO_BROWSER_CHANNEL=chromium to use Playwright's bundled browser.
      const channel =
        process.env.STUDIO_BROWSER_CHANNEL?.trim() ||
        (process.platform === "darwin" || process.platform === "win32" ? "chrome" : undefined);
      context = await chromium.launchPersistentContext(profileDir, {
        headless,
        ...(channel && channel !== "chromium" ? { channel } : {}),
        viewport: { width: 1280, height: 800 },
        args: ["--disable-dev-shm-usage"],
      });
      page = context.pages()[0] ?? (await context.newPage());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await takeShot("01-after-nav");
      const extra = input.steps ?? [];
      if (extra.length) await runSteps(extra);
      if (abortRequested) throw new Error("Session aborted.");
      session!.status = "running";
      await writeFile(join(outDir, "session.json"), JSON.stringify(getBrowserSession(), null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (session) {
        session.status = "error";
        session.error = message;
        session.stoppedAt = new Date().toISOString();
      }
      await closeBrowserQuietly();
      throw err;
    }
  })();

  try {
    await runLock;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runLock = null;
    return { ok: false, error: message, status: 400 };
  } finally {
    runLock = null;
  }

  return { ok: true, session: getBrowserSession()! };
}

export async function stopBrowserSession(): Promise<{
  ok: true;
  session: BrowserSessionInfo | null;
}> {
  abortRequested = true;
  if (session && (session.status === "running" || session.status === "starting")) {
    session.status = "stopping";
  }
  if (runLock) {
    try {
      await runLock;
    } catch {
      // start already recorded error
    }
  }
  await closeBrowserQuietly();
  if (session) {
    if (session.status !== "error") session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    try {
      await writeFile(join(session.outDir, "session.json"), JSON.stringify(getBrowserSession(), null, 2));
    } catch {
      // outDir may be missing if start never got that far
    }
  }
  const snapshot = getBrowserSession();
  // Keep last session info for status until next start overwrites
  return { ok: true, session: snapshot };
}
