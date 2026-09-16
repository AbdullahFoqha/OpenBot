#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P22_BG_${Date.now()}`;

const result = { pass: false, marker: MARKER, steps: {}, error: null };

async function stop(taskId) {
  if (!taskId) return;
  await fetch(`${BASE}/api/studio/tasks/${taskId}/stop`, { method: "POST" }).catch(() => {});
}

try {
  const mk = (title, body) =>
    fetch(`${BASE}/api/studio/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // Two parallel background verifies on same bot (studio-verifier defaults background)
  const a = await mk(`P22 bg A ${MARKER}`, {
    title: `P22 bg A ${MARKER.slice(-6)}`,
    goal: `Background prove A ${MARKER}: print package.json name then stop. No feature work.`,
    acceptanceCriteria: "package.json name printed",
    ownerBotId: "studio-verifier",
    background: true,
    skipVerify: true,
    idempotencyKey: `p22-a-${MARKER}`,
  });
  const b = await mk(`P22 bg B ${MARKER}`, {
    title: `P22 bg B ${MARKER.slice(-6)}`,
    goal: `Background prove B ${MARKER}: print package.json name then stop. No feature work.`,
    acceptanceCriteria: "package.json name printed",
    ownerBotId: "studio-verifier",
    background: true,
    skipVerify: true,
    idempotencyKey: `p22-b-${MARKER}`,
  });
  result.steps.parallelBg = { a, b };

  // Primary collision: two execution on engineer without background
  const p1 = await mk(`P22 primary 1 ${MARKER}`, {
    title: `P22 primary 1 ${MARKER.slice(-6)}`,
    goal: `Primary prove 1 ${MARKER}: noop sleep briefly. No product feature.`,
    ownerBotId: "react-native-engineer",
    background: false,
    skipVerify: true,
    idempotencyKey: `p22-p1-${MARKER}`,
  });
  const p2 = await mk(`P22 primary 2 ${MARKER}`, {
    title: `P22 primary 2 ${MARKER.slice(-6)}`,
    goal: `Primary prove 2 ${MARKER}: should be refused while p1 holds primary.`,
    ownerBotId: "react-native-engineer",
    background: false,
    skipVerify: true,
    idempotencyKey: `p22-p2-${MARKER}`,
  });
  result.steps.primaryCollision = { p1, p2 };

  await stop(a.body?.taskId);
  await stop(b.body?.taskId);
  await stop(p1.body?.taskId);
  await stop(p2.body?.taskId);

  const bothBgOk =
    (a.status === 200 || a.status === 201) &&
    (b.status === 200 || b.status === 201) &&
    a.body?.background === true &&
    b.body?.background === true &&
    a.body?.kind === "review" &&
    b.body?.kind === "review" &&
    a.body?.taskId &&
    b.body?.taskId &&
    a.body.taskId !== b.body.taskId;

  const collisionOk =
    (p1.status === 200 || p1.status === 201) &&
    p1.body?.taskId &&
    p2.status === 409;

  result.pass = bothBgOk && collisionOk;
  await writeFile(`${OUT}/p22-background-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify({
    pass: result.pass,
    bothBgOk,
    collisionOk,
    a: a.status,
    b: b.status,
    p1: p1.status,
    p2: p2.status,
    aKind: a.body?.kind,
    p2err: p2.body?.error,
  }, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p22-background-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
