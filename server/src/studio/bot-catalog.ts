/**
 * Dynamic studio bots (P0.1 studio_spawn_bot) — catalog merge over built-ins.
 *
 * Chat path: spawn upserts a built_in `agents` row with configuration.systemPrompt so
 * CopilotKit / registeredAgentFromRow work without kit regenerate.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import { studioDynamicBots } from "../db/schema/studio";
import { grantLeadCanMessage } from "./bot-messaging";

export const BUILTIN_BOT_IDS = [
  "studio-lead",
  "react-native-engineer",
  "quality-engineer",
  "product-designer",
  "product-researcher",
  "technical-lead",
] as const;

export type BuiltinBotId = (typeof BUILTIN_BOT_IDS)[number];

/**
 * Appended to every dynamically spawned bot's systemPrompt, on top of whatever role text the
 * spawning Bot wrote.
 *
 * THE SIX BUILT-INS GET THIS SEPARATELY, in the tenant package's agents.yaml (outside this repo,
 * per deployment) — hand-written there because that file is the one thing actually re-synced into
 * the database on every boot. A spawned bot has no such file behind it: whatever systemPrompt
 * studio_spawn_bot was given is the whole prompt, forever, unless something appends to it here.
 * Observed live without this: a spawned "Pocket Love Researcher" with a four-sentence role
 * description had no idea studio_message_bot existed, no self-serve instinct, and narrated having
 * "sent a summary notice" that no tool call ever produced. A marker check guards both call sites
 * below so re-saving an existing bot never doubles this up.
 */
const SPAWNED_BOT_POLICY_MARKER = "Never narrate an action you did not take";
const SPAWNED_BOT_POLICY = `

## Self-serve before you stall

You have tools to get your own inputs — do not ask the person or another bot to hand you a report, a code excerpt, or a link before you will start, when a tool can get it for you in the same turn: studio_read_file (local checkout), studio_inspect_product (screen/route inventory), studio_github_read (PR/issue/repo status, or a file's content on any branch via query: file_view), studio_web_fetch (a URL you already have), studio_task_status / studio_list_tasks (task status). Only ask a person or another bot for something none of these tools can get you — a business decision, a preference, evidence that exists nowhere else.

## Tool usage & chat policy

A question or lookup — including one from another bot — gets answered directly in chat with the matching read-only tool, not by calling studio_run_task. Only call studio_run_task when the request is explicitly to implement, fix, or ship a code change; it always culminates in a draft PR once files change, so it is the wrong tool for anything else. When you call it, you will automatically receive a priority message with the outcome once the task finishes (shipped or blocked) — you do not have to remember to poll studio_task_status. When that message says blocked or failed, decide whether to retry, hand it to a different bot, or escalate with the evidence — do not just acknowledge it.

## When a bot you delegated to needs the person's input

If a bot you handed something to comes back with questions it cannot answer itself, do not treat that as the end of the thread. Bring it to the person plainly: say who you asked, what they need to know, and ask directly. If a delegated ask never gets an answer back, say so — do not assume it worked.

## Never narrate an action you did not take

Only say you sent, notified, reported to, or delivered something to another bot or the person when a tool call for that actually ran and returned success. If you did not call a tool, say plainly what you actually did instead — do not describe an outcome that did not happen.

## "Report to X" / "tell X" / "let X know" means calling a tool, not talking about it

This is an instruction to call studio_message_bot (or message_bot) with that bot's id as the target, in the same turn — not answering in your own chat, not drawing an interface, not saying what you would tell them.

## When told to proceed without waiting for more input

"Just do it", "do your best", "go ahead anyway" means: use your own judgment to produce a real, substantive first draft now, marking guesses as assumptions to validate — not a restatement of the questions you wish someone would answer. A framework of blank questions is not a deliverable.`;

function withSpawnedBotPolicy(prompt: string): string {
  return prompt.includes(SPAWNED_BOT_POLICY_MARKER)
    ? prompt
    : prompt + SPAWNED_BOT_POLICY;
}

const BOT_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

export function validateBotId(id: string): { ok: true } | { ok: false; error: string } {
  if (!BOT_ID_RE.test(id)) {
    return {
      ok: false,
      error: "id must match /^[a-z][a-z0-9-]{1,63}$/ (kebab-case slug).",
    };
  }
  if ((BUILTIN_BOT_IDS as readonly string[]).includes(id)) {
    return { ok: false, error: `id "${id}" collides with a built-in bot.` };
  }
  return { ok: true };
}

