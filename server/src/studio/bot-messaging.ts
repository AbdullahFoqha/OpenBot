/**
 * P1.1 — bot-to-bot messaging bus (Grok SendToAgent parity).
 *
 * - priority=true: wake recipient via handoff queue (message appears in their chat)
 * - priority=false: FYI — durable inbox + roster preview; injected on next turn / visible via inbox API
 *
 * Destructive OS actions are out of scope (messaging only).
 */
import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, pluginGrants, studioBotMessages } from "../db/schema";
import { HANDOFF_KIND } from "../agents/handoff";
import type { WorkQueue } from "../work/queue";
import type { AgentActor } from "../agents/profile-types";

export type BotMessageRow = {
  id: string;
  fromBotId: string;
  toBotId: string;
  body: string;
  priority: boolean;
  channelId: string | null;
  threadId: string | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
};

export type SendBotMessageInput = {
  fromBotId: string;
  toBotId: string;
  message: string;
  /** Default true — wake recipient. false = FYI only. */
  priority?: boolean;
  actorId: string;
};

export type BotMessaging = {
  send: (input: SendBotMessageInput) => Promise<
    | {
        ok: true;
        message: BotMessageRow;
        woke: boolean;
      }
    | { ok: false; error: string; status: 400 | 404 }
  >;
  listInbox: (toBotId: string, limit?: number) => Promise<BotMessageRow[]>;
};

type ChannelDirect = {
  direct: (
    actor: AgentActor,
    agentId: string,
  ) => Promise<{ id: string; threadId: string }>;
  recordActivity: (
    actor: AgentActor,
    channelId: string,
    input: { text: string; agentId?: string; at?: Date },
  ) => Promise<void>;
};

export function createBotMessaging(options: {
  database: Database;
  queue: WorkQueue;
  channelStore: ChannelDirect;
  actorFor: (userId: string) => Promise<AgentActor | null>;
  /** Wake handoff sweeper after queue.offer */
  kickHandoff?: () => void;
  /** Who may be messaged without a pre-existing plugin grant (always granted on send). */
  autoGrantFrom?: string;
}): BotMessaging {
  const {
    database,
    queue,
    channelStore,
    actorFor,
    kickHandoff,
    autoGrantFrom = "studio-lead",
  } = options;

  async function ensureGrant(fromBotId: string, toBotId: string, by: string) {
    await database
      .insert(pluginGrants)
      .values({
        kind: "bot",
        ref: toBotId,
        agentId: fromBotId,
        grantedBy: by,
      })
      .onConflictDoUpdate({
        target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
        set: { grantedBy: by, updatedAt: new Date() },
      });
  }

  return {
    async send(input) {
      const body = input.message?.trim() ?? "";
      if (!body) return { ok: false, error: "message is required.", status: 400 };
      if (!input.fromBotId?.trim() || !input.toBotId?.trim()) {
        return { ok: false, error: "fromBotId and toBotId are required.", status: 400 };
      }
      if (input.fromBotId === input.toBotId) {
        return { ok: false, error: "Cannot message yourself.", status: 400 };
      }

      const [from] = await database
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, input.fromBotId))
        .limit(1);
      const [to] = await database
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, input.toBotId))
        .limit(1);
      if (!from || !to) {
        return { ok: false, error: "Unknown fromBotId or toBotId.", status: 404 };
      }

      const actor = await actorFor(input.actorId);
      if (!actor) {
        return { ok: false, error: "Could not resolve actor for messaging.", status: 400 };
      }

      await ensureGrant(input.fromBotId, input.toBotId, input.actorId);
      // Lead can always reach dynamic bots
      if (input.fromBotId !== autoGrantFrom) {
        await ensureGrant(autoGrantFrom, input.toBotId, input.actorId);
      }

      const channel = await channelStore.direct(actor, input.toBotId);
      const priority = input.priority !== false;
      const id = `msg-${randomUUID()}`;

      await database.insert(studioBotMessages).values({
        id,
        fromBotId: input.fromBotId,
        toBotId: input.toBotId,
        body,
        priority,
        channelId: channel.id,
        threadId: channel.threadId,
      });

      const preview = `[${priority ? "priority" : "FYI"} from ${from.name}] ${body}`.slice(0, 500);
      await channelStore
        .recordActivity(actor, channel.id, {
          text: preview,
          agentId: input.fromBotId,
          at: new Date(),
        })
        .catch(() => {});

      let woke = false;
      if (priority) {
        const runId = `studio-msg-${id}`;
        const runPrefix = `hop:${createHash("sha256")
          .update(`${input.actorId}\u0000${runId}`)
          .digest("hex")
          .slice(0, 32)}:`;
        const key = `${runPrefix}${createHash("sha256")
          .update(JSON.stringify([input.toBotId, body, "", ""]))
          .digest("hex")
          .slice(0, 32)}`;

        const offered = await queue.offer({
          kind: HANDOFF_KIND,
          key,
          atMost: { keyPrefix: runPrefix, max: 3 },
          payload: {
            fromBotId: input.fromBotId,
            toBotId: input.toBotId,
            actorId: input.actorId,
            // Asking context = recipient thread so history is their chat
            threadId: channel.threadId,
            runId,
            depth: 1,
            initiator: { kind: "handoff", id: input.fromBotId },
            fromName: from.name,
            toName: to.name,
            task: body,
            expecting: "Acknowledge briefly if action is needed; otherwise a short confirmation is enough.",
          },
        });
        if (offered === "queued" || offered === "already") {
          woke = true;
          await database
            .update(studioBotMessages)
            .set({ deliveredAt: new Date() })
            .where(eq(studioBotMessages.id, id));
          kickHandoff?.();
        }
      }

      const [row] = await database
        .select()
        .from(studioBotMessages)
        .where(eq(studioBotMessages.id, id))
        .limit(1);

      return {
        ok: true,
        message: row as BotMessageRow,
        woke,
      };
    },

    async listInbox(toBotId, limit = 20) {
      const rows = await database
        .select()
        .from(studioBotMessages)
        .where(eq(studioBotMessages.toBotId, toBotId))
        .orderBy(desc(studioBotMessages.createdAt))
        .limit(limit);
      return rows as BotMessageRow[];
    },
  };
}

/** Grant studio-lead reachability to a bot id (call on dynamic spawn). */
export async function grantLeadCanMessage(
  database: Database,
  toBotId: string,
  by = "dev-local-user",
): Promise<void> {
  await database
    .insert(pluginGrants)
    .values({
      kind: "bot",
      ref: toBotId,
      agentId: "studio-lead",
      grantedBy: by,
    })
    .onConflictDoUpdate({
      target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
      set: { grantedBy: by, updatedAt: new Date() },
    });
}
