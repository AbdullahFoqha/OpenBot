/**
 * P2.1 — studio-facing routines (Grok routines parity).
 * Wraps the deployment RoutineStore: cron schedules that fire a Bot turn unattended.
 */
import type { AgentActor } from "../agents/profile-types";
import type {
  Routine,
  RoutineStore,
  RoutineSummary,
} from "../routines/store";
import { RoutineNotFoundError, RoutineRefusedError } from "../routines/store";

export type StudioRoutineBus = {
  create: (input: {
    ownerUserId: string;
    agentId: string;
    instruction: string;
    cron: string;
    timezone?: string;
    channelId?: string;
  }) => Promise<
    { ok: true; routine: Routine } | { ok: false; error: string; status: 400 }
  >;
  list: (ownerUserId: string) => Promise<RoutineSummary[]>;
  pause: (
    ownerUserId: string,
    id: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; status: 404 | 400 }>;
  resume: (
    ownerUserId: string,
    id: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; status: 404 | 400 }>;
  remove: (
    ownerUserId: string,
    id: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; status: 404 | 400 }>;
};

type ChannelDirect = {
  // Structural subset of ChannelStore.direct — keep loose so ChannelStore assigns.
  direct: (
    actor: AgentActor,
    agentId: string,
  ) => Promise<{ id: string; threadId?: string }>;
};

export function createStudioRoutineBus(options: {
  routineStore: RoutineStore;
  channelStore: ChannelDirect;
  actorFor: (userId: string) => Promise<AgentActor | null>;
}): StudioRoutineBus {
  const { routineStore, channelStore, actorFor } = options;

  async function resolveChannelId(
    ownerUserId: string,
    agentId: string,
    channelId?: string,
  ): Promise<string | undefined> {
    if (channelId?.trim()) return channelId.trim();
    const actor = await actorFor(ownerUserId);
    if (!actor) return undefined;
    const channel = await channelStore.direct(actor, agentId);
    return channel.id;
  }

  function mapError(err: unknown): { error: string; status: 400 | 404 } {
    if (err instanceof RoutineNotFoundError) {
      return { error: err.message, status: 404 };
    }
    if (err instanceof RoutineRefusedError) {
      return { error: err.message, status: 400 };
    }
    return {
      error: err instanceof Error ? err.message : String(err),
      status: 400,
    };
  }

  return {
    async create(input) {
      try {
        const channelId = await resolveChannelId(
          input.ownerUserId,
          input.agentId,
          input.channelId,
        );
        const routine = await routineStore.create({
          ownerUserId: input.ownerUserId,
          agentId: input.agentId,
          instruction: input.instruction,
          cron: input.cron,
          timezone: input.timezone ?? "America/New_York",
          ...(channelId ? { channelId } : {}),
        });
        return { ok: true, routine };
      } catch (err) {
        const mapped = mapError(err);
        return { ok: false, error: mapped.error, status: 400 };
      }
    },

    list(ownerUserId) {
      return routineStore.listFor(ownerUserId);
    },

    async pause(ownerUserId, id) {
      try {
        await routineStore.setEnabled(ownerUserId, id, false);
        return { ok: true };
      } catch (err) {
        const mapped = mapError(err);
        return { ok: false, ...mapped };
      }
    },

    async resume(ownerUserId, id) {
      try {
        await routineStore.setEnabled(ownerUserId, id, true);
        return { ok: true };
      } catch (err) {
        const mapped = mapError(err);
        return { ok: false, ...mapped };
      }
    },

    async remove(ownerUserId, id) {
      try {
        await routineStore.remove(ownerUserId, id);
        return { ok: true };
      } catch (err) {
        const mapped = mapError(err);
        return { ok: false, ...mapped };
      }
    },
  };
}
