#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P13_MEM_MARKER_${Date.now()}`;
const SHARED = `P13_SHARED_USER_${Date.now()}`;

const result = {
  pass: false,
  marker: MARKER,
  shared: SHARED,
  writeAgent: null,
  recallAgent: null,
  writeUser: null,
  recallOtherBot: null,
  error: null,
};

try {
  const w = await fetch(`${BASE}/api/studio/bots/custom-researcher-demo/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fact: `Demo preference marker: ${MARKER}`,
      scope: "agent",
      tier: "log",
    }),
  });
  const wBody = await w.json();
  result.writeAgent = { status: w.status, body: wBody };
  if (!w.ok) throw new Error(wBody.error || `write ${w.status}`);

  const r = await fetch(
    `${BASE}/api/studio/bots/custom-researcher-demo/memory?q=${encodeURIComponent(MARKER)}&scope=agent`,
  );
  const rBody = await r.json();
  result.recallAgent = { status: r.status, body: rBody };

  const wu = await fetch(`${BASE}/api/studio/memory/user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fact: `Shared user fact: ${SHARED}`,
      tier: "profile",
    }),
  });
  const wuBody = await wu.json();
  result.writeUser = { status: wu.status, body: wuBody };
  if (!wu.ok) throw new Error(wuBody.error || `user write ${wu.status}`);

  // Another bot should see shared user fact via scope=all
  const ro = await fetch(
    `${BASE}/api/studio/bots/studio-lead/memory?q=${encodeURIComponent(SHARED)}&scope=all`,
  );
  const roBody = await ro.json();
  result.recallOtherBot = { status: ro.status, body: roBody };

  const agentHit = (rBody.memories || []).some((m) => (m.fact || "").includes(MARKER));
  const sharedHit = (roBody.memories || []).some(
    (m) => m.scope === "user" && (m.fact || "").includes(SHARED),
  );

  result.pass =
    w.status === 201 &&
    wu.status === 201 &&
    agentHit &&
    sharedHit;

  await writeFile(`${OUT}/p13-memory-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p13-memory-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
