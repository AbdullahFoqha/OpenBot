#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P24_SEC_${Date.now()}`;
const BOT = "studio-lead";
const NAME = `P24_DEMO_${Date.now().toString(36).toUpperCase()}`;
const VALUE = `secret-value-${MARKER}`;

const result = { pass: false, marker: MARKER, bot: BOT, name: NAME, steps: {}, error: null };

try {
  const put = await fetch(`${BASE}/api/studio/bots/${BOT}/secrets/${NAME}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: VALUE }),
  });
  const putBody = await put.json();
  result.steps.put = { status: put.status, body: putBody };
  if (!put.ok) throw new Error(putBody.error || `put ${put.status}`);

  const list = await fetch(`${BASE}/api/studio/bots/${BOT}/secrets`);
  const listBody = await list.json();
  result.steps.list = { status: list.status, count: listBody.count };
  const row = (listBody.secrets || []).find((s) => s.name === NAME);
  if (!list.ok || !row) throw new Error("secret missing from list");
  if (row.value || row.plaintext || row.encryptedValue) {
    throw new Error("list leaked secret material");
  }
  // ensure response JSON string does not contain plaintext
  if (JSON.stringify(listBody).includes(VALUE)) {
    throw new Error("list JSON contains plaintext value");
  }

  const put2 = await fetch(`${BASE}/api/studio/bots/${BOT}/secrets/${NAME}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: VALUE + "-rotated" }),
  });
  const put2Body = await put2.json();
  result.steps.rotate = { status: put2.status, created: put2Body.created };

  const del = await fetch(`${BASE}/api/studio/bots/${BOT}/secrets/${NAME}`, {
    method: "DELETE",
  });
  result.steps.del = { status: del.status };

  const listAfter = await fetch(`${BASE}/api/studio/bots/${BOT}/secrets`);
  const listAfterBody = await listAfter.json();
  const still = (listAfterBody.secrets || []).some((s) => s.name === NAME);

  result.pass =
    (put.status === 201 || put.status === 200) &&
    putBody.secret?.name === NAME &&
    putBody.secret?.hasValue === true &&
    !("value" in (putBody.secret || {})) &&
    list.ok &&
    Boolean(row) &&
    put2.ok &&
    put2Body.created === false &&
    del.status === 204 &&
    still === false;

  await writeFile(`${OUT}/p24-bot-secrets-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify({
    pass: result.pass,
    put: put.status,
    listCount: listBody.count,
    rotateCreated: put2Body.created,
    del: del.status,
  }, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p24-bot-secrets-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
