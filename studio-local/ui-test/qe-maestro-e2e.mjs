#!/usr/bin/env node
/**
 * Live E2E: POST studio_run_task path via /api/studio/tasks with QE + maestroFlow.
 * Polls until terminal; writes result JSON under studio-local/ui-test/out/.
 */
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
const UDID = "812A595B-0FDA-4C3F-9346-088E6C07A489";
await mkdir(OUT, { recursive: true });

const body = {
  title: "QE Maestro onboard smoke (live E2E)",
  goal: "Independently verify pocket-love onboarding Maestro flow on preferred sim with Release defaults.",
  acceptanceCriteria: [
    "Re-run typecheck + tests on selected pocket-love project; report raw results.",
    "maestro: .maestro/onboard.yaml",
    `device: ${UDID}`,
    "Maestro exit 0 required (Release install / clearState).",
  ].join("\n"),
  ownerBotId: "quality-engineer",
  maestroFlow: ".maestro/onboard.yaml",
  deviceUdid: UDID,
  idempotencyKey: `qe-maestro-e2e-${Date.now()}`,
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

const health = await fetch(`${BASE}/health`);
if (!health.ok) throw new Error("health failed");

const created = await fetch(`${BASE}/api/studio/tasks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const createdJson = await created.json();
if (!created.ok) {
  await writeFile(`${OUT}/qe-maestro-e2e-result.json`, JSON.stringify({ error: createdJson }, null, 2));
  console.error(createdJson);
  process.exit(1);
}
const taskId = createdJson.taskId;
log("taskId", taskId);

const deadline = Date.now() + 25 * 60_000;
let last = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const res = await fetch(`${BASE}/api/studio/tasks/${taskId}`);
  last = await res.json();
  const state = last.state ?? last.task?.state;
  log("poll", state, last.evidence?.ok, last.evidence?.maestro?.exitCode ?? last.maestro?.exitCode);
  if (["done", "in_review", "blocked", "interrupted", "failed"].includes(state)) break;
}

const evidence = last?.evidence ?? last?.task?.evidence ?? {};
const maestro = evidence.maestro ?? last?.maestro ?? null;
const result = {
  pass: Boolean(maestro && maestro.exitCode === 0 && evidence.ok !== false),
  taskId,
  state: last?.state ?? last?.task?.state,
  checkAfter: evidence.checkAfter ?? null,
  maestro,
  blocker: evidence.blocker ?? last?.blocker ?? null,
  worktreePath: evidence.worktreePath ?? null,
};

 // Also sniff latest maestro stamp under studio-local
const maestroRoot = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out/maestro";
try {
  const stamps = (await readdir(maestroRoot)).filter((d) => d.startsWith("20")).sort().reverse();
  result.latestMaestroStamp = stamps[0] ?? null;
  if (stamps[0]) {
    const meta = await readFile(join(maestroRoot, stamps[0], "meta.txt"), "utf8").catch(() => "");
    result.latestMaestroMeta = meta.slice(0, 500);
  }
} catch {
  result.latestMaestroStamp = null;
}

await writeFile(`${OUT}/qe-maestro-e2e-result.json`, JSON.stringify(result, null, 2));
console.log("---RESULT_JSON---");
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 2);
