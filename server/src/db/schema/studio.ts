/**
 * Product Studio tables: who may delegate over the callback, and what a callback already did.
 *
 * A fork-owned schema file rather than rows added to `coworker.ts`, for the reason that file's own
 * header gives: schema files are split by owner so two changes never land on the same lines. Every
 * table here is new work for this deployment and none of it replaces an upstream one.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A remote Bot an administrator has declared implements the delegation callback contract.
 *
 * WHY A ROW RATHER THAN LIFTING THE REFUSAL FOR EVERYONE. A Bot at somebody else's endpoint is
 * handed tool *descriptions* and calls them back through `/api/agent-tools/call`. Before this
 * deployment's fork, that route executed MCP refs only, so a described `message_bot` was a tool a
 * remote Bot could announce and never invoke — which is exactly why `enablementRefusal` refused to
 * store the grant. The callback now executes a hop, but only an adapter that actually forwards the
 * signed assertion and calls back can use it. An unmodified remote Bot still cannot, and telling
 * its administrator "granted" would be a lie the grant screen cannot detect.
 *
 * So the capability is declared per Bot, deliberately, by an administrator who knows what is at the
 * other end. It is a claim, not proof.
 *
 * `verifiedAt` is the proof, and it is written by the runtime rather than by a person: the first
 * time that Bot's adapter completes a real delegation through the callback, the row records when
 * and under which run. A declared-but-never-verified Bot is visible as exactly that, which is the
 * distinction the setup kit insists on between configured and tested.
 */
export const agentDelegationCapability = pgTable(
  "agent_delegation_capability",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Who declared it. Kept as an id, and the row survives them leaving. */
    declaredBy: text("declared_by").references(() => users.id, {
      onDelete: "set null",
    }),
    declaredAt: timestamp("declared_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When this adapter last actually executed a delegation through the callback. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** The run that proved it, so the claim can be traced to a real exchange. */
    verifiedRunId: text("verified_run_id"),
    /** Taken away without deleting the row, so a revocation is visible rather than absent. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_delegation_capability_revoked_idx").on(table.revokedAt),
  ],
);

/**
 * What one callback tool call already did, so a retry of it does not do it again.
 *
 * WHY THIS EXISTS AT ALL. `/api/agent-tools/call` is an HTTP call made by somebody else's process.
 * A socket that dies after this deployment committed a hop but before the adapter read the response
 * is indistinguishable, from the adapter's side, from a call that never arrived — so a correct
 * adapter retries, and without this the retry queues a second hop. The handoff desk is already
 * idempotent on its own key for the *same* envelope in the same run, and that is a narrower promise
 * than a caller needs: it answers the retry with a refusal sentence ("you have already asked...")
 * rather than with the answer the first call got, which reads to the model as a failure and is the
 * shape that makes a model try something else.
 *
 * So the operation is recorded by its id and its result is replayed verbatim. The id is derived
 * from the signed run and the exact arguments, never from anything the model chooses: a model that
 * picks its own operation id can replay somebody else's result by guessing one.
 *
 * NOT A PROMISE ABOUT THE WORLD. This deduplicates *this deployment's* side of a tool call. An
 * outside effect a tool had before the socket died happened; the record says what this side
 * returned, and nothing here claims an external system was written exactly once.
 */
export const callbackOperations = pgTable(
  "callback_operations",
  {
    /** sha256 of (bot, run, tool ref, canonical arguments). Stable for a retry, unguessable. */
    operationId: text("operation_id").primaryKey(),
    /** Whose call it was, from the verified assertion rather than the body. */
    botId: text("bot_id").notNull(),
    actorId: text("actor_id").notNull(),
    runId: text("run_id").notNull(),
    /** The store-shaped tool ref this operation ran. */
    toolRef: text("tool_ref").notNull(),
    /** Exactly what was returned the first time, replayed on every retry. */
    result: jsonb("result").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("callback_operations_run_idx").on(table.runId, table.botId),
    index("callback_operations_created_idx").on(table.createdAt),
  ],
);
