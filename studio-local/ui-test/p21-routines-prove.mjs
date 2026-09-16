#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P21_ROUTINE_${Date.now()}`;

const result = {
  pass: false,
  marker: MARKER,
  create: null,
  list: null,
  pause: null,
  resume: null,
  del: null,
  error: null,
};

try {
  const createRes = await fetch(`${BASE}/api/studio/routines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instruction: `P2.1 prove ${MARKER}: when this fires, reply once with the marker then stop. Do not call studio_run_task.`,
      cron: "0 9 * * 0",
      timezone: "America/New_York",
      agentId: "studio-lead",
    }),
  });
  const createBody = await createRes.json().catch(() => ({}));
  result.create = { status: createRes.status, body: createBody };
  if (!createRes.ok) throw new Error(createBody.error || `create ${createRes.status}`);

  const routineId = createBody.routine?.id;
  if (!routineId) throw new Error("no routine id");

  const listRes = await fetch(`${BASE}/api/studio/routines`);
  const listBody = await listRes.json();
  result.list = { status: listRes.status, count: listBody.count, has: (listBody.routines || []).some((r) => r.id === routineId) };

  const pauseRes = await fetch(`${BASE}/api/studio/routines/${routineId}/pause`, { method: "POST" });
  const pauseBody = await pauseRes.json().catch(() => ({}));
  result.pause = { status: pauseRes.status, body: pauseBody };

  const resumeRes = await fetch(`${BASE}/api/studio/routines/${routineId}/resume`, { method: "POST" });
  const resumeBody = await resumeRes.json().catch(() => ({}));
  result.resume = { status: resumeRes.status, body: resumeBody };

  const delRes = await fetch(`${BASE}/api/studio/routines/${routineId}`, { method: "DELETE" });
  result.del = { status: delRes.status };

  const listAfter = await fetch(`${BASE}/api/studio/routines`);
  const listAfterBody = await listAfter.json();
  const stillThere = (listAfterBody.routines || []).some((r) => r.id === routineId);

  result.pass =
    createRes.status === 201 &&
    Boolean(routineId) &&
    listRes.ok &&
    result.list.has === true &&
    pauseRes.ok &&
    pauseBody.enabled === false &&
    resumeRes.ok &&
    resumeBody.enabled === true &&
    delRes.status === 204 &&
    stillThere === false;

  await writeFile(`${OUT}/p21-routines-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify({ pass: result.pass, routineId, create: result.create?.status, pause: result.pause?.status, resume: result.resume?.status, del: result.del?.status }, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p21-routines-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
