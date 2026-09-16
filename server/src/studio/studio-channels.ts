/**
 * P1.2 — multi-bot rooms (Grok CreateChannel parity).
 *
 * Creates a real `channels` row with N member bots so the roster can open it,
 * plus studio_channels / studio_channel_messages for listable posts.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, channels, studioChannelMessages, studioChannels } from "../db/schema";
import type { AgentActor } from "../agents/profile-types";

export type StudioChannelRow = {
  id: string;
  name: string;
  channelId: string;
  threadId: string;
  memberBotIds: string[];
  createdByBotId: string | null;
  createdAt: Date;
};

export type StudioChannelMessageRow = {
  id: string;
  studioChannelId: string;
  fromBotId: string;
  body: string;
  createdAt: Date;
};

type ChannelCreate = {
  create: (
    actor: AgentActor,
    agentIds: string[],
  ) => Promise<{ id: string; threadId: string; name: string; agentIds: string[] }>;
  recordActivity: (
    actor: AgentActor,
    channelId: string,
    input: { text: string; agentId?: string; at?: Date },
  ) => Promise<void>;
};

export type StudioChannelBus = {
  create: (input: {
    name: string;
    memberBotIds: string[];
    actorId: string;
    createdByBotId?: string;
  }) => Promise<
    { ok: true; channel: StudioChannelRow } | { ok: false; error: string; status: 400 | 404 }
  >;
  list: () => Promise<StudioChannelRow[]>;
  get: (id: string) => Promise<StudioChannelRow | null>;
  post: (input: {
    studioChannelId: string;
    fromBotId: string;
    message: string;
    actorId: string;
  }) => Promise<
    | { ok: true; message: StudioChannelMessageRow; channel: StudioChannelRow }
    | { ok: false; error: string; status: 400 | 404 }
  >;
  listMessages: (studioChannelId: string, limit?: number) => Promise<StudioChannelMessageRow[]>;
};

function asMembers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

function mapRow(row: typeof studioChannels.$inferSelect): StudioChannelRow {
  return {
    id: row.id,
    name: row.name,
    channelId: row.channelId,
    threadId: row.threadId,
    memberBotIds: asMembers(row.memberBotIds),
    createdByBotId: row.createdByBotId,
    createdAt: row.createdAt,
  };
}

export function createStudioChannelBus(options: {
  database: Database;
  channelStore: ChannelCreate;
  actorFor: (userId: string) => Promise<AgentActor | null>;
}): StudioChannelBus {
  const { database, channelStore, actorFor } = options;

  return {
    async create(input) {
      const name = input.name?.trim() ?? "";
      if (!name) return { ok: false, error: "name is required.", status: 400 };
      const members = [...new Set(input.memberBotIds.map((m) => m.trim()).filter(Boolean))];
      if (members.length < 1) {
        return { ok: false, error: "At least one memberBotId is required.", status: 400 };
      }

      for (const id of members) {
        const [row] = await database
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1);
        if (!row) {
          return { ok: false, error: `Unknown bot id: ${id}`, status: 404 };
        }
      }

      const actor = await actorFor(input.actorId);
      if (!actor) {
        return { ok: false, error: "Could not resolve actor for channel create.", status: 400 };
      }

      const created = await channelStore.create(actor, members);
      // Custom room name (channelStore names from agent display names).
      await database
        .update(channels)
        .set({ name: name.slice(0, 120) })
        .where(eq(channels.id, created.id));

      const id = `studio-ch-${randomUUID().slice(0, 8)}`;
      await database.insert(studioChannels).values({
        id,
        name: name.slice(0, 120),
        channelId: created.id,
        threadId: created.threadId,
        memberBotIds: members,
        createdByBotId: input.createdByBotId ?? null,
      });

      const channel = await this.get(id);
      if (!channel) return { ok: false, error: "Channel created but could not be read back.", status: 400 };
      return { ok: true, channel };
    },

    async list() {
      const rows = await database
        .select()
        .from(studioChannels)
        .orderBy(desc(studioChannels.createdAt));
      return rows.map(mapRow);
    },

    async get(id) {
      const [row] = await database
        .select()
        .from(studioChannels)
        .where(eq(studioChannels.id, id))
        .limit(1);
      return row ? mapRow(row) : null;
    },

    async post(input) {
      const body = input.message?.trim() ?? "";
      if (!body) return { ok: false, error: "message is required.", status: 400 };
      const channel = await this.get(input.studioChannelId);
      if (!channel) return { ok: false, error: "No such studio channel.", status: 404 };

      const [from] = await database
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, input.fromBotId))
        .limit(1);
      if (!from) return { ok: false, error: "Unknown fromBotId.", status: 404 };

      if (!channel.memberBotIds.includes(input.fromBotId)) {
        return {
          ok: false,
          error: `${input.fromBotId} is not a member of this channel.`,
          status: 400,
        };
      }

      const actor = await actorFor(input.actorId);
      if (!actor) {
        return { ok: false, error: "Could not resolve actor for channel post.", status: 400 };
      }

      const id = `schmsg-${randomUUID().slice(0, 8)}`;
      await database.insert(studioChannelMessages).values({
        id,
        studioChannelId: channel.id,
        fromBotId: input.fromBotId,
        body,
      });

      const preview = `[${channel.name}] ${from.name}: ${body}`.slice(0, 500);
      await channelStore
        .recordActivity(actor, channel.channelId, {
          text: preview,
          agentId: input.fromBotId,
          at: new Date(),
        })
        .catch(() => {});

      const [msg] = await database
        .select()
        .from(studioChannelMessages)
        .where(eq(studioChannelMessages.id, id))
        .limit(1);

      return {
        ok: true,
        message: msg as StudioChannelMessageRow,
        channel,
      };
    },

    async listMessages(studioChannelId, limit = 50) {
      const rows = await database
        .select()
        .from(studioChannelMessages)
        .where(eq(studioChannelMessages.studioChannelId, studioChannelId))
        .orderBy(desc(studioChannelMessages.createdAt))
        .limit(limit);
      return rows as StudioChannelMessageRow[];
    },
  };
}
