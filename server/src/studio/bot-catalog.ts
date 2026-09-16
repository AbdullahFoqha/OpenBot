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

export const BUILTIN_BOT_IDS = [
  "studio-lead",
  "react-native-engineer",
  "quality-engineer",
  "product-designer",
  "product-researcher",
  "technical-lead",
] as const;

export type BuiltinBotId = (typeof BUILTIN_BOT_IDS)[number];

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
  if (direct) return { ok: true, prompt: direct };
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
  return { ok: true, prompt };
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
  const systemPrompt = patch.systemPrompt?.trim() ?? row.systemPrompt;
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
