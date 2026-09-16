#!/usr/bin/env node
/**
 * P0.3 prove: start desktop session → Calculator keystroke → screenshot → stop.
 */
import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
const result = {
  pass: false,
  start: null,
  action: null,
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
      app: "Calculator",
      steps: [
        { action: "keystroke", text: "2" },
        { action: "wait", ms: 300 },
        { action: "screenshot", name: "02-after-key" },
      ],
    }),
  });
  const startBody = await startRes.json();
  result.start = { status: startRes.status, body: startBody };
  if (!startRes.ok) throw new Error(startBody.error || `start ${startRes.status}`);

  const shots = startBody.session?.screenshots || [];
  const shot = shots.find((p) => p.includes("02-after-key")) || shots.find((p) => p.includes("01-after-start"));
  result.screenshotPath = shot || null;
  result.screenshotExists = shot ? await exists(shot) : false;

  const stopRes = await fetch(`${BASE}/api/studio/desktop/session/stop`, { method: "POST" });
  const stopBody = await stopRes.json();
  result.stop = { status: stopRes.status, body: stopBody };

  // polite: quit Calculator via a fresh short start? skip — leave app as user may want it
  const statusRes = await fetch(`${BASE}/api/studio/desktop/session`);
  result.statusAfterStop = await statusRes.json();

  result.pass =
    startRes.status === 201 &&
    result.screenshotExists &&
    (startBody.session?.outDir || "").includes("studio-local/ui-test/out/desktop") &&
    stopRes.ok &&
    result.statusAfterStop?.session?.status === "stopped";
} catch (err) {
  result.error = err instanceof Error ? err.message : String(err);
  try {
    await fetch(`${BASE}/api/studio/desktop/session/stop`, { method: "POST" });
  } catch {
    /* ignore */
  }
}

await writeFile(`${OUT}/desktop-session-result.json`, JSON.stringify(result, null, 2));
console.log("---RESULT_JSON---");
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
