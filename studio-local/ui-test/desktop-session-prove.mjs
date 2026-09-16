#!/usr/bin/env node
/**
 * P0.3 prove: TextEdit type (app scripting) + screenshot + stop on Abdullahs-MBP.
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
  await fetch(`${BASE}/api/studio/desktop/session/stop`, { method: "POST" });

  const startRes = await fetch(`${BASE}/api/studio/desktop/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app: "TextEdit",
      steps: [
        { action: "type", text: "P03_DESKTOP_PROVE", app: "TextEdit" },
        { action: "wait", ms: 400 },
        { action: "screenshot", name: "02-typed" },
      ],
    }),
  });
  const startBody = await startRes.json();
  result.start = { status: startRes.status, body: startBody };
  if (!startRes.ok) throw new Error(startBody.error || `start ${startRes.status}`);

  const shot =
    startBody.session?.screenshots?.find((p) => String(p).includes("02-typed")) ||
    startBody.session?.screenshots?.[0];
  result.screenshotPath = shot || null;
  result.screenshotExists = shot ? await exists(shot) : false;

  // clean quit via action then stop
  await fetch(`${BASE}/api/studio/desktop/session/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ steps: [{ action: "quit", app: "TextEdit", saving: "no" }] }),
  });

  const stopRes = await fetch(`${BASE}/api/studio/desktop/session/stop`, { method: "POST" });
  const stopBody = await stopRes.json();
  result.stop = { status: stopRes.status, body: stopBody };

  const statusBody = await fetch(`${BASE}/api/studio/desktop/session`).then((r) => r.json());
  result.statusAfterStop = statusBody;

  result.pass =
    startRes.status === 201 &&
    result.screenshotExists &&
    stopRes.ok &&
    statusBody.session?.status === "stopped" &&
    (startBody.session?.outDir || "").includes("ui-test/out/desktop");
} catch (err) {
  result.error = err instanceof Error ? err.message : String(err);
  try {
    await fetch(`${BASE}/api/studio/desktop/session/stop`, { method: "POST" });
    await fetch(`${BASE}/api/studio/desktop/session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps: [{ action: "quit", app: "TextEdit", saving: "no" }] }),
    }).catch(() => null);
  } catch {
    /* ignore */
  }
}

await writeFile(`${OUT}/desktop-session-result.json`, JSON.stringify(result, null, 2));
console.log("---RESULT_JSON---");
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
