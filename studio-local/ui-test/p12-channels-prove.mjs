#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P12_CH_MARKER_${Date.now()}`;

const result = {
  pass: false,
  marker: MARKER,
  create: null,
  post: null,
  get: null,
  error: null,
};

try {
  const createRes = await fetch(`${BASE}/api/studio/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `P12 Room ${MARKER.slice(-6)}`,
      memberBotIds: ["studio-lead", "custom-researcher-demo"],
      createdByBotId: "studio-lead",
    }),
  });
  const createBody = await createRes.json();
  result.create = { status: createRes.status, body: createBody };
  if (!createRes.ok) throw new Error(createBody.error || `create ${createRes.status}`);

  const channelId = createBody.channel.id;
  const postRes = await fetch(`${BASE}/api/studio/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Hello room ${MARKER}`,
      fromBotId: "studio-lead",
    }),
  });
  const postBody = await postRes.json();
  result.post = { status: postRes.status, body: postBody };
  if (!postRes.ok) throw new Error(postBody.error || `post ${postRes.status}`);

  const getRes = await fetch(`${BASE}/api/studio/channels/${channelId}`);
  const getBody = await getRes.json();
  result.get = { status: getRes.status, body: getBody };

  const messages = getBody.messages || [];
  const members = getBody.channel?.memberBotIds || [];
  result.pass =
    createRes.status === 201 &&
    postRes.status === 201 &&
    getRes.ok &&
    members.includes("studio-lead") &&
    members.includes("custom-researcher-demo") &&
    messages.some((m) => (m.body || "").includes(MARKER));

  await writeFile(`${OUT}/p12-channels-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p12-channels-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
