/**
 * Whether a piece of work may start, decided in Postgres rather than in a prompt.
 *
 * THE RULE THIS EXISTS FOR is "at most three execution tasks at once, across every process". It was
 * written down in role instructions, which is a rule a model is asked to remember while it is busy
 * being asked to do something else. It is now a row it cannot have.
 *
 * WHY A TRANSACTION AND A LOCK RATHER THAN A COUNT. Counting first and inserting second is a cap
 * that holds only while nothing else is admitting: two workers waking together both read two, both
 * see room, and both take the third and fourth slot. That is not a race needing a cluster or
 * unusual timing — it is what "start the ready work" looks like. So the count and the write are one
 * statement inside one transaction, serialised by an advisory lock on the product, which is the
 * smallest thing that makes the count mean anything. `work/queue.ts` solves the same problem for
 * the same reason with `atMost`; this is the same shape one level up.
 *
 * WHOSE CLOCK. The database's, in every comparison. A lease computed as `Date.now() + ms` on a
 * replica ninety seconds behind is expired on arrival and its work is taken out from under it. Every
 * moment named here is named in SQL.
 *
 * WHAT A LOST LEASE DOES NOT DO is free the slot on its own. A worker whose lease expired may be
 * dead, or may be mid-build on a machine that swapped; freeing the slot on a timer is how two
 * workers end up in one worktree. Reclaiming RAISES A FENCE, and every action a worker takes is
 * checked against the fence it was admitted with, so the old holder is stopped by comparison rather
 * than by somebody noticing it is still alive.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { studioReservations, studioTasks } from "../db/schema";
import type { StudioPolicy } from "./policy";

/** What a worker must present on every action, and cannot forge from anything it knows. */
export type ReservationTicket = {
  taskId: string;
  botId: string;
  /** The process that holds it. Chosen by the worker and renewed under. */
  owner: string;
  /** Raised on every reclaim. A stale one is refused. See the module header. */
  fence: number;
  /** Renewal moves this. */
  leaseUntil: Date;
  /** Renewal cannot move this. */
  expiresAt: Date;
};

export type AdmissionOutcome =
  | { ok: true; ticket: ReservationTicket }
  /**
   * Not admitted, and the reason is a sentence rather than a code.
   *
   * `waiting` is the ordinary answer when the studio is full: the task is fine, its turn has not
   * come, and a caller should try again rather than treat it as a failure. Everything else is a
   * decision that will not change by retrying.
   */
  | { ok: false; reason: "waiting" | "refused"; detail: string };

/** How long one lease lasts before it has to be renewed. */
export const DEFAULT_LEASE_MS = 60_000;

