#!/usr/bin/env node
/**
 * P0.5 prove: clear AC → Lead calls studio_run_task same turn (taskId), no clarify menus.
 * Uses pbcopy + Meta+V (keyboard.type truncates long prompts).
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });

const FLAG = "src/p05-unattended-flag.ts";
const prompt = `Create ${FLAG} in the selected product exporting const P05_UNATTENDED = true with a one-line comment. Acceptance criteria: that file only. Call studio_run_task now (react-native-engineer). Reply with taskId first. No clarify menus, no dashboard Run Task, no host_* product writes. When terminal, hand back Shipped / Evidence / Untested / Next.`;

function pbcopy(text) {
  const r = spawnSync("pbcopy", [], { input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pbcopy failed: ${r.stderr}`);
}

const result = {
  pass: false,
  taskId: null,
  clarified: false,
  usedHost: false,
  askedRunTask: false,
  handback: false,
  bodyTail: "",
  error: null,
};

const browser = await chromium.launch({ headless: false, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

try {
  await page.goto("http://127.0.0.1:3010/channel/new?agent=studio-lead", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(4000);
  const loc = page.locator('[contenteditable="true"], textarea, [role="textbox"]').last();
  await loc.click();
  pbcopy(prompt);
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(500);
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.screenshot({ path: `${OUT}/p05-01-sent.png`, fullPage: true });

  const deadline = Date.now() + 480_000;
  let body = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    body = await page.locator("body").innerText();
    // Scope checks to text after Lead's studio_run_task (avoid matching our own prompt
    // which says "no dashboard Run Task", and avoid older channel history).
    const scopeIdx = Math.max(body.lastIndexOf("▸\nstudio_run_task"), body.lastIndexOf("studio_run_task"));
    const scope = scopeIdx >= 0 ? body.slice(scopeIdx) : body.slice(-2500);
    result.clarified = /what would you like me to demonstrate|A few possibilities:|Could you clarify|Which of the following/i.test(
      scope,
    );
    result.usedHost = /host_list_folders|Don't have access to \/Users|host_write_file/i.test(scope);
    result.askedRunTask =
      /(?:please |kindly )?(?:go )?(?:to the )?(?:Studio )?dashboard.{0,40}Run Task|click (?:the )?["']?Run Task["']? button/i.test(
        scope,
      );
    const m = scope.match(/task-[0-9a-f-]{10,}/i) || body.match(/task-[0-9a-f-]{10,}/i);
    if (m) result.taskId = m[0];
    result.handback =
      /\*\*Shipped:\*\*|Shipped:/.test(scope) &&
      /Evidence:/.test(scope) &&
      (/Untested/i.test(scope) || /blocked/i.test(scope)) &&
      /Next:/i.test(scope);
    if (result.taskId && !result.clarified && !result.askedRunTask) {
      if (result.handback || Date.now() > deadline - 60_000) break;
    }
    if ((result.clarified || result.askedRunTask) && !result.taskId && Date.now() > Date.now()) {
      // keep waiting briefly for recovery
    }
  }

  await page.screenshot({ path: `${OUT}/p05-02-final.png`, fullPage: true });
  result.bodyTail = body.slice(-5000);
  // Core AC: taskId same session, no clarify / Run Task redirect
  result.pass =
    Boolean(result.taskId) && !result.clarified && !result.usedHost && !result.askedRunTask;
  await writeFile(`${OUT}/p05-unattended-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.pass ? 0 : 2;
} catch (e) {
  result.error = String(e);
  console.error("FAIL", e);
  await writeFile(`${OUT}/p05-unattended-result.json`, JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
