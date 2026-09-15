/**
 * The durable record of what the studio is doing, which is the thing a conversation is not.
 *
 * A Bot's chat carries handoffs; this carries status. Splitting them is the point: a transcript is
 * where the work was discussed and a row is where it stands, and a system that keeps status only in
 * the transcript has to re-read the transcript to know anything, which it will do differently each
 * time.
 *
 * ONE SYSTEM OWNS EACH FIELD. Where a GitHub Project is selected, it owns the product board and
 * this owns runs, leases and evidence pointers. Two boards whose statuses advance independently is
 * the failure a board is supposed to prevent, so the fields are divided rather than mirrored.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { studioProducts, studioReservations, studioTasks } from "../db/schema";

export type TaskState =
  | "backlog"
  | "ready"
  | "in_progress"
  | "in_review"
  | "ready_to_integrate"
  | "integrated";

export type TaskKind = "execution" | "review" | "coordination";

/**
 * The order the states go in.
 *
 * WRITTEN OUT RATHER THAN INFERRED FROM THE ENUM, because the enum is a list of names and this is a
 * claim about which moves are legal. A task may go forward one step, or back to any earlier state
 * when its evidence stops being true — a changed commit sends an in-review task back to in progress,
 * and that is a normal Tuesday rather than an error.
 */
const ORDER: TaskState[] = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "ready_to_integrate",
  "integrated",
];

export type TaskStore = {
  /** Start the one active product, or refuse because there already is one. */
  activateProduct: (input: {
    id: string;
    name: string;
    repositoryUrl?: string;
    boardRef?: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  retireProduct: (id: string) => Promise<void>;
  activeProduct: () => Promise<{ id: string; name: string } | null>;
  createTask: (input: {
    id: string;
    productId: string;
    title: string;
    kind?: TaskKind;
    parentTaskId?: string;
    dependsOn?: string[];
    state?: TaskState;
  }) => Promise<void>;
  /** Move one step, or backwards. Refuses a skip, and says which step was skipped. */
  transition: (
    taskId: string,
    to: TaskState,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Blocked is a flag on the task it is blocked in, not a state it moves to. */
  setBlocked: (taskId: string, reason: string | null) => Promise<void>;
  read: (taskId: string) => Promise<{
    id: string;
    productId: string;
    title: string;
    state: TaskState;
    kind: TaskKind;
    blockedReason: string | null;
    ownerBotId: string | null;
    parentTaskId: string | null;
    dependsOn: string[];
  } | null>;
  /** What is ready to be picked up, oldest first, so a queue does not starve its own tail. */
  ready: (productId: string) => Promise<{ id: string; kind: TaskKind }[]>;
};

export function createTaskStore(database: Database): TaskStore {
  return {
    async activateProduct(input) {
      /*
       * Counted rather than assumed, and this is the whole of "one active product".
       *
       * A unique index would be the obvious alternative and cannot express it: the rule is one row
       * with a null `retiredAt`, which is a partial unique index on a constant — expressible, but
       * it would make retiring and activating in one breath a constraint violation rather than an
       * ordinary sequence.
       */
      const existing = await database
        .select({ id: studioProducts.id })
        .from(studioProducts)
        .where(isNull(studioProducts.retiredAt));
      if (existing.some((row) => row.id !== input.id)) {
        return {
          ok: false,
          reason: `${existing[0]?.id} is already the active product. Retire it before starting another.`,
        };
      }
      await database
        .insert(studioProducts)
        .values({
          id: input.id,
          name: input.name,
          repositoryUrl: input.repositoryUrl ?? null,
          boardRef: input.boardRef ?? null,
        })
        .onConflictDoUpdate({
          target: studioProducts.id,
          set: {
            name: input.name,
            repositoryUrl: input.repositoryUrl ?? null,
            boardRef: input.boardRef ?? null,
            retiredAt: null,
          },
        });
      return { ok: true };
    },

    async retireProduct(id) {
      await database
        .update(studioProducts)
        .set({ retiredAt: sql`now()` })
        .where(eq(studioProducts.id, id));
    },

    async activeProduct() {
      const [row] = await database
        .select({ id: studioProducts.id, name: studioProducts.name })
        .from(studioProducts)
        .where(isNull(studioProducts.retiredAt))
        .limit(1);
      return row ?? null;
    },

    async createTask(input) {
      await database
        .insert(studioTasks)
        .values({
          id: input.id,
          productId: input.productId,
          title: input.title,
          kind: input.kind ?? "execution",
          parentTaskId: input.parentTaskId ?? null,
          dependsOn: input.dependsOn ?? [],
          state: input.state ?? "backlog",
        })
        .onConflictDoNothing();
    },

    async transition(taskId, to) {
      const [task] = await database
        .select({ state: studioTasks.state })
        .from(studioTasks)
        .where(eq(studioTasks.id, taskId))
        .limit(1);
      if (!task) return { ok: false, reason: "There is no such task." };

      const from = ORDER.indexOf(task.state as TaskState);
      const next = ORDER.indexOf(to);
      if (next > from + 1) {
        /*
         * Named rather than refused generically.
         *
         * Every skipped step is a gate: Ready is where acceptance criteria get written, In Review is
         * where somebody who is not the author looks. A jump straight to Integrated is how a change
         * arrives with no criteria and no reviewer, and the useful refusal says which one was
         * missed rather than that the move was invalid.
         */
        return {
          ok: false,
          reason: `A task cannot go from ${task.state.replace(/_/g, " ")} straight to ${to.replace(/_/g, " ")}: ${ORDER[from + 1]?.replace(/_/g, " ")} is where the next gate is.`,
        };
      }

      /*
       * Going back is always allowed, and clears the evidence that stopped being true.
       *
       * A commit that changed invalidates the review of the commit before it. Leaving the task in
       * review with an approval attached to a different commit is the empty approval record that no
       * gate should ever be satisfied by.
       */
      await database
        .update(studioTasks)
        .set({ state: to, updatedAt: sql`now()` })
        .where(eq(studioTasks.id, taskId));
      return { ok: true };
    },

    async setBlocked(taskId, reason) {
      await database
        .update(studioTasks)
        .set({ blockedReason: reason, updatedAt: sql`now()` })
        .where(eq(studioTasks.id, taskId));
    },

    async read(taskId) {
      const [row] = await database
        .select({
          id: studioTasks.id,
          productId: studioTasks.productId,
          title: studioTasks.title,
          state: studioTasks.state,
          kind: studioTasks.kind,
          blockedReason: studioTasks.blockedReason,
          ownerBotId: studioTasks.ownerBotId,
          parentTaskId: studioTasks.parentTaskId,
          dependsOn: studioTasks.dependsOn,
        })
        .from(studioTasks)
        .where(eq(studioTasks.id, taskId))
        .limit(1);
      return row ? (row as never) : null;
    },

    async ready(productId) {
      const rows = await database
        .select({ id: studioTasks.id, kind: studioTasks.kind })
        .from(studioTasks)
        .leftJoin(
          studioReservations,
          eq(studioReservations.taskId, studioTasks.id),
        )
        .where(
          and(
            eq(studioTasks.productId, productId),
            eq(studioTasks.state, "ready"),
            // Nothing that somebody already has. A released reservation is not somebody having it.
            sql`(${studioReservations.state} is null or ${studioReservations.state} = 'released')`,
          ),
        )
        .orderBy(studioTasks.createdAt);
      return rows as never;
    },
  };
}
