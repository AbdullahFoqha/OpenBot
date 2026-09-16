#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P23_MCP_${Date.now()}`;

const result = { pass: false, marker: MARKER, steps: {}, error: null };

try {
  const catRes = await fetch(`${BASE}/api/studio/mcp/catalogue`);
  const catBody = await catRes.json();
  result.steps.catalogue = { status: catRes.status, count: catBody.connectors?.length };
  if (!catRes.ok) throw new Error(catBody.error || `catalogue ${catRes.status}`);

  const keys = (catBody.connectors || []).map((c) => c.key);
  if (!keys.includes("routines") || !keys.includes("google-drive")) {
    throw new Error("catalogue missing expected keys");
  }

  const installRes = await fetch(`${BASE}/api/studio/mcp/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "routines" }),
  });
  const installBody = await installRes.json().catch(() => ({}));
  result.steps.install = { status: installRes.status, body: installBody };
  // 201 fresh or 200/201 idempotent re-add
  if (!installRes.ok) throw new Error(installBody.error || `install ${installRes.status}`);

  const statusRes = await fetch(`${BASE}/api/studio/mcp/status?serverId=routines`);
  const statusBody = await statusRes.json();
  result.steps.status = { status: statusRes.status, body: statusBody };
  const routines = (statusBody.servers || []).find((s) => s.id === "routines");
  if (!statusRes.ok || !routines || routines.authStatus !== "ready") {
    throw new Error(`routines not ready: ${JSON.stringify(routines)}`);
  }

  const connectBuiltin = await fetch(`${BASE}/api/studio/mcp/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: "routines" }),
  });
  const connectBuiltinBody = await connectBuiltin.json().catch(() => ({}));
  result.steps.connectBuiltin = { status: connectBuiltin.status, body: connectBuiltinBody };
  if (connectBuiltin.status !== 400) {
    throw new Error("expected 400 connect on builtin routines");
  }

  // google-drive: connect before install should 409; after install may 503 (no public URL) or 409 (no client) or 200
  const connectMissing = await fetch(`${BASE}/api/studio/mcp/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: "google-drive" }),
  });
  const connectMissingBody = await connectMissing.json().catch(() => ({}));
  result.steps.connectDrive = { status: connectMissing.status, body: connectMissingBody };

  const driveRow = (catBody.connectors || []).find((c) => c.key === "google-drive");
  const driveInstalled = driveRow?.installed === true;
  const connectOk =
    (!driveInstalled && (connectMissing.status === 409 || connectMissing.status === 400)) ||
    (driveInstalled &&
      (connectMissing.status === 200 ||
        connectMissing.status === 503 ||
        connectMissing.status === 409));

  result.pass =
    catRes.ok &&
    installRes.ok &&
    routines.authStatus === "ready" &&
    connectBuiltin.status === 400 &&
    connectOk;

  await writeFile(`${OUT}/p23-mcp-connectors-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify({
    pass: result.pass,
    catalogue: result.steps.catalogue,
    install: installRes.status,
    routinesAuth: routines.authStatus,
    connectBuiltin: connectBuiltin.status,
    connectDrive: connectMissing.status,
  }, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p23-mcp-connectors-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
