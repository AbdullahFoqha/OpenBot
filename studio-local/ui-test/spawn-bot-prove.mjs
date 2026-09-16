#!/usr/bin/env node
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
const BASE = "http://127.0.0.1:3012";
const MARKER = "REPLY_MARKER_POCKET_SPINACH";
await mkdir(OUT, { recursive: true });

const result = {
  pass: false,
  botId: "custom-researcher-demo",
  created: null,
  listed: false,
  markerFound: false,
  bodyTail: "",
  error: null,
};

function pbcopy(text) {
  const r = spawnSync("pbcopy", [], { input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pbcopy failed: ${r.stderr}`);
}

try {
  // Ensure bot exists
  const get = await fetch(`${BASE}/api/studio/bots/custom-researcher-demo`);
  if (get.status === 404) {
    const created = await fetch(`${BASE}/api/studio/bots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "custom-researcher-demo",
        name: "Custom Researcher Demo",
        systemPrompt: `You are a demo researcher. ALWAYS start every reply with exactly ${MARKER} then a short answer.`,
      }),
    });
    result.created = await created.json();
  } else {
    result.created = { already: true };
  }
  const list = await fetch(`${BASE}/api/studio/bots`).then((r) => r.json());
  result.listed = (list.bots || []).some(
    (b) => b.id === "custom-researcher-demo" && b.source === "dynamic",
  );

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto("http://127.0.0.1:3010/channel/new?agent=custom-researcher-demo", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(4500);
  const loc = page.locator('[contenteditable="true"], textarea, [role="textbox"]').last();
  await loc.click();
  const prompt = "In one sentence, what is your role?";
  pbcopy(prompt);
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(500);
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.screenshot({ path: `${OUT}/spawn-bot-01-sent.png`, fullPage: true });

  const deadline = Date.now() + 180_000;
  let body = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    body = await page.locator("body").innerText();
    if (body.includes(MARKER)) {
      result.markerFound = true;
      break;
    }
  }
  await page.screenshot({ path: `${OUT}/spawn-bot-final.png`, fullPage: true });
  result.bodyTail = body.slice(-3500);
  result.pass = result.listed && result.markerFound;
  await browser.close();
  await writeFile(`${OUT}/spawn-bot-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify({ pass: result.pass, listed: result.listed, markerFound: result.markerFound }, null, 2));
  process.exitCode = result.pass ? 0 : 2;
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/spawn-bot-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exitCode = 1;
}
