/**
 * The gates a piece of work passes through, enforced rather than described.
 *
 * Backlog -> Ready -> In Progress -> In Review -> Ready to Integrate -> Integrated. Written down in
 * role instructions, this is a sequence a model is asked to remember. Here it is a set of questions
 * that have to be answerable from rows, which is the difference between a workflow and a habit.
 *
 * THE TWO THAT ACTUALLY DO THE WORK:
 *
 * Ready is where acceptance criteria are written, and they are FROZEN there. Criteria edited after
 * the work is done are not criteria the work met, and a single mutable column would let the second
 * quietly become the first.
 *
 * In Review -> Ready to Integrate needs an independent review OF THE COMMIT THAT WOULD BE MERGED.
 * Approval stored against a task survives a push; approval stored against a commit does not, and
 * that is the whole point. The author cannot be the sole approver, which is only checkable because
 * both halves — who wrote it, who looked — are recorded.
 *
 * BLOCKED IS A FLAG, NOT A STATE. A task blocked in review is still in review: it has a candidate
 * commit, a reviewer and evidence, and moving it to a "Blocked" column loses all of that and the
 * place it came from. Release inclusion is tracked separately again, because shipping is a decision
 * about a release rather than about a task.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  studioAcceptance,
  studioBranches,
  studioReviews,
  studioTasks,
} from "../db/schema";
import type { TaskState } from "./task-store";

export type GateRefusal = { ok: false; reason: string };
export type GateVerdict = { ok: true } | GateRefusal;

export type ReadyDefinition = {
  /** What a person would check to say this is done. Frozen once Ready. */
  criteria: string[];
  /** Who must review it, decided before the work rather than found afterwards. */
  requiredReviewers: string[];
  requiresNativeVerification?: boolean;
  requiresDesignApproval?: boolean;
};

export type Delivery = {
  /**
   * Backlog -> Ready. Refuses without the things Ready is for.
   *
   * A task moved to Ready with no criteria is a task that can never fail review honestly: whatever
   * was built becomes the definition of what was asked for.
   */
  makeReady: (
    taskId: string,
    definition: ReadyDefinition,
  ) => Promise<GateVerdict>;
  /** Record a review of one commit. */
  recordReview: (input: {
    id: string;
    taskId: string;
    commit: string;
    reviewerId: string;
    authorId: string;
    verdict: "approved" | "changes_required" | "blocked";
    findings?: Record<string, unknown>;
  }) => Promise<GateVerdict>;
  /** May this task move to In Review with this commit as the candidate? */
  intoReview: (taskId: string, commit: string) => Promise<GateVerdict>;
  /**
   * May this task move to Ready to Integrate?
   *
   * Asked about ONE COMMIT, always. "Has this task been approved" is not a question with a safe
   * answer.
   */
  readyToIntegrate: (taskId: string, commit: string) => Promise<GateVerdict>;
  /** May this task move to Integrated, with the commit that was actually integrated? */
  integrate: (
    taskId: string,
    integratedCommit: string,
    evidence: { smokeTested: boolean },
  ) => Promise<GateVerdict>;
  /** Approve a design direction, when the task needed one. */
  approveDesign: (taskId: string) => Promise<void>;
  /** The reviews that still count for this commit. */
  reviewsFor: (
    taskId: string,
    commit: string,
  ) => Promise<{ reviewerId: string; authorId: string; verdict: string }[]>;
};

