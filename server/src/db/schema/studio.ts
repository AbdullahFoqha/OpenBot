/**
 * Product Studio tables: who may delegate, what a callback already did, and who is working on what.
 *
 * A fork-owned schema file rather than rows added to `coworker.ts`, for the reason that file's own
 * header gives: schema files are split by owner so two changes never land on the same lines. Every
 * table here is new work for this deployment and none of it replaces an upstream one.
 */
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
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

/**
 * The one product this studio is working on.
 *
 * A TABLE FOR SOMETHING THERE IS ONLY ONE OF, because "one active product" is a rule that has to be
 * enforced rather than remembered, and because the rule is "one ACTIVE", not "one ever". A retired
 * product keeps its tasks, its evidence and its history; it simply stops admitting work. Held in a
 * configuration field instead, switching products would mean either losing the old rows or writing
 * a migration every time somebody changed their mind.
 */
export const studioProducts = pgTable(
  "studio_products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Where the code lives, when it lives anywhere yet. Null during discovery. */
    repositoryUrl: text("repository_url"),
    /**
     * The board that owns status, when the user has selected one.
     *
     * Null means the pilot's local board. Named rather than assumed, because two systems whose
     * statuses advance independently is the failure mode a product board is supposed to prevent.
     */
    boardRef: text("board_ref"),
    activatedAt: createdAt(),
    /** Set when the product stops admitting work. The rule is one active, not one ever. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [index("studio_products_retired_idx").on(table.retiredAt)],
);

export const studioTaskState = pgEnum("studio_task_state", [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "ready_to_integrate",
  "integrated",
]);

/**
 * What counts against the cap, and what does not.
 *
 * `execution` is somebody doing the work. `review` is somebody else checking it, and it counts:
 * a review is a whole agent turn reading a diff and running a build, which is exactly the resource
 * the cap exists to bound, and calling it free is how three tasks becomes six.
 *
 * `coordination` is exempt, and only while it is really coordination. The Studio Lead deciding what
 * happens next is a sentence; the Studio Lead writing code is execution wearing a different hat.
 * The exemption is for the first and the enum is not a way to claim it for the second.
 */
export const studioTaskKind = pgEnum("studio_task_kind", [
  "execution",
  "review",
  "coordination",
]);

export const studioTasks = pgTable(
  "studio_tasks",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => studioProducts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    state: studioTaskState("state").notNull().default("backlog"),
    kind: studioTaskKind("kind").notNull().default("execution"),
    /**
     * Blocked is a FLAG, not a state, and this column is why.
     *
     * A task blocked in review is still in review: it has a candidate commit, a reviewer and
     * evidence, and moving it to a "Blocked" column loses all of that and the place it came from.
     * Null means not blocked; the text is the exact blocker, which is the part a person needs.
     */
    blockedReason: text("blocked_reason"),
    /** Which Bot this belongs to. Null while it is nobody's yet. */
    ownerBotId: text("owner_bot_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    /**
     * The task this one was split out of, for reviews and for a specialist's children.
     *
     * Self-referential and deliberately not cascading: losing a parent must not silently delete the
     * child's evidence. See `parentTaskId` reads in admission.ts, which walk this to enforce the
     * Lead -> Specialist -> temporary leaf hierarchy.
     */
    parentTaskId: text("parent_task_id"),
    /**
     * What has to be integrated before this may be claimed. Task ids, checked at admission.
     *
     * A real array column rather than JSON, because admission queries it: "are all of these
     * integrated" is a join, and a JSON blob would make it a scan and a parse on every claim.
     */
    dependsOn: text("depends_on").array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studio_tasks_product_state_idx").on(table.productId, table.state),
    index("studio_tasks_owner_idx").on(table.ownerBotId),
    index("studio_tasks_parent_idx").on(table.parentTaskId),
  ],
);

export const studioReservationState = pgEnum("studio_reservation_state", [
  /** Somebody is on it right now, and is renewing. */
  "held",
  /**
   * Put down deliberately, with a checkpoint, so the slot is free.
   *
   * THE ONLY WAY A WAITING PARENT RELEASES ITS SLOT. A parent waiting on a child keeps its
   * reservation by default: it has state in memory, a worktree, and a conversation it will resume,
   * and taking its slot away means the work is lost or the parent deadlocks behind its own child.
   * Suspending is the explicit alternative, and it requires the checkpoint that makes resuming real.
   */
  "suspended",
  /** Finished, cancelled, or the lease was lost and the loss has been reconciled. */
  "released",
  /**
   * The lease expired and nobody has established what the old worker is doing.
   *
   * NOT THE SAME AS RELEASED, and this distinction is the whole recovery story. A worker whose
   * lease expired may be dead, or may be mid-`xcodebuild` on a machine that swapped. Freeing the
   * slot on a timer alone is how two workers end up in one worktree. The slot is reclaimable from
   * here, but reclaiming FENCES the old holder first: see `fence`.
   */
  "lost",
]);

export const studioReservations = pgTable(
  "studio_reservations",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => studioTasks.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    /** Copied from the task at admission, so a count never joins to decide what it is counting. */
    kind: studioTaskKind("kind").notNull(),
    state: studioReservationState("state").notNull().default("held"),
    /**
     * Which process holds it. An opaque id the worker chose for itself and renews under.
     *
     * A process, not a replica: two workers on one host are two owners, and a host name would let
     * one renew the other's lease.
     */
    claimedBy: text("claimed_by").notNull(),
    /**
     * The fencing token, raised every time this reservation is handed to somebody.
     *
     * WHAT MAKES "STOP THE OLD WORKER BEFORE A REPLACEMENT ACTS" TRUE RATHER THAN HOPED FOR. A
     * worker presents the fence it was admitted with on every action it takes; a reclaim raises the
     * number, so the previous holder's next action is refused by comparison rather than by anybody
     * noticing it is still alive. Time cannot do this: the old worker's clock is the one thing the
     * new owner cannot trust.
     */
    fence: integer("fence").notNull().default(1),
    /** The database's clock, always. A lease computed on a skewed replica is not a lease. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    /**
     * The hard ceiling, which renewal cannot move.
     *
     * A lease says "still alive"; this says "long enough". Without it a worker stuck in a loop
     * renews forever and the slot never comes back, which is the failure a lease alone always has.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Turns spent, against the assignment's ceiling. Raised by the worker as it goes. */
    turns: integer("turns").notNull().default(0),
    maxTurns: integer("max_turns").notNull(),
    /** What a resume would start from. Required to suspend; that is what makes suspending honest. */
    checkpoint: jsonb("checkpoint"),
    /**
     * What the provider said this cost, when it said anything.
     *
     * Unknown stays null rather than becoming zero. A dashboard that reads a missing number as free
     * is worse than one that says it does not know.
     */
    usage: jsonb("usage"),
    startedAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studio_reservations_state_idx").on(table.state, table.leaseUntil),
    index("studio_reservations_bot_idx").on(table.botId, table.state),
  ],
);

