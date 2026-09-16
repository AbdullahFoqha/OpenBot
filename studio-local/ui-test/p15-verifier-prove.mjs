#!/usr/bin/env node
/**
 * P1.5 prove: ensure studio-verifier exists; submit evidence-only verify claim; wait for terminal.
 */
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P15_VERIFY_${Date.now()}`;

const result = {
  pass: false,
  marker: MARKER,
  ensure: null,
  verify: null,
  final: null,
  error: null,
};

try {
  const ensureRes = await fetch(`${BASE}/api/studio/verifier/ensure`, { method: "POST" });
  const ensureBody = await ensureRes.json();
  result.ensure = { status: ensureRes.status, body: ensureBody };
  if (!ensureRes.ok) throw new Error(ensureBody.error || `ensure ${ensureRes.status}`);

  const claim = `Verify only (no feature work): confirm the selected product has a package.json with a "name" field. Marker ${MARKER}. Run the lightest check that proves this (e.g. node -e reading package.json). Do not create new product features or open a feature PR.`;
  const verifyRes = await fetch(`${BASE}/api/studio/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `P15 verify package.json ${MARKER.slice(-6)}`,
      claim,
      idempotencyKey: `p15-${MARKER}`,
    }),
  });
  const verifyBody = await verifyRes.json();
  result.verify = { status: verifyRes.status, body: verifyBody };
  if (!verifyRes.ok) throw new Error(verifyBody.error || `verify ${verifyRes.status}`);

  const taskId = verifyBody.taskId;
  const deadline = Date.now() + 480_000;
  let task = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const tr = await fetch(`${BASE}/api/studio/tasks/${taskId}`);
    const tb = await tr.json();
    task = tb;
    const state = tb.task?.state || tb.state;
    if (["in_review", "blocked", "done", "failed", "interrupted"].includes(state)) break;
    if (tb.evidence && (tb.evidence.ok === true || tb.evidence.ok === false) && !tb.running) break;
  }
  result.final = task;

  const state = task?.task?.state || task?.state;
  const owner = task?.task?.ownerBotId || task?.ownerBotId;
  const evidence = task?.evidence;
  result.pass =
    verifyRes.status === 201 &&
    verifyBody.ownerBotId === "studio-verifier" &&
    owner === "studio-verifier" &&
    ensureBody.botId === "studio-verifier" &&
    Boolean(taskId) &&
    (state === "in_review" || evidence?.ok === true || state === "blocked");

  await writeFile(`${OUT}/p15-verifier-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify({
    pass: result.pass,
    taskId,
    state,
    owner,
    evidenceOk: evidence?.ok ?? null,
    ensureCreated: ensureBody.created,
  }, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p15-verifier-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