export function createDelivery(database: Database): Delivery {
  const acceptanceFor = async (taskId: string) => {
    const [row] = await database
      .select()
      .from(studioAcceptance)
      .where(eq(studioAcceptance.taskId, taskId))
      .limit(1);
    return row;
  };

  const stateOf = async (taskId: string): Promise<TaskState | null> => {
    const [row] = await database
      .select({ state: studioTasks.state })
      .from(studioTasks)
      .where(eq(studioTasks.id, taskId))
      .limit(1);
    return (row?.state as TaskState) ?? null;
  };

  return {
    async makeReady(taskId, definition) {
      if (definition.criteria.filter((entry) => entry.trim()).length === 0) {
        return {
          ok: false,
          reason:
            "A task cannot become Ready with no acceptance criteria: whatever gets built would become the definition of what was asked for.",
        };
      }
      if (definition.requiredReviewers.length === 0) {
        return {
          ok: false,
          reason:
            "A task cannot become Ready with no required reviewer. Deciding who reviews it after the work is done is how the author ends up approving themselves.",
        };
      }
      const existing = await acceptanceFor(taskId);
      if (existing) {
        /*
         * Frozen, and re-entering Ready is a deliberate act rather than an edit.
         *
         * The refusal names what to do instead, because the legitimate case — the scope genuinely
         * changed — is common, and a gate with no way through is a gate people route around.
         */
        return {
          ok: false,
          reason:
            "This task already has acceptance criteria. Move it back through Ready deliberately if the scope changed; editing them in place would rewrite what the work was judged against.",
        };
      }
      await database.insert(studioAcceptance).values({
        taskId,
        criteria: { items: definition.criteria },
        requiredReviewers: definition.requiredReviewers,
        requiresNativeVerification:
          definition.requiresNativeVerification ?? false,
        requiresDesignApproval: definition.requiresDesignApproval ?? false,
      });
      return { ok: true };
    },

    async recordReview(input) {
      if (input.reviewerId === input.authorId) {
        /*
         * Refused at the door rather than filtered at the gate.
         *
         * A self-review stored and then ignored is a row that looks like evidence on every screen
         * that does not know to exclude it, and somebody will write that screen.
         */
        return {
          ok: false,
          reason:
            "The author of a change cannot review it. An independent reviewer looks at the same commit.",
        };
      }
      await database.insert(studioReviews).values({
        id: input.id,
        taskId: input.taskId,
        commit: input.commit,
        reviewerId: input.reviewerId,
        authorId: input.authorId,
        verdict: input.verdict,
        findings: input.findings ?? {},
      });
      return { ok: true };
    },

    async intoReview(taskId, commit) {
      if (!commit.trim()) {
        return {
          ok: false,
          reason:
            "A task goes into review with a candidate commit. Without one there is nothing for a reviewer to look at, and any approval would be about nothing in particular.",
        };
      }
      const state = await stateOf(taskId);
      if (state !== "in_progress") {
        return {
          ok: false,
          reason: `A task goes into review from In Progress, and this one is ${String(state).replace(/_/g, " ")}.`,
        };
      }
      const acceptance = await acceptanceFor(taskId);
      if (!acceptance) {
        return {
          ok: false,
          reason:
            "This task has no acceptance criteria, so there is nothing for a review to check it against.",
        };
      }
      if (
        acceptance.requiresDesignApproval &&
        acceptance.designApprovedAt === null
      ) {
        return {
          ok: false,
          reason:
            "This task needs a design direction approved before it is reviewed. Approve the direction, or record that the decision is not material after all.",
        };
      }
      return { ok: true };
    },

    async reviewsFor(taskId, commit) {
      return database
        .select({
          reviewerId: studioReviews.reviewerId,
          authorId: studioReviews.authorId,
          verdict: studioReviews.verdict,
        })
        .from(studioReviews)
        .where(
          and(
            eq(studioReviews.taskId, taskId),
            // The commit, always. A review of the previous commit is not evidence about this one.
            eq(studioReviews.commit, commit),
          ),
        )
        .orderBy(desc(studioReviews.createdAt));
    },

    async readyToIntegrate(taskId, commit) {
      const acceptance = await acceptanceFor(taskId);
      if (!acceptance) {
        return { ok: false, reason: "This task has no acceptance criteria." };
      }
      const reviews = await this.reviewsFor(taskId, commit);

      if (reviews.length === 0) {
        /*
         * The sentence names the commit, because the common case is that a review exists and is
         * about the commit before this one — and "no reviews" would send somebody looking for a
         * review nobody wrote rather than for the push that invalidated the one they remember.
         */
        return {
          ok: false,
          reason: `No review of ${commit.slice(0, 12)} exists. A review of an earlier commit is not evidence about this one; if the change was pushed again it needs looking at again.`,
        };
      }
      const blocking = reviews.filter(
        (review) => review.verdict !== "approved",
      );
      if (blocking.length > 0) {
        return {
          ok: false,
          reason: `${blocking.length} review${blocking.length === 1 ? "" : "s"} of ${commit.slice(0, 12)} ${blocking.length === 1 ? "is" : "are"} not an approval. Address the blockers and required fixes, then have it looked at again.`,
        };
      }
      const approvers = new Set(
        reviews
          .filter((r) => r.verdict === "approved")
          .map((r) => r.reviewerId),
      );
      const missing = acceptance.requiredReviewers.filter(
        (reviewer) => !approvers.has(reviewer),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} not reviewed ${commit.slice(0, 12)}, and ${missing.length === 1 ? "was" : "were"} named as required before the work started.`,
        };
      }
      /*
       * Native verification is a REQUIRED GATE ONLY WHERE IT WAS AGREED TO BE ONE.
       *
       * An unavailable check is untested, not passed — and it blocks only the gate it was agreed
       * for. Making every task wait on a device would make the flag meaningless by making everybody
       * turn it off.
       */
      if (acceptance.requiresNativeVerification) {
        const native = reviews.some(
          (review) =>
            review.verdict === "approved" &&
            review.reviewerId.includes("quality"),
        );
        if (!native) {
          return {
            ok: false,
            reason: `This task was agreed to need native verification, and no approval of ${commit.slice(0, 12)} from quality engineering exists. A check that could not be run is untested, not passed.`,
          };
        }
      }
      return { ok: true };
    },

    async integrate(taskId, integratedCommit, evidence) {
      const state = await stateOf(taskId);
      if (state !== "ready_to_integrate") {
        return {
          ok: false,
          reason: `Only a task that is Ready to Integrate can be integrated, and this one is ${String(state).replace(/_/g, " ")}.`,
        };
      }
      if (!evidence.smokeTested) {
        /*
         * The INTEGRATED commit, not the reviewed one.
         *
         * A squash merge produces a commit that has never existed before and that nobody reviewed;
         * a merge into a trunk that moved produces a tree neither side built. "It passed on the
         * branch" is a statement about a different tree.
         */
        return {
          ok: false,
          reason: `The integrated commit ${integratedCommit.slice(0, 12)} has not been built and smoke tested. A merge produces a tree nobody has built before, so passing on the branch is a statement about a different one.`,
        };
      }
      return { ok: true };
    },

    async approveDesign(taskId) {
      await database
        .update(studioAcceptance)
        .set({ designApprovedAt: new Date() })
        .where(eq(studioAcceptance.taskId, taskId));
    },
  };
}

/**
 * Is `child` really descended from `parent`, by commit rather than by name?
 *
 * A BRANCH NAME IS NOT PROOF OF ANCESTRY, and this is where stacked PRs go wrong. A child branch
 * named `feature/b` "on top of" `feature/a`, but actually cut from the trunk, produces a PR whose
 * diff silently includes or excludes the parent's changes depending on which way the drift went.
 * The recorded base commit is what decides it, and the caller supplies the ancestry check because
 * only it can talk to git.
 */
export async function verifyStack(
  database: Database,
  childTaskId: string,
  isAncestor: (commit: string, branch: string) => Promise<boolean>,
): Promise<GateVerdict> {
  const [child] = await database
    .select()
    .from(studioBranches)
    .where(eq(studioBranches.taskId, childTaskId))
    .limit(1);
  if (!child) {
    return { ok: false, reason: "This task has no branch recorded." };
  }
  if (!(await isAncestor(child.baseCommit, child.branch))) {
    return {
      ok: false,
      reason: `${child.branch} does not contain ${child.baseCommit.slice(0, 12)}, which it was recorded as being cut from. It was rebuilt from somewhere else, so its pull request would show a diff nobody intended.`,
    };
  }
  return { ok: true };
}