/**
 * The branch and worktree a task owns, for as long as it owns them.
 *
 * DURABLE RESOURCES, NOT SCRATCH SPACE. A worktree holds work nobody has reviewed yet, so the
 * lifecycle that matters is not "created and deleted" but "who has it, and what is in it that would
 * be lost". Cleanup only ever removes what this row says this task created, and only after the
 * process that owned it is confirmed stopped.
 */
export const studioBranches = pgTable(
  "studio_branches",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => studioTasks.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    /**
     * The commit this branch was cut from, recorded rather than inferred.
     *
     * A BRANCH NAME IS NOT PROOF OF ANCESTRY. A child branch named after its parent, or created from
     * whatever HEAD happened to be, looks identical in a listing to one really cut from the parent's
     * tip — and the difference is whether the stacked PR's diff contains the parent's changes. So the
     * commit is written down when the branch is made and checked when the PR is opened.
     */
    baseCommit: text("base_commit").notNull(),
    /** The branch this one is stacked on, when it is stacked. Null for a branch off the trunk. */
    baseBranch: text("base_branch").notNull(),
    /** Absolute path of the worktree, so cleanup removes what was made and nothing else. */
    worktreePath: text("worktree_path"),
    createdAt: createdAt(),
  },
  (table) => [index("studio_branches_base_idx").on(table.baseBranch)],
);