export type Admission = {
  /**
   * Take a slot for this task, or say why not.
   *
   * Idempotent for the same owner: a worker that already holds this task's reservation and asks
   * again is renewed rather than refused, because a retried claim is what a restarted worker with a
   * surviving process looks like.
   */
  claim: (input: {
    taskId: string;
    botId: string;
    owner: string;
    leaseMs?: number;
    /** Overrides the policy ceiling downwards only. A caller cannot buy itself more time. */
    wallClockMinutes?: number;
    maxTurns?: number;
  }) => Promise<AdmissionOutcome>;
  /** Still alive. Refused once the hard ceiling passes, which renewal must not move. */
  renew: (
    ticket: ReservationTicket,
    leaseMs?: number,
  ) => Promise<{ ok: true; leaseUntil: Date } | { ok: false; reason: string }>;
  /**
   * May this worker still act?
   *
   * The gate every side effect goes through. Answers no for a fence that has been raised, an owner
   * that is not the holder, a reservation that was suspended or released, and a ceiling that has
   * passed. One function so a new kind of side effect cannot be added without one.
   */
  mayAct: (
    ticket: ReservationTicket,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** One more turn against the assignment's ceiling. Refused at the ceiling. */
  spendTurn: (
    ticket: ReservationTicket,
  ) => Promise<{ ok: true; turns: number } | { ok: false; reason: string }>;
  /** Put the work down deliberately, with what a resume starts from. Frees the slot. */
  suspend: (
    ticket: ReservationTicket,
    checkpoint: Record<string, unknown>,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Finished or cancelled. Frees the slot. */
  release: (ticket: ReservationTicket) => Promise<void>;
  /**
   * Take over a reservation whose lease has gone.
   *
   * Raises the fence first, in the same transaction, so the previous holder's next action is refused
   * before the new one's first action happens. That ordering IS the safety property.
   */
  reclaim: (input: {
    taskId: string;
    owner: string;
    leaseMs?: number;
  }) => Promise<AdmissionOutcome>;
  /** What is running right now, for a report that does not have to be believed. */
  active: () => Promise<
    {
      taskId: string;
      botId: string;
      kind: string;
      state: string;
      owner: string;
      fence: number;
      leaseUntil: Date;
      expiresAt: Date;
      turns: number;
    }[]
  >;
  /**
   * Is this Bot holding live work right now?
   *
   * READ AT DISPATCH, NOT AT OFFER. A Bot is offered `message_bot` because it has a grant, which is
   * a fact about configuration; whether it may spend the studio's capacity is a fact about right
   * now. Checking only at the offer means a Bot admitted an hour ago, whose task has since been
   * suspended or handed to somebody else, can still queue work — and the hop it queues consumes a
   * slot nobody reserved.
   *
   * A suspended or released reservation is not holding work. A lost one is: whatever that worker is
   * doing, it is doing as this Bot, and letting the Bot delegate on top of it is how one lost
   * process becomes two.
   */
  holdsWork: (botId: string) => Promise<boolean>;
  /** True when this Bot already holds a primary (execution) reservation. */
  holdsPrimaryWork: (botId: string) => Promise<boolean>;
  /** True when this Bot is at the background (review) per-bot cap. */
  backgroundSlotsFull: (botId: string) => Promise<boolean>;
  /** Record what a provider said this cost. Unknown stays unknown. */
  recordUsage: (
    ticket: ReservationTicket,
    usage: Record<string, unknown>,
  ) => Promise<void>;
};

/**
 * The lock every admission for one product serialises on.
 *
 * Advisory rather than a row lock on the product, because the thing being protected is a COUNT
 * ACROSS tasks, not a row: locking the product row would work by accident today and stop working
 * the moment something else touched that row for an unrelated reason. Transaction-scoped, so it is
 * released by commit or rollback and a crashed transaction cannot hold it.
 */
const productLock = (productId: string) =>
  sql`select pg_advisory_xact_lock(hashtext(${`studio:admission:${productId}`}))`;

/** The states that occupy a slot. `suspended` and `released` do not; `lost` still does. */
const OCCUPYING = ["held", "lost"] as const;

export function createAdmission(
  database: Database,
  policy: StudioPolicy,
): Admission {
  const ceiling = (wallClockMinutes?: number) =>
    Math.min(
      wallClockMinutes ?? policy.initialPilotWallClockMinutes,
      policy.initialPilotWallClockMinutes,
    );
  const turnCeiling = (maxTurns?: number) =>
    Math.min(
      maxTurns ?? policy.initialPilotMaxAgentTurns,
      policy.initialPilotMaxAgentTurns,
    );

  /**
   * Everything about a reservation that a decision needs, read in one go.
   *
   * `sql` for the freshness comparisons so the database answers "is this lease still good" rather
   * than this process comparing two clocks.
   */
  const ticketState = (taskId: string) =>
    database
      .select({
        taskId: studioReservations.taskId,
        botId: studioReservations.botId,
        owner: studioReservations.claimedBy,
        fence: studioReservations.fence,
        state: studioReservations.state,
        leaseUntil: studioReservations.leaseUntil,
        expiresAt: studioReservations.expiresAt,
        turns: studioReservations.turns,
        maxTurns: studioReservations.maxTurns,
        leaseLive: sql<boolean>`${studioReservations.leaseUntil} > now()`,
        withinCeiling: sql<boolean>`${studioReservations.expiresAt} > now()`,
      })
      .from(studioReservations)
      .where(eq(studioReservations.taskId, taskId))
      .limit(1);

  /**
   * Is this ticket still the one that holds this task?
   *
   * FOUR SEPARATE QUESTIONS, and answering only the easy ones is how a replaced worker keeps
   * working. The fence catches a reservation handed to somebody else; the owner catches a different
   * process presenting a fence it read; the state catches a suspension or release; the ceiling
   * catches a worker that has run long enough. A lease that has merely lapsed is NOT refused here —
   * a worker whose renewal was slow is still the holder until somebody reclaims, and refusing it
   * would make a slow database look like a lost race.
   */
  async function check(
    ticket: ReservationTicket,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [row] = await ticketState(ticket.taskId);
    if (!row)
      return { ok: false, reason: "That reservation no longer exists." };
    if (row.fence !== ticket.fence) {
      return {
        ok: false,
        reason:
          "This task has been handed to another process. Stop: another worker holds it now.",
      };
    }
    if (row.owner !== ticket.owner) {
      return { ok: false, reason: "Another process holds this task." };
    }
    if (row.state === "released") {
      return {
        ok: false,
        reason: "This task's reservation has been released.",
      };
    }
    if (row.state === "suspended") {
      return {
        ok: false,
        reason: "This task was suspended. Resume it before acting on it.",
      };
    }
    if (!row.withinCeiling) {
      return {
        ok: false,
        reason:
          "This assignment has reached its time limit. Checkpoint what you have rather than continuing.",
      };
    }
    return { ok: true };
  }

  return {
    async claim({ taskId, botId, owner, leaseMs, wallClockMinutes, maxTurns }) {
      const minutes = ceiling(wallClockMinutes);
      const turns = turnCeiling(maxTurns);
      const lease = leaseMs ?? DEFAULT_LEASE_MS;

      return database.transaction(async (tx) => {
        const [task] = await tx
          .select({
            id: studioTasks.id,
            productId: studioTasks.productId,
            kind: studioTasks.kind,
            state: studioTasks.state,
            parentTaskId: studioTasks.parentTaskId,
            dependsOn: studioTasks.dependsOn,
          })
          .from(studioTasks)
          .where(eq(studioTasks.id, taskId))
          .limit(1);
        if (!task) {
          return {
            ok: false as const,
            reason: "refused" as const,
            detail: "There is no such task.",
          };
        }

        // Everything below counts rows; from here on, one admission for this product at a time.
        await tx.execute(productLock(task.productId));

        /*
         * Already ours, so this is a renewal rather than a second claim.
         *
         * A worker that restarts and finds its own process still owning the task must be able to
         * carry on. Checked inside the lock so it cannot interleave with somebody reclaiming.
         */
        const [existing] = await tx
          .select({
            owner: studioReservations.claimedBy,
            fence: studioReservations.fence,
            state: studioReservations.state,
            expiresAt: studioReservations.expiresAt,
          })
          .from(studioReservations)
          .where(eq(studioReservations.taskId, taskId))
          .limit(1);

        if (existing && existing.state !== "released") {
          if (existing.owner === owner && existing.state === "held") {
            const [renewed] = await tx
              .update(studioReservations)
              .set({
                leaseUntil: sql`now() + make_interval(secs => ${lease / 1000})`,
                updatedAt: sql`now()`,
              })
              .where(eq(studioReservations.taskId, taskId))
              .returning({
                leaseUntil: studioReservations.leaseUntil,
                expiresAt: studioReservations.expiresAt,
                fence: studioReservations.fence,
              });
            return {
              ok: true as const,
              ticket: {
                taskId,
                botId,
                owner,
                fence: renewed?.fence ?? existing.fence,
                leaseUntil: renewed?.leaseUntil ?? new Date(),
                expiresAt: renewed?.expiresAt ?? existing.expiresAt,
              },
            };
          }
          /*
           * Somebody else has it, or it is suspended.
           *
           * "Waiting" rather than "refused" for a live lease: the task is fine and its holder is
           * working. `reclaim` is the deliberate way to take a lost one, and it is a separate call
           * because taking work away from a process that might still be running should never happen
           * as a side effect of asking for work.
           */
          return {
            ok: false as const,
            reason: "waiting" as const,
            detail:
              existing.state === "suspended"
                ? "This task is suspended. Resume it rather than claiming it."
                : "Another process holds this task.",
          };
        }

        if (task.state !== "ready" && task.state !== "in_progress") {
          return {
            ok: false as const,
            reason: "refused" as const,
            detail: `A task is claimed from Ready, and this one is ${task.state.replace(/_/g, " ")}.`,
          };
        }

        /*
         * Dependencies, before any slot is spent.
         *
         * Integrated, not merely finished: a dependent task starting from a parent that is only "in
         * review" is a stack built on a commit that may still change, which is the failure P5's
         * restack recovery exists to clean up and this is the cheap way not to need it.
         */
        if (task.dependsOn.length > 0) {
          const satisfied = await tx
            .select({ id: studioTasks.id })
            .from(studioTasks)
            .where(
              and(
                inArray(studioTasks.id, task.dependsOn),
                eq(studioTasks.state, "integrated"),
              ),
            );
          if (satisfied.length !== task.dependsOn.length) {
            const done = new Set(satisfied.map((row) => row.id));
            return {
              ok: false as const,
              reason: "waiting" as const,
              detail: `Waiting on ${task.dependsOn.filter((id) => !done.has(id)).join(", ")}.`,
            };
          }
        }

        /*
         * The hierarchy: Lead -> Specialist -> temporary leaf.
         *
         * Walked rather than trusted, because "this is a leaf" is exactly the claim a worker wanting
         * to spawn another would make. The depth is the number of parents above this task.
         */
        if (policy.temporaryWorkersAreLeaves) {
          let depth = 0;
          let cursor = task.parentTaskId;
          while (cursor && depth <= policy.maxDelegationDepth) {
            depth += 1;
            const [parent] = await tx
              .select({ parentTaskId: studioTasks.parentTaskId })
              .from(studioTasks)
              .where(eq(studioTasks.id, cursor))
              .limit(1);
            cursor = parent?.parentTaskId ?? null;
          }
          if (depth > policy.maxDelegationDepth) {
            return {
              ok: false as const,
              reason: "refused" as const,
              detail: `This is ${depth} levels below the task that started it, and this studio allows ${policy.maxDelegationDepth}. A temporary worker cannot hand work on again.`,
            };
          }
        }

        /*
         * The global cap, counted from the rows under the lock.
         *
         * Reviews and children are ordinary rows here and are counted like everything else, which is
         * what `countChildTasksAndReviews` means in practice: the policy field switches whether
         * coordination-kind rows join them, and nothing else gets an exemption by being called
         * something different.
         */
        const countable = policy.countChildTasksAndReviews
          ? ["execution", "review"]
          : ["execution"];
        const [{ used }] = await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(studioReservations)
          .where(
            and(
              inArray(studioReservations.state, [...OCCUPYING]),
              inArray(studioReservations.kind, countable as never),
            ),
          );

        const counts = countable.includes(task.kind);
        if (counts && used >= policy.maxActiveExecutionTasks) {
          return {
            ok: false as const,
            reason: "waiting" as const,
            detail: `This studio runs ${policy.maxActiveExecutionTasks} tasks at once and all ${policy.maxActiveExecutionTasks} are busy.`,
          };
        }

        /*
         * Per-bot slots (P2.2): primary execution stays at most maxPrimary; review/background
         * may run in parallel up to maxBackground — so a Bot can verify while another primary
         * runs elsewhere, or hold two safe background checks, without stealing the global cap's meaning.
         */
        if (counts) {
          if (task.kind === "execution") {
            const [{ mine }] = await tx
              .select({ mine: sql<number>`count(*)::int` })
              .from(studioReservations)
              .where(
                and(
                  eq(studioReservations.botId, botId),
                  inArray(studioReservations.state, [...OCCUPYING]),
                  eq(studioReservations.kind, "execution"),
                ),
              );
            if (mine >= policy.maxPrimaryExecutionTasksPerBot) {
              return {
                ok: false as const,
                reason: "waiting" as const,
                detail: `${botId} already has a primary task in progress (max ${policy.maxPrimaryExecutionTasksPerBot} per Bot).`,
              };
            }
          } else if (task.kind === "review") {
            const maxBg = policy.maxBackgroundExecutionTasksPerBot;
            const [{ mine }] = await tx
              .select({ mine: sql<number>`count(*)::int` })
              .from(studioReservations)
              .where(
                and(
                  eq(studioReservations.botId, botId),
                  inArray(studioReservations.state, [...OCCUPYING]),
                  eq(studioReservations.kind, "review"),
                ),
              );
            if (mine >= maxBg) {
              return {
                ok: false as const,
                reason: "waiting" as const,
                detail: `${botId} already has ${mine} background/review task(s); max ${maxBg} parallel backgrounds per Bot.`,
              };
            }
          }
        }

        const [row] = await tx
          .insert(studioReservations)
          .values({
            taskId,
            botId,
            kind: task.kind,
            claimedBy: owner,
            state: "held",
            leaseUntil: sql`now() + make_interval(secs => ${lease / 1000})`,
            expiresAt: sql`now() + make_interval(mins => ${minutes})`,
            maxTurns: turns,
          })
          .onConflictDoUpdate({
            target: studioReservations.taskId,
            // Only a released row can be taken this way; anything else was answered above. The
            // fence still rises, because the next holder must be distinguishable from the last.
            set: {
              botId,
              kind: task.kind,
              claimedBy: owner,
              state: "held",
              fence: sql`${studioReservations.fence} + 1`,
              leaseUntil: sql`now() + make_interval(secs => ${lease / 1000})`,
              expiresAt: sql`now() + make_interval(mins => ${minutes})`,
              turns: 0,
              maxTurns: turns,
              checkpoint: null,
              updatedAt: sql`now()`,
            },
          })
          .returning({
            fence: studioReservations.fence,
            leaseUntil: studioReservations.leaseUntil,
            expiresAt: studioReservations.expiresAt,
          });

        await tx
          .update(studioTasks)
          .set({
            state: "in_progress",
            ownerBotId: botId,
            updatedAt: sql`now()`,
          })
          .where(eq(studioTasks.id, taskId));

        return {
          ok: true as const,
          ticket: {
            taskId,
            botId,
            owner,
            fence: row?.fence ?? 1,
            leaseUntil: row?.leaseUntil ?? new Date(),
            expiresAt: row?.expiresAt ?? new Date(),
          },
        };
      });
    },

    async renew(ticket, leaseMs = DEFAULT_LEASE_MS) {
      const allowed = await check(ticket);
      if (!allowed.ok) return { ok: false, reason: allowed.reason };
      const [row] = await database
        .update(studioReservations)
        .set({
          leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(studioReservations.taskId, ticket.taskId),
            // The fence again, in the statement itself: between the check above and this update, a
            // reclaim could have landed. The check is for the message; this is for the write.
            eq(studioReservations.fence, ticket.fence),
            eq(studioReservations.claimedBy, ticket.owner),
          ),
        )
        .returning({ leaseUntil: studioReservations.leaseUntil });
      return row
        ? { ok: true, leaseUntil: row.leaseUntil }
        : {
            ok: false,
            reason: "This task has been handed to another process.",
          };
    },

    mayAct: check,

    async spendTurn(ticket) {
      const allowed = await check(ticket);
      if (!allowed.ok) return { ok: false, reason: allowed.reason };
      /*
       * Incremented and checked in one statement, for the reason the global cap is counted under a
       * lock: a worker that reads its count, decides it has room and then writes is a worker whose
       * ceiling is advisory the moment two of its own calls overlap.
       */
      const [row] = await database
        .update(studioReservations)
        .set({
          turns: sql`${studioReservations.turns} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(studioReservations.taskId, ticket.taskId),
            eq(studioReservations.fence, ticket.fence),
            eq(studioReservations.claimedBy, ticket.owner),
            sql`${studioReservations.turns} < ${studioReservations.maxTurns}`,
          ),
        )
        .returning({ turns: studioReservations.turns });
      return row
        ? { ok: true, turns: row.turns }
        : {
            ok: false,
            reason:
              "This assignment has used every turn it was given. Report what you have and what is left.",
          };
    },

    async suspend(ticket, checkpoint) {
      const allowed = await check(ticket);
      if (!allowed.ok) return { ok: false, reason: allowed.reason };
      /*
       * The checkpoint is required by the type, and that is the point.
       *
       * Suspending is the one way a waiting parent gives up its slot, and it is only safe because
       * something durable says where to start again. A suspension with nothing written down is a
       * cancellation that calls itself a pause.
       */
      const [row] = await database
        .update(studioReservations)
        .set({ state: "suspended", checkpoint, updatedAt: sql`now()` })
        .where(
          and(
            eq(studioReservations.taskId, ticket.taskId),
            eq(studioReservations.fence, ticket.fence),
            eq(studioReservations.claimedBy, ticket.owner),
          ),
        )
        .returning({ taskId: studioReservations.taskId });
      return row
        ? { ok: true }
        : {
            ok: false,
            reason: "This task has been handed to another process.",
          };
    },

    async release(ticket) {
      await database
        .update(studioReservations)
        .set({ state: "released", updatedAt: sql`now()` })
        .where(
          and(
            eq(studioReservations.taskId, ticket.taskId),
            eq(studioReservations.fence, ticket.fence),
            eq(studioReservations.claimedBy, ticket.owner),
          ),
        );
    },

    async reclaim({ taskId, owner, leaseMs = DEFAULT_LEASE_MS }) {
      return database.transaction(async (tx) => {
        const [task] = await tx
          .select({ productId: studioTasks.productId, kind: studioTasks.kind })
          .from(studioTasks)
          .where(eq(studioTasks.id, taskId))
          .limit(1);
        if (!task) {
          return {
            ok: false as const,
            reason: "refused" as const,
            detail: "There is no such task.",
          };
        }
        await tx.execute(productLock(task.productId));

        /*
         * Only a reservation whose lease has actually gone, and the comparison is the database's.
         *
         * `for update` on the row as well as the product lock: the product lock serialises
         * admissions, and this also stops a renewal landing between the read and the write. A
         * renewal that slipped through would mean the old holder believes it still holds a
         * reservation whose fence has just been raised — which the fence catches, but catching it
         * late means an action refused rather than never attempted.
         */
        const [row] = await tx
          .update(studioReservations)
          .set({
            claimedBy: owner,
            state: "held",
            fence: sql`${studioReservations.fence} + 1`,
            leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(studioReservations.taskId, taskId),
              inArray(studioReservations.state, [...OCCUPYING]),
              sql`${studioReservations.leaseUntil} <= now()`,
            ),
          )
          .returning({
            botId: studioReservations.botId,
            fence: studioReservations.fence,
            leaseUntil: studioReservations.leaseUntil,
            expiresAt: studioReservations.expiresAt,
          });

        if (!row) {
          return {
            ok: false as const,
            reason: "waiting" as const,
            detail:
              "That reservation is still live. A worker is renewing it, so it is not yours to take.",
          };
        }
        return {
          ok: true as const,
          ticket: {
            taskId,
            botId: row.botId,
            owner,
            fence: row.fence,
            leaseUntil: row.leaseUntil,
            expiresAt: row.expiresAt,
          },
        };
      });
    },

    async active() {
      return database
        .select({
          taskId: studioReservations.taskId,
          botId: studioReservations.botId,
          kind: studioReservations.kind,
          state: studioReservations.state,
          owner: studioReservations.claimedBy,
          fence: studioReservations.fence,
          leaseUntil: studioReservations.leaseUntil,
          expiresAt: studioReservations.expiresAt,
          turns: studioReservations.turns,
        })
        .from(studioReservations)
        .where(inArray(studioReservations.state, [...OCCUPYING]));
    },

    async holdsWork(botId) {
      const [row] = await database
        .select({ taskId: studioReservations.taskId })
        .from(studioReservations)
        .where(
          and(
            eq(studioReservations.botId, botId),
            inArray(studioReservations.state, [...OCCUPYING]),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async holdsPrimaryWork(botId) {
      const [row] = await database
        .select({ taskId: studioReservations.taskId })
        .from(studioReservations)
        .where(
          and(
            eq(studioReservations.botId, botId),
            inArray(studioReservations.state, [...OCCUPYING]),
            eq(studioReservations.kind, "execution"),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async backgroundSlotsFull(botId) {
      const [{ mine }] = await database
        .select({ mine: sql<number>`count(*)::int` })
        .from(studioReservations)
        .where(
          and(
            eq(studioReservations.botId, botId),
            inArray(studioReservations.state, [...OCCUPYING]),
            eq(studioReservations.kind, "review"),
          ),
        );
      return mine >= policy.maxBackgroundExecutionTasksPerBot;
    },

    async recordUsage(ticket, usage) {
      await database
        .update(studioReservations)
        .set({ usage, updatedAt: sql`now()` })
        .where(
          and(
            eq(studioReservations.taskId, ticket.taskId),
            eq(studioReservations.fence, ticket.fence),
          ),
        );
    },
  };
}
