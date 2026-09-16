/**
 * P1.3 — durable memory per bot + shared user scope (Grok update_state memory parity).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, studioMemories } from "../db/schema";

export type MemoryTier = "profile" | "log" | "note";
export type MemoryScope = "agent" | "user";

export type StudioMemoryRow = {
  id: string;
  botId: string | null;
  scope: MemoryScope;
  tier: MemoryTier;
  fact: string;
  createdAt: Date;
};

export type StudioMemoryStore = {
  write: (input: {
    fact: string;
    scope?: MemoryScope;
    tier?: MemoryTier;
    botId?: string;
  }) => Promise<
    { ok: true; memory: StudioMemoryRow } | { ok: false; error: string; status: 400 | 404 }
  >;
  recall: (input: {
    query?: string;
    botId?: string;
    scope?: MemoryScope | "all";
    limit?: number;
  }) => Promise<StudioMemoryRow[]>;
  forget: (id: string) => Promise<{ ok: true } | { ok: false; error: string; status: 404 }>;
};

function normalizeTier(tier: string | undefined): MemoryTier {
  if (tier === "profile" || tier === "note") return tier;
  return "log";
}

function normalizeScope(scope: string | undefined): MemoryScope {
  return scope === "user" ? "user" : "agent";
}

function mapRow(row: typeof studioMemories.$inferSelect): StudioMemoryRow {
  return {
    id: row.id,
    botId: row.botId,
    scope: row.scope === "user" ? "user" : "agent",
    tier: normalizeTier(row.tier),
    fact: row.fact,
    createdAt: row.createdAt,
  };
}

export function createStudioMemoryStore(database: Database): StudioMemoryStore {
  return {
    async write(input) {
      const fact = input.fact?.trim() ?? "";
      if (!fact) return { ok: false, error: "fact is required.", status: 400 };
      if (fact.length > 4000) {
        return { ok: false, error: "fact must be at most 4000 characters.", status: 400 };
      }
      const scope = normalizeScope(input.scope);
      const tier = normalizeTier(input.tier);
      let botId: string | null = null;
      if (scope === "agent") {
        const id = input.botId?.trim() ?? "";
        if (!id) return { ok: false, error: "botId is required for agent scope.", status: 400 };
        const [row] = await database
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1);
        if (!row) return { ok: false, error: `Unknown bot id: ${id}`, status: 404 };
        botId = id;
      }

      const id = `mem-${randomUUID().slice(0, 8)}`;
      await database.insert(studioMemories).values({
        id,
        botId,
        scope,
        tier,
        fact,
      });
      const [row] = await database
        .select()
        .from(studioMemories)
        .where(eq(studioMemories.id, id))
        .limit(1);
      return { ok: true, memory: mapRow(row!) };
    },

    async recall(input) {
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
      const scope = input.scope ?? "all";
      const q = input.query?.trim();

      const conditions = [];
      if (scope === "agent") {
        if (!input.botId) return [];
        conditions.push(
          and(eq(studioMemories.scope, "agent"), eq(studioMemories.botId, input.botId)),
        );
      } else if (scope === "user") {
        conditions.push(eq(studioMemories.scope, "user"));
      } else {
        // all: this bot's agent facts + shared user facts
        if (input.botId) {
          conditions.push(
            or(
              and(eq(studioMemories.scope, "agent"), eq(studioMemories.botId, input.botId)),
              eq(studioMemories.scope, "user"),
            ),
          );
        } else {
          conditions.push(eq(studioMemories.scope, "user"));
        }
      }
      if (q) {
        conditions.push(ilike(studioMemories.fact, `%${q.replace(/[%_]/g, "\\$&")}%`));
      }

      const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
      const rows = await database
        .select()
        .from(studioMemories)
        .where(where)
        .orderBy(desc(studioMemories.createdAt))
        .limit(limit);
      return rows.map(mapRow);
    },

    async forget(id) {
      const [row] = await database
        .select({ id: studioMemories.id })
        .from(studioMemories)
        .where(eq(studioMemories.id, id))
        .limit(1);
      if (!row) return { ok: false, error: "No such memory.", status: 404 };
      await database.delete(studioMemories).where(eq(studioMemories.id, id));
      return { ok: true };
    },
  };
}