/**
 * A pull request this deployment opened for a task.
 *
 * ONE ROW PER TASK, WRITTEN BEFORE THE CALL AND RECONCILED AFTER IT. Creating a PR is the classic
 * ambiguous failure: the request times out, the PR exists, the retry opens a second one, and now two
 * PRs claim the same work and a reviewer approves whichever they found. So a retry searches for the
 * task's existing PR before it creates anything.
 */
export const studioPullRequests = pgTable(
  "studio_pull_requests",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => studioTasks.id, { onDelete: "cascade" }),
    repository: text("repository").notNull(),
    number: integer("number"),
    url: text("url"),
    /** What the PR was opened against. Changes when a parent merges and the child is retargeted. */
    baseBranch: text("base_branch").notNull(),
    headBranch: text("head_branch").notNull(),
    /** Draft until somebody says otherwise. This deployment never opens a PR ready for review. */
    draft: boolean("draft").notNull().default(true),
    /**
     * Set the moment creation is attempted, cleared when it is confirmed.
     *
     * The window this closes is the one between "the request left" and "the answer came back": a
     * process that dies in it leaves this set, and the next attempt knows to search rather than
     * create.
     */
    pendingSince: timestamp("pending_since", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("studio_pull_requests_repo_idx").on(table.repository)],
);

export const studioReviewVerdict = pgEnum("studio_review_verdict", [
  "approved",
  "changes_required",
  "blocked",
]);

/**
 * One review of one commit.
 *
 * KEYED ON THE COMMIT, WHICH IS THE WHOLE POINT. A review is a statement about a specific build, not
 * about a task: when the author pushes again, every approval of the previous commit stops being
 * evidence about what would be merged. Storing approval on the task loses that, and the gate then
 * passes on the strength of somebody having approved something else.
 *
 * The reviewer is recorded as a real identity for the same reason: an author cannot be the sole
 * approver, and that can only be checked if the trail says who actually looked.
 */
export const studioReviews = pgTable(
  "studio_reviews",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => studioTasks.id, { onDelete: "cascade" }),
    /** The exact commit reviewed. A different one invalidates this row as evidence. */
    commit: text("commit").notNull(),
    /** Which Bot or person reviewed it. Never the author. */
    reviewerId: text("reviewer_id").notNull(),
    /** Who wrote the commit, so the author-approves-own-work check has both halves. */
    authorId: text("author_id").notNull(),
    verdict: studioReviewVerdict("verdict").notNull(),
    /** Blockers and required fixes, kept apart from improvements, which are backlog items. */
    findings: jsonb("findings").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("studio_reviews_task_commit_idx").on(table.taskId, table.commit),
  ],
);

/**
 * What a task has to satisfy before it may move, and the evidence that it did.
 *
 * SEPARATE FROM THE TASK ROW because acceptance criteria are written before implementation and the
 * evidence arrives after it, and a single mutable column would let the second quietly rewrite the
 * first. A criterion that changed after the work was done is not a criterion the work met.
 */
export const studioAcceptance = pgTable("studio_acceptance", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => studioTasks.id, { onDelete: "cascade" }),
  /** Written at Backlog -> Ready. Frozen afterwards; a change is a new Ready transition. */
  criteria: jsonb("criteria").notNull(),
  /** Who must review this, decided before the work rather than found afterwards. */
  requiredReviewers: text("required_reviewers").array().notNull().default([]),
  /** Whether a native run on a real device is a required gate for this task. */
  requiresNativeVerification: boolean("requires_native_verification")
    .notNull()
    .default(false),
  /** Whether a material experience decision needs a design direction approved first. */
  requiresDesignApproval: boolean("requires_design_approval")
    .notNull()
    .default(false),
  designApprovedAt: timestamp("design_approved_at", { withTimezone: true }),
  createdAt: createdAt(),
});
