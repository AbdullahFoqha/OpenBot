/**
 * Who may hand work on from somebody else's endpoint, and what a callback already did.
 *
 * Two questions that arrive together on every delegating callback and are answered from the same
 * connection, so they live in one store rather than two that a wiring mistake could give different
 * databases.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentDelegationCapability, callbackOperations } from "../db/schema";

/** What a recorded callback returned, replayed verbatim on a retry. */
export type CallbackResult = { text: string; isError: boolean };

export type DelegationStore = {
  /**
   * May this Bot execute a delegation through the callback?
   *
   * Read per call and never cached, for the reason `handoff.ts` reads its grants per hop: a
   * capability withdrawn a minute ago has to stop the next call rather than the next restart.
   */
  mayDelegateOverCallback: (agentId: string) => Promise<boolean>;
  /** An administrator's declaration that this Bot's adapter implements the contract. */
  declare: (agentId: string, declaredBy: string | null) => Promise<void>;
  /** Withdrawn without deleting the row, so the history of the claim survives it. */
  revoke: (agentId: string) => Promise<void>;
  /**
   * Written by the runtime the first time an adapter really completes a delegation.
   *
   * The declaration is a claim about somebody else's process; this is the only thing in the
   * deployment that turns it into an observation. Best-effort on purpose: failing to record that a
   * hop worked must not undo the hop.
   */
  markVerified: (agentId: string, runId: string) => Promise<void>;
  /** Declared, and whether anything has ever proved it. For the capability report. */
  list: () => Promise<
    {
      agentId: string;
      declaredAt: Date;
      verifiedAt: Date | null;
      verifiedRunId: string | null;
      revokedAt: Date | null;
    }[]
  >;
  /**
   * Claim this operation, or hand back what it returned before.
   *
   * ONE STATEMENT, NOT A READ THEN A WRITE. Two adapters retrying the same call at once — which is
   * what a timeout on a slow hop produces — both read "absent" and both then execute. The insert is
   * the claim: exactly one caller gets `{ fresh: true }` and everybody else is told to wait for, or
   * is handed, the first one's answer.
   */
  claimOperation: (input: {
    operationId: string;
    botId: string;
    actorId: string;
    runId: string;
    toolRef: string;
  }) => Promise<{ fresh: true } | { fresh: false; result: CallbackResult }>;
  /** Fill in what the claimed operation returned. */
  completeOperation: (
    operationId: string,
    result: CallbackResult,
  ) => Promise<void>;
  /** The recorded result, or nothing while it is still running. */
  readOperation: (operationId: string) => Promise<CallbackResult | null>;
};

/**
 * The placeholder a claim writes before the work runs.
 *
 * A row has to exist for the insert to be the claim, and it cannot yet hold an answer. A retry that
 * arrives while the first call is still running is told that plainly rather than handed an empty
 * string, which the model would read as the tool having returned nothing.
 */
const IN_FLIGHT = { text: "", isError: false, pending: true } as const;

const isPending = (value: unknown): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      (value as { pending?: unknown }).pending,
  );

export function createDelegationStore(database: Database): DelegationStore {
  return {
    async mayDelegateOverCallback(agentId) {
      const [row] = await database
        .select({ agentId: agentDelegationCapability.agentId })
        .from(agentDelegationCapability)
        .where(
          and(
            eq(agentDelegationCapability.agentId, agentId),
            isNull(agentDelegationCapability.revokedAt),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async declare(agentId, declaredBy) {
      await database
        .insert(agentDelegationCapability)
        .values({
          agentId,
          declaredBy,
          // Re-declaring after a revocation is a fresh declaration, not a resurrection of the old
          // one: the verification that belonged to the withdrawn claim is cleared with it.
        })
        .onConflictDoUpdate({
          target: agentDelegationCapability.agentId,
          set: {
            declaredBy,
            declaredAt: sql`now()`,
            revokedAt: null,
            verifiedAt: null,
            verifiedRunId: null,
          },
        });
    },

    async revoke(agentId) {
      await database
        .update(agentDelegationCapability)
        .set({ revokedAt: sql`now()` })
        .where(eq(agentDelegationCapability.agentId, agentId));
    },

    async markVerified(agentId, runId) {
      await database
        .update(agentDelegationCapability)
        .set({ verifiedAt: sql`now()`, verifiedRunId: runId })
        .where(
          and(
            eq(agentDelegationCapability.agentId, agentId),
            isNull(agentDelegationCapability.revokedAt),
          ),
        );
    },

    async list() {
      return database
        .select({
          agentId: agentDelegationCapability.agentId,
          declaredAt: agentDelegationCapability.declaredAt,
          verifiedAt: agentDelegationCapability.verifiedAt,
          verifiedRunId: agentDelegationCapability.verifiedRunId,
          revokedAt: agentDelegationCapability.revokedAt,
        })
        .from(agentDelegationCapability);
    },

    async claimOperation(input) {
      const inserted = await database
        .insert(callbackOperations)
        .values({
          operationId: input.operationId,
          botId: input.botId,
          actorId: input.actorId,
          runId: input.runId,
          toolRef: input.toolRef,
          result: IN_FLIGHT,
        })
        .onConflictDoNothing({ target: callbackOperations.operationId })
        .returning({ operationId: callbackOperations.operationId });

      if (inserted.length > 0) return { fresh: true };

      const [existing] = await database
        .select({ result: callbackOperations.result })
        .from(callbackOperations)
        .where(eq(callbackOperations.operationId, input.operationId))
        .limit(1);

      /*
       * Still running, as far as this side can tell.
       *
       * Not an error: the first call may be mid-hop. Said as a sentence the model can act on,
       * because the alternative shapes are both worse — an empty result reads as "the tool returned
       * nothing", and a thrown error ends the run with nothing said.
       */
      if (!existing || isPending(existing.result)) {
        return {
          fresh: false,
          result: {
            text: "That same request is already being handled. Wait for its answer rather than sending it again.",
            isError: false,
          },
        };
      }
      return { fresh: false, result: existing.result as CallbackResult };
    },

    async completeOperation(operationId, result) {
      await database
        .update(callbackOperations)
        .set({ result })
        .where(eq(callbackOperations.operationId, operationId));
    },

    async readOperation(operationId) {
      const [row] = await database
        .select({ result: callbackOperations.result })
        .from(callbackOperations)
        .where(eq(callbackOperations.operationId, operationId))
        .limit(1);
      if (!row || isPending(row.result)) return null;
      return row.result as CallbackResult;
    },
  };
}
