#!/usr/bin/env node
/**
 * Lead-tool path: Studio Lead chat → studio_run_task(ownerBotId=quality-engineer, maestroFlow).
 * Clipboard paste (pbcopy), then poll /api/studio/tasks/:id until Maestro exit 0.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
const BASE = "http://127.0.0.1:3012";
const UDID = "812A595B-0FDA-4C3F-9346-088E6C07A489";
await mkdir(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);

const prompt = `Native QA now — do not clarify.

Call studio_run_task RIGHT NOW with:
- ownerBotId=quality-engineer
- maestroFlow=".maestro/onboard.yaml"
- deviceUdid=${UDID}

Acceptance criteria (exact):
maestro: .maestro/onboard.yaml
device: ${UDID}
- Re-run typecheck + tests; report raw results
- Maestro exit 0 required (Release defaults / clearState)

Reply with the QA taskId first. When terminal, hand back Shipped / Evidence / Untested / Next including Maestro evidence path and exit code. No host_* product writes. No clarify menus.`;

function pbcopy(text) {
  const r = spawnSync("pbcopy", [], { input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pbcopy failed: ${r.stderr}`);
}

const knownTaskIds = new Set();
try {
  const list = await fetch(`${BASE}/api/studio/tasks`).then((r) => r.json());
  for (const t of list.tasks ?? []) {
    if (t.id) knownTaskIds.add(String(t.id).toLowerCase());
  }
} catch {
  /* ignore */
}

const browser = await chromium.launch({ headless: false, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const result = {
  pass: false,
  taskId: null,
  clarified: false,
  cutOff: false,
  usedHost: false,
  handback: false,
  state: null,
  maestro: null,
  checkAfter: null,
  evidenceOk: null,
  blocker: null,
  bodyTail: "",
  error: null,
};

try {
  const health = await fetch(`${BASE}/health`);
  if (!health.ok) throw new Error("studio :3012 health failed");

  await page.goto("http://127.0.0.1:3010/channel/new?agent=studio-lead", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(4000);
  const loc = page.locator('[contenteditable="true"], textarea, [role="textbox"]').last();
  await loc.click();
  pbcopy(prompt);
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(700);
  const composer = await loc.innerText().catch(() => "");
  log("paste_ok", /maestroFlow|quality-engineer/i.test(composer), composer.length);
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.screenshot({ path: `${OUT}/lead-qe-maestro-01-sent.png`, fullPage: true });

  // Phase 1: wait for taskId in chat (or API)
  const chatDeadline = Date.now() + 180_000;
  let body = "";
  while (Date.now() < chatDeadline && !result.taskId) {
    await page.waitForTimeout(5000);
    body = await page.locator("body").innerText();
    result.clarified = /Could you clarify|I need clarification|A few possibilities|what would you like me to demonstrate/i.test(
      body,
    );
    result.cutOff = /cut off after/i.test(body);
    result.usedHost = /host_list_folders|host_write_file/i.test(body);
    const ids = [...body.slice(-8000).matchAll(/task-[0-9a-f-]{10,}/gi)]
      .map((m) => m[0].toLowerCase())
      .filter((id) => !knownTaskIds.has(id));
    if (ids[0]) {
      result.taskId = ids[0];
      log("taskId_from_chat", result.taskId);
      break;
    }
    // Also watch API for a new QE task
    try {
      const list = await fetch(`${BASE}/api/studio/tasks`).then((r) => r.json());
      for (const t of list.tasks ?? []) {
        const id = String(t.id || "").toLowerCase();
        if (
          id &&
          !knownTaskIds.has(id) &&
          t.ownerBotId === "quality-engineer" &&
          /maestro|onboard/i.test(`${t.title} ${t.goal} ${t.acceptanceCriteria}`)
        ) {
          result.taskId = id;
          log("taskId_from_api", result.taskId, t.title);
          break;
        }
      }
    } catch {
      /* ignore */
    }
    if (result.clarified && Date.now() > chatDeadline - 60_000) break;
  }

  if (!result.taskId) {
    await page.screenshot({ path: `${OUT}/lead-qe-maestro-fail-no-task.png`, fullPage: true });
    result.bodyTail = body.slice(-4500);
    throw new Error("Lead did not create a QE Maestro taskId");
  }

  // Phase 2: poll task until terminal + Maestro
  const pollDeadline = Date.now() + 25 * 60_000;
  while (Date.now() < pollDeadline) {
    await page.waitForTimeout(5000);
    body = await page.locator("body").innerText();
    result.handback =
      /Shipped:/i.test(body) && /Evidence:/i.test(body);
    const res = await fetch(`${BASE}/api/studio/tasks/${result.taskId}`);
    const json = await res.json();
    const task = json.task ?? json;
    const evidence = json.evidence ?? {};
    result.state = task.state;
    result.maestro = evidence.maestro ?? null;
    result.checkAfter = evidence.checkAfter ?? null;
    result.evidenceOk = evidence.ok ?? null;
    result.blocker = evidence.blocker ?? task.blockedReason ?? null;
    log(
      "poll",
      result.state,
      result.evidenceOk,
      result.maestro?.exitCode,
      result.handback ? "handback" : "",
    );
    if (["done", "in_review", "blocked", "interrupted", "failed"].includes(result.state)) {
      break;
    }
  }

  await page.screenshot({ path: `${OUT}/lead-qe-maestro-final.png`, fullPage: true });
  result.bodyTail = body.slice(-4500);

  const npmOk = Array.isArray(result.checkAfter)
    ? result.checkAfter.every((c) => c.exitCode === 0)
    : false;
  const maestroOk = Boolean(result.maestro && result.maestro.exitCode === 0);
  // Clarified only fails the Lead-tool prove if Lead never created a task.
  // Chat history / role text can false-positive the clarify regex after success.
  result.pass =
    Boolean(result.taskId) &&
    !result.usedHost &&
    result.evidenceOk === true &&
    npmOk &&
    maestroOk &&
    !(result.clarified && !result.taskId);

  console.log("---RESULT_JSON---");
  console.log(
    JSON.stringify(
      {
        pass: result.pass,
        taskId: result.taskId,
        state: result.state,
        evidenceOk: result.evidenceOk,
        maestroExit: result.maestro?.exitCode ?? null,
        maestroOut: result.maestro?.outputDir ?? null,
        handback: result.handback,
        clarified: result.clarified,
        blocker: result.blocker,
      },
      null,
      2,
    ),
  );
  await writeFile(`${OUT}/lead-qe-maestro-result.json`, JSON.stringify(result, null, 2));
  process.exitCode = result.pass ? 0 : 2;
} catch (e) {
  result.error = String(e);
  console.error("FAIL", e);
  await writeFile(`${OUT}/lead-qe-maestro-result.json`, JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
