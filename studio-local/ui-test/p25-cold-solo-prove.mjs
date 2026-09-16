#!/usr/bin/env node
/**
 * P2.5 cold solo ≤15m — stopwatch from clear-AC submit → terminal evidence on selected product.
 * Same dispatcher path as Lead `studio_run_task` (unattended coding).
 */
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P25_COLD_${Date.now()}`;
const FLAG = "src/ultra-demo-flag.ts";
const LIMIT_MS = 15 * 60 * 1000;

const result = {
  pass: false,
  marker: MARKER,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  durationSec: null,
  within15m: false,
  setup: null,
  submit: null,
  final: null,
  error: null,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  const setupRes = await fetch(`${BASE}/api/studio/setup`);
  const setup = await setupRes.json();
  result.setup = {
    status: setupRes.status,
    project: setup.project,
    cursorLogin: setup.cursorLogin,
    queuePaused: setup.queuePaused,
  };
  if (!setupRes.ok || setup.project?.status !== "online" || setup.cursorLogin !== "online") {
    throw new Error(`setup not ready: ${JSON.stringify(result.setup)}`);
  }
  if (setup.queuePaused) throw new Error("queue is paused");

  const t0 = Date.now();
  result.startedAt = new Date(t0).toISOString();

  const goal = `Create ${FLAG} in the selected product exporting const ULTRA_DEMO = true with a one-line comment mentioning ${MARKER}. Acceptance: that file only (create or overwrite). Do not expand scope.`;
  const submitRes = await fetch(`${BASE}/api/studio/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `P25 cold solo ${MARKER.slice(-6)}`,
      goal,
      acceptanceCriteria: `${FLAG} exports ULTRA_DEMO=true with comment containing ${MARKER}`,
      ownerBotId: "react-native-engineer",
      background: false,
      idempotencyKey: `p25-${MARKER}`,
    }),
  });
  const submitBody = await submitRes.json();
  result.submit = { status: submitRes.status, body: submitBody, elapsedMs: Date.now() - t0 };
  if (!submitRes.ok || !submitBody.taskId) {
    throw new Error(submitBody.error || `submit ${submitRes.status}`);
  }
  const taskId = submitBody.taskId;

  let task = null;
  while (Date.now() - t0 < LIMIT_MS) {
    await sleep(5000);
    const tr = await fetch(`${BASE}/api/studio/tasks/${taskId}`);
    const tb = await tr.json();
    task = tb;
    const state = tb.task?.state || tb.state;
    const running = tb.running === true;
    const evidence = tb.evidence;
    if (["in_review", "blocked", "done", "failed", "interrupted"].includes(state)) break;
    if (evidence && (evidence.ok === true || evidence.ok === false) && !running) break;
  }

  const t1 = Date.now();
  result.finishedAt = new Date(t1).toISOString();
  result.durationMs = t1 - t0;
  result.durationSec = Math.round(result.durationMs / 1000);
  result.within15m = result.durationMs <= LIMIT_MS;
  result.final = task;

  const state = task?.task?.state || task?.state;
  const evidence = task?.evidence;
  const owner = task?.task?.ownerBotId || task?.ownerBotId;
  const changed = evidence?.changedFiles || {};
  const flagTouched =
    typeof changed === "object" &&
    (FLAG in changed ||
      Object.keys(changed).some((k) => k.endsWith("ultra-demo-flag.ts") || k.includes("ultra-demo-flag")));

  result.pass =
    Boolean(taskId) &&
    result.within15m &&
    owner === "react-native-engineer" &&
    (state === "in_review" || evidence?.ok === true) &&
    (evidence?.ok === true || flagTouched || state === "in_review") &&
    Boolean(evidence?.worktreePath || evidence?.backend);

  await writeFile(`${OUT}/p25-cold-solo-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(
    JSON.stringify(
      {
        pass: result.pass,
        taskId,
        state,
        owner,
        durationSec: result.durationSec,
        within15m: result.within15m,
        evidenceOk: evidence?.ok ?? null,
        reportedModel: evidence?.reportedModel ?? null,
        worktreePath: evidence?.worktreePath ?? null,
        flagTouched,
        changedFiles: changed,
      },
      null,
      2,
    ),
  );
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  result.finishedAt = new Date().toISOString();
  if (result.startedAt) {
    result.durationMs = Date.now() - Date.parse(result.startedAt);
    result.durationSec = Math.round(result.durationMs / 1000);
  }
  await writeFile(`${OUT}/p25-cold-solo-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
