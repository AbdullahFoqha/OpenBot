#!/usr/bin/env node
/**
 * P0.4 prove: start browser session → example.com → screenshot → stop cleanly.
 */
import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
const result = {
  pass: false,
  start: null,
  stop: null,
  screenshotExists: false,
  screenshotPath: null,
  profileDir: null,
  error: null,
};

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

try {
  // ensure clean
  await fetch(`${BASE}/api/studio/browser/session/stop`, { method: "POST" });

  const startRes = await fetch(`${BASE}/api/studio/browser/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com",
      headless: true,
      steps: [{ action: "wait", ms: 500 }, { action: "screenshot", name: "02-example" }],
    }),
  });
  const startBody = await startRes.json();
  result.start = { status: startRes.status, body: startBody };
  if (!startRes.ok) throw new Error(startBody.error || `start ${startRes.status}`);

  const shot =
    startBody.session?.screenshots?.find((p) => p.includes("01-after-nav")) ||
    startBody.session?.screenshots?.[0];
  result.screenshotPath = shot || null;
  result.profileDir = startBody.session?.profileDir || null;
  result.screenshotExists = shot ? await exists(shot) : false;

  const stopRes = await fetch(`${BASE}/api/studio/browser/session/stop`, { method: "POST" });
  const stopBody = await stopRes.json();
  result.stop = { status: stopRes.status, body: stopBody };

  const statusRes = await fetch(`${BASE}/api/studio/browser/session`);
  const statusBody = await statusRes.json();
  result.statusAfterStop = statusBody;

  result.pass =
    startRes.status === 201 &&
    result.screenshotExists &&
    (result.profileDir || "").includes("studio-local/browser-profile") &&
    stopRes.ok &&
    statusBody.session?.status === "stopped";
} catch (err) {
  result.error = err instanceof Error ? err.message : String(err);
  try {
    await fetch(`${BASE}/api/studio/browser/session/stop`, { method: "POST" });
  } catch {
    /* ignore */
  }
}

await writeFile(`${OUT}/browser-session-result.json`, JSON.stringify(result, null, 2));
console.log("---RESULT_JSON---");
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