export function isBuiltinBotId(id: string): boolean {
  return (BUILTIN_BOT_IDS as readonly string[]).includes(id);
}

export type CatalogBot = {
  id: string;
  name: string;
  title: string | null;
  systemPrompt: string | null;
  source: "builtin" | "dynamic";
  capabilities: string[];
  templateRoleId?: string | null;
  archivedAt?: string | null;
};

export type SpawnBotInput = {
  id: string;
  name: string;
  title?: string;
  systemPrompt?: string;
  templateRoleId?: string;
  avatarSeed?: string;
  capabilities?: string[];
};

export async function resolveSystemPrompt(
  database: Database,
  input: SpawnBotInput,
): Promise<{ ok: true; prompt: string } | { ok: false; error: string }> {
  const direct = input.systemPrompt?.trim();
  if (direct) return { ok: true, prompt: withSpawnedBotPolicy(direct) };
  const template = input.templateRoleId?.trim();
  if (!template) {
    return { ok: false, error: "systemPrompt is required unless templateRoleId is set." };
  }
  const [row] = await database
    .select({ configuration: agents.configuration })
    .from(agents)
    .where(eq(agents.id, template))
    .limit(1);
  const cfg = (row?.configuration ?? {}) as { systemPrompt?: unknown };
  const prompt = typeof cfg.systemPrompt === "string" ? cfg.systemPrompt.trim() : "";
  if (!prompt) {
    return {
      ok: false,
      error: `templateRoleId "${template}" has no systemPrompt to copy.`,
    };
  }
  return { ok: true, prompt: withSpawnedBotPolicy(prompt) };
}

