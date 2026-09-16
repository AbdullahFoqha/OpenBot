#!/usr/bin/env node
/**
 * P1.1 prove: Lead/API messages custom-researcher-demo with a marker; inbox shows it.
 */
import { writeFile, mkdir } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P11_MSG_MARKER_${Date.now()}`;

const result = {
  pass: false,
  marker: MARKER,
  prioritySend: null,
  fyiSend: null,
  inbox: null,
  error: null,
};

try {
  const pri = await fetch(`${BASE}/api/studio/bots/custom-researcher-demo/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Ping from studio bus prove. Reply not required. Marker: ${MARKER}`,
      priority: true,
      fromBotId: "studio-lead",
    }),
  });
  const priBody = await pri.json();
  result.prioritySend = { status: pri.status, body: priBody };

  const fyi = await fetch(`${BASE}/api/studio/bots/custom-researcher-demo/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `FYI only ${MARKER}`,
      priority: false,
      fromBotId: "studio-lead",
    }),
  });
  const fyiBody = await fyi.json();
  result.fyiSend = { status: fyi.status, body: fyiBody };

  // Wait briefly for priority handoff delivery
  await new Promise((r) => setTimeout(r, 3000));

  const inboxRes = await fetch(`${BASE}/api/studio/bots/custom-researcher-demo/messages`);
  const inboxBody = await inboxRes.json();
  result.inbox = inboxBody;

  const messages = inboxBody.messages || [];
  const hasMarker = messages.some((m) => (m.body || "").includes(MARKER));
  const hasPriority = messages.some((m) => m.priority === true && (m.body || "").includes(MARKER));
  const hasFyi = messages.some((m) => m.priority === false && (m.body || "").includes(MARKER));

  result.pass =
    pri.status === 201 &&
    fyi.status === 201 &&
    priBody.woke === true &&
    fyiBody.woke === false &&
    hasMarker &&
    hasPriority &&
    hasFyi;

  await writeFile(`${OUT}/p11-message-bot-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p11-message-bot-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
