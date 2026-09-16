/**
 * P2.4 — bot-scoped secret vault (Grok secret-request parity).
 * Set/list/delete; never returns plaintext after write.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { agents, studioBotSecrets } from "../db/schema";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_CHARS = 8_000;

export type StudioBotSecretMeta = {
  id: string;
  botId: string;
  name: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Always true when listed — value never included. */
  hasValue: true;
};

export type StudioBotSecretStore = {
  set: (input: {
    botId: string;
    name: string;
    value: string;
    by: string;
  }) => Promise<
    | { ok: true; secret: StudioBotSecretMeta; created: boolean }
    | { ok: false; error: string; status: 400 | 404 }
  >;
  list: (botId: string) => Promise<StudioBotSecretMeta[]>;
  remove: (
    botId: string,
    name: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; status: 404 }>;
  /**
   * Internal read for runtime injection — not exposed on Lead list tools.
   * Returns null when missing.
   */
  readPlaintext: (botId: string, name: string) => Promise<string | null>;
};

function mapRow(row: typeof studioBotSecrets.$inferSelect): StudioBotSecretMeta {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasValue: true,
  };
}

export function createStudioBotSecretStore(options: {
  database: Database;
  encryptionKey: string;
}): StudioBotSecretStore {
  const { database, encryptionKey } = options;

  async function requireBot(botId: string) {
    const [row] = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, botId))
      .limit(1);
    return Boolean(row);
  }

  return {
    async set(input) {
      const botId = input.botId?.trim() ?? "";
      const name = input.name?.trim() ?? "";
      const value = input.value ?? "";
      if (!botId) return { ok: false, error: "botId is required.", status: 400 };
      if (!NAME_RE.test(name)) {
        return {
          ok: false,
          error:
            "name must be an env-style identifier (letters, digits, underscore; start with letter or _).",
          status: 400,
        };
      }
      if (!value) return { ok: false, error: "value is required.", status: 400 };
      if (value.length > MAX_VALUE_CHARS) {
        return {
          ok: false,
          error: `value must be at most ${MAX_VALUE_CHARS} characters.`,
          status: 400,
        };
      }
      if (!(await requireBot(botId))) {
        return { ok: false, error: `Unknown bot id: ${botId}`, status: 404 };
      }

      const encryptedValue = await encryptSecret(encryptionKey, value);
      const [existing] = await database
        .select({ id: studioBotSecrets.id })
        .from(studioBotSecrets)
        .where(and(eq(studioBotSecrets.botId, botId), eq(studioBotSecrets.name, name)))
        .limit(1);

      if (existing) {
        await database
          .update(studioBotSecrets)
          .set({
            encryptedValue,
            createdBy: input.by,
            updatedAt: sql`now()`,
          })
          .where(eq(studioBotSecrets.id, existing.id));
        const [row] = await database
          .select()
          .from(studioBotSecrets)
          .where(eq(studioBotSecrets.id, existing.id))
          .limit(1);
        return { ok: true, secret: mapRow(row!), created: false };
      }

      const id = `sec-${randomUUID()}`;
      await database.insert(studioBotSecrets).values({
        id,
        botId,
        name,
        encryptedValue,
        createdBy: input.by,
      });
      const [row] = await database
        .select()
        .from(studioBotSecrets)
        .where(eq(studioBotSecrets.id, id))
        .limit(1);
      return { ok: true, secret: mapRow(row!), created: true };
    },

    async list(botId) {
      const id = botId?.trim() ?? "";
      if (!id) return [];
      const rows = await database
        .select()
        .from(studioBotSecrets)
        .where(eq(studioBotSecrets.botId, id))
        .orderBy(asc(studioBotSecrets.name));
      return rows.map(mapRow);
    },

    async remove(botId, name) {
      const b = botId?.trim() ?? "";
      const n = name?.trim() ?? "";
      const deleted = await database
        .delete(studioBotSecrets)
        .where(and(eq(studioBotSecrets.botId, b), eq(studioBotSecrets.name, n)))
        .returning({ id: studioBotSecrets.id });
      if (deleted.length === 0) {
        return { ok: false, error: "No such secret for that bot.", status: 404 };
      }
      return { ok: true };
    },

    async readPlaintext(botId, name) {
      const [row] = await database
        .select()
        .from(studioBotSecrets)
        .where(
          and(
            eq(studioBotSecrets.botId, botId.trim()),
            eq(studioBotSecrets.name, name.trim()),
          ),
        )
        .limit(1);
      if (!row) return null;
      return decryptSecret(encryptionKey, row.encryptedValue);
    },
  };
}