export async function listMergedBots(database: Database): Promise<CatalogBot[]> {
  const builtinRows = await database
    .select({
      id: agents.id,
      name: agents.name,
      configuration: agents.configuration,
      title: agentProfiles.title,
    })
    .from(agents)
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(eq(agents.type, "built_in"));

  const dynamicRows = await database
    .select()
    .from(studioDynamicBots)
    .where(isNull(studioDynamicBots.archivedAt));

  const dynamicIds = new Set(dynamicRows.map((r) => r.id));
  const out: CatalogBot[] = [];

  for (const row of builtinRows) {
    if (dynamicIds.has(row.id)) continue; // should not happen; dynamic owns id
    const cfg = (row.configuration ?? {}) as { systemPrompt?: string; studioDynamic?: boolean };
    if (cfg.studioDynamic) continue; // listed from dynamic table
    out.push({
      id: row.id,
      name: row.name,
      title: row.title ?? null,
      systemPrompt: typeof cfg.systemPrompt === "string" ? cfg.systemPrompt : null,
      source: "builtin",
      capabilities: [],
    });
  }

  for (const row of dynamicRows) {
    const caps = Array.isArray(row.capabilities)
      ? (row.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    out.push({
      id: row.id,
      name: row.name,
      title: row.title,
      systemPrompt: row.systemPrompt,
      source: "dynamic",
      capabilities: caps,
      templateRoleId: row.templateRoleId,
      archivedAt: null,
    });
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function getCatalogBot(
  database: Database,
  id: string,
): Promise<CatalogBot | null> {
  const all = await listMergedBots(database);
  return all.find((b) => b.id === id) ?? null;
}

export async function createDynamicBot(
  database: Database,
  input: SpawnBotInput,
): Promise<
  | { ok: true; bot: CatalogBot; created: true }
  | { ok: false; error: string; status: 400 | 409 }
> {
  const idCheck = validateBotId(input.id);
  if (!idCheck.ok) {
    const status = idCheck.error.includes("built-in") ? 409 : 400;
    return { ok: false, error: idCheck.error, status };
  }

  const name = input.name.trim();
  if (!name) return { ok: false, error: "name is required.", status: 400 };

  const promptRes = await resolveSystemPrompt(database, input);
  if (!promptRes.ok) return { ok: false, error: promptRes.error, status: 400 };

  const [existingAgent] = await database
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, input.id))
    .limit(1);
  if (existingAgent) {
    return { ok: false, error: `Bot id "${input.id}" already exists.`, status: 409 };
  }

  const [existingDyn] = await database
    .select({ id: studioDynamicBots.id, archivedAt: studioDynamicBots.archivedAt })
    .from(studioDynamicBots)
    .where(eq(studioDynamicBots.id, input.id))
    .limit(1);
  if (existingDyn && !existingDyn.archivedAt) {
    return { ok: false, error: `Dynamic bot "${input.id}" already exists.`, status: 409 };
  }

  const capabilities = Array.isArray(input.capabilities)
    ? input.capabilities.filter((c) => typeof c === "string")
    : [];
  const title = (input.title?.trim() || name).slice(0, 120);
  const avatarSeed = (input.avatarSeed?.trim() || input.id).slice(0, 120);

  await database.transaction(async (tx) => {
    if (existingDyn?.archivedAt) {
      await tx
        .update(studioDynamicBots)
        .set({
          name,
          title,
          systemPrompt: promptRes.prompt,
          avatarSeed,
          templateRoleId: input.templateRoleId ?? null,
          capabilities,
          archivedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(studioDynamicBots.id, input.id));
    } else {
      await tx.insert(studioDynamicBots).values({
        id: input.id,
        name,
        title,
        systemPrompt: promptRes.prompt,
        avatarSeed,
        templateRoleId: input.templateRoleId ?? null,
        capabilities,
      });
    }

    await tx.insert(agents).values({
      id: input.id,
      name,
      type: "built_in",
      configuration: {
        systemPrompt: promptRes.prompt,
        studioDynamic: true,
        capabilities,
      },
    });

    await tx.insert(agentProfiles).values({
      agentId: input.id,
      ownerUserId: null,
      title,
      roleDescription: promptRes.prompt.slice(0, 4000),
      avatarSeed,
      visibility: "public",
    });
  });

  await grantLeadCanMessage(database, input.id);

  const bot = await getCatalogBot(database, input.id);
  if (!bot) return { ok: false, error: "Created but could not re-read bot.", status: 400 };
  return { ok: true, bot, created: true };
}

export async function updateDynamicBot(
  database: Database,
  id: string,
  patch: { name?: string; title?: string; systemPrompt?: string; avatarSeed?: string },
): Promise<{ ok: true; bot: CatalogBot } | { ok: false; error: string; status: 400 | 403 | 404 }> {
  if (isBuiltinBotId(id)) {
    return { ok: false, error: "Built-in bots cannot be patched via this API.", status: 403 };
  }
  const [row] = await database
    .select()
    .from(studioDynamicBots)
    .where(and(eq(studioDynamicBots.id, id), isNull(studioDynamicBots.archivedAt)))
    .limit(1);
  if (!row) return { ok: false, error: "No such dynamic bot.", status: 404 };

  const name = patch.name?.trim() ?? row.name;
  const title = patch.title?.trim() ?? row.title ?? name;
  const systemPrompt = patch.systemPrompt?.trim()
    ? withSpawnedBotPolicy(patch.systemPrompt.trim())
    : row.systemPrompt;
  const avatarSeed = patch.avatarSeed?.trim() ?? row.avatarSeed ?? id;

  await database.transaction(async (tx) => {
    await tx
      .update(studioDynamicBots)
      .set({
        name,
        title,
        systemPrompt,
        avatarSeed,
        updatedAt: sql`now()`,
      })
      .where(eq(studioDynamicBots.id, id));
    await tx
      .update(agents)
      .set({
        name,
        configuration: {
          systemPrompt,
          studioDynamic: true,
          capabilities: row.capabilities ?? [],
        },
        updatedAt: sql`now()`,
      })
      .where(eq(agents.id, id));
    await tx
      .update(agentProfiles)
      .set({
        title,
        roleDescription: systemPrompt.slice(0, 4000),
        avatarSeed,
        updatedAt: sql`now()`,
      })
      .where(eq(agentProfiles.agentId, id));
  });

  const bot = await getCatalogBot(database, id);
  if (!bot) return { ok: false, error: "Updated but could not re-read.", status: 400 };
  return { ok: true, bot };
}

export async function archiveDynamicBot(
  database: Database,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string; status: 403 | 404 }> {
  if (isBuiltinBotId(id)) {
    return { ok: false, error: "Built-in bots cannot be deleted.", status: 403 };
  }
  const [row] = await database
    .select({ id: studioDynamicBots.id })
    .from(studioDynamicBots)
    .where(and(eq(studioDynamicBots.id, id), isNull(studioDynamicBots.archivedAt)))
    .limit(1);
  if (!row) return { ok: false, error: "No such dynamic bot.", status: 404 };

  await database.transaction(async (tx) => {
    await tx
      .update(studioDynamicBots)
      .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(studioDynamicBots.id, id));
    await tx
      .update(agentProfiles)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(agentProfiles.agentId, id));
    await tx.delete(agents).where(eq(agents.id, id));
  });
  return { ok: true };
}
