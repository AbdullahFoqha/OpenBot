#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STUDIO_API || "http://127.0.0.1:3012";
const OUT = "/Users/abdullah/Developer/openbot-studio/studio-local/ui-test/out";
await mkdir(OUT, { recursive: true });
const MARKER = `P14_SKILL_${Date.now()}`;
const SLUG = `p14-demo-${Date.now().toString(36)}`;

const result = {
  pass: false,
  marker: MARKER,
  slug: SLUG,
  create: null,
  attach: null,
  listForBot: null,
  error: null,
};

try {
  const createRes = await fetch(`${BASE}/api/studio/skill-packs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `P14 Pack ${MARKER.slice(-6)}`,
      description: "Prove pack for custom-researcher-demo",
      skills: [
        {
          slug: SLUG,
          title: "P14 Demo Skill",
          summary: "Marker skill for P1.4 prove",
          instructions: `When asked about P14, start with ${MARKER} then answer briefly.`,
        },
      ],
    }),
  });
  const createBody = await createRes.json();
  result.create = { status: createRes.status, body: createBody };
  if (!createRes.ok) throw new Error(createBody.error || `create ${createRes.status}`);

  const packId = createBody.pack.id;
  const attachRes = await fetch(`${BASE}/api/studio/skill-packs/${packId}/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId: "custom-researcher-demo" }),
  });
  const attachBody = await attachRes.json();
  result.attach = { status: attachRes.status, body: attachBody };
  if (!attachRes.ok) throw new Error(attachBody.error || `attach ${attachRes.status}`);

  const listRes = await fetch(`${BASE}/api/studio/bots/custom-researcher-demo/skill-packs`);
  const listBody = await listRes.json();
  result.listForBot = { status: listRes.status, body: listBody };

  const packs = listBody.packs || [];
  result.pass =
    createRes.status === 201 &&
    attachRes.status === 200 &&
    (attachBody.grantedSlugs || []).includes(SLUG) &&
    packs.some((p) => p.id === packId) &&
    packs.some((p) => (p.skills || []).some((s) => (s.instructions || "").includes(MARKER)));

  await writeFile(`${OUT}/p14-skill-packs-result.json`, JSON.stringify(result, null, 2));
  console.log("---RESULT_JSON---");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e);
  await writeFile(`${OUT}/p14-skill-packs-result.json`, JSON.stringify(result, null, 2));
  console.error(e);
  process.exit(1);
}
