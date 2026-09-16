/**
 * P1.4 — skill packs attachable to bot roles (Grok skills parity).
 *
 * Creating a pack stores skill definitions. Attaching upserts deployment skills
 * and writes plugin_grants (kind=skill) so the bot may use them.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agents,
  pluginGrants,
  skills,
  studioSkillPackAttachments,
  studioSkillPacks,
} from "../db/schema";

export type PackSkillDef = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
};

export type StudioSkillPackRow = {
  id: string;
  name: string;
  description: string;
  skills: PackSkillDef[];
  createdAt: Date;
};

export type StudioSkillPackStore = {
  create: (input: {
    name: string;
    description?: string;
    skills: PackSkillDef[];
  }) => Promise<
    { ok: true; pack: StudioSkillPackRow } | { ok: false; error: string; status: 400 }
  >;
  list: () => Promise<StudioSkillPackRow[]>;
  get: (id: string) => Promise<StudioSkillPackRow | null>;
  attach: (input: {
    packId: string;
    botId: string;
    by?: string;
  }) => Promise<
    | {
        ok: true;
        pack: StudioSkillPackRow;
        botId: string;
        grantedSlugs: string[];
      }
    | { ok: false; error: string; status: 400 | 404 }
  >;
  listForBot: (botId: string) => Promise<StudioSkillPackRow[]>;
};

function asSkills(raw: unknown): PackSkillDef[] {
  if (!Array.isArray(raw)) return [];
  const out: PackSkillDef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (
      typeof s.slug === "string" &&
      typeof s.title === "string" &&
      typeof s.summary === "string" &&
      typeof s.instructions === "string"
    ) {
      out.push({
        slug: s.slug.trim(),
        title: s.title.trim(),
        summary: s.summary.trim(),
        instructions: s.instructions.trim(),
      });
    }
  }
  return out;
}

function mapPack(row: typeof studioSkillPacks.$inferSelect): StudioSkillPackRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    skills: asSkills(row.skills),
    createdAt: row.createdAt,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "skill";
}

export function createStudioSkillPackStore(database: Database): StudioSkillPackStore {
  return {
    async create(input) {
      const name = input.name?.trim() ?? "";
      if (!name) return { ok: false, error: "name is required.", status: 400 };
      const skillDefs = (input.skills ?? [])
        .map((s) => ({
          slug: s.slug?.trim() || slugify(s.title || name),
          title: s.title?.trim() || name,
          summary: s.summary?.trim() || `Skill from pack ${name}`,
          instructions: s.instructions?.trim() || "",
        }))
        .filter((s) => s.slug && s.instructions);
      if (skillDefs.length < 1) {
        return {
          ok: false,
          error: "At least one skill with slug/title and instructions is required.",
          status: 400,
        };
      }
      // unique slugs within pack
      const slugs = new Set(skillDefs.map((s) => s.slug));
      if (slugs.size !== skillDefs.length) {
        return { ok: false, error: "Duplicate skill slugs in pack.", status: 400 };
      }

      const id = `pack-${randomUUID().slice(0, 8)}`;
      await database.insert(studioSkillPacks).values({
        id,
        name: name.slice(0, 120),
        description: (input.description ?? "").slice(0, 2000),
        skills: skillDefs,
      });
      const pack = await this.get(id);
      if (!pack) return { ok: false, error: "Pack created but could not be read.", status: 400 };
      return { ok: true, pack };
    },

    async list() {
      const rows = await database
        .select()
        .from(studioSkillPacks)
        .orderBy(desc(studioSkillPacks.createdAt));
      return rows.map(mapPack);
    },

    async get(id) {
      const [row] = await database
        .select()
        .from(studioSkillPacks)
        .where(eq(studioSkillPacks.id, id))
        .limit(1);
      return row ? mapPack(row) : null;
    },

    async attach(input) {
      const pack = await this.get(input.packId);
      if (!pack) return { ok: false, error: "No such skill pack.", status: 404 };
      const [bot] = await database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, input.botId))
        .limit(1);
      if (!bot) return { ok: false, error: `Unknown bot id: ${input.botId}`, status: 404 };

      const by = input.by ?? "dev-local-user";
      const grantedSlugs: string[] = [];

      for (const skill of pack.skills) {
        await database
          .insert(skills)
          .values({
            id: skill.slug,
            slug: skill.slug,
            ownerUserId: null,
            title: skill.title,
            summary: skill.summary,
            instructions: skill.instructions,
            origin: "catalogue",
            installedBy: by,
          })
          .onConflictDoUpdate({
            target: skills.slug,
            set: {
              title: skill.title,
              summary: skill.summary,
              instructions: skill.instructions,
              updatedAt: new Date(),
            },
          });

        await database
          .insert(pluginGrants)
          .values({
            kind: "skill",
            ref: skill.slug,
            agentId: input.botId,
            grantedBy: by,
          })
          .onConflictDoUpdate({
            target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
            set: { grantedBy: by, updatedAt: new Date() },
          });
        grantedSlugs.push(skill.slug);
      }

      await database
        .insert(studioSkillPackAttachments)
        .values({
          packId: pack.id,
          botId: input.botId,
        })
        .onConflictDoUpdate({
          target: [studioSkillPackAttachments.packId, studioSkillPackAttachments.botId],
          set: { attachedAt: new Date() },
        });

      return { ok: true, pack, botId: input.botId, grantedSlugs };
    },

    async listForBot(botId) {
      const rows = await database
        .select({
          pack: studioSkillPacks,
        })
        .from(studioSkillPackAttachments)
        .innerJoin(
          studioSkillPacks,
          eq(studioSkillPackAttachments.packId, studioSkillPacks.id),
        )
        .where(eq(studioSkillPackAttachments.botId, botId))
        .orderBy(desc(studioSkillPackAttachments.attachedAt));
      return rows.map((r) => mapPack(r.pack));
    },
  };
}
