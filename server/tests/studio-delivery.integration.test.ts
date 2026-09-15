import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  studioAcceptance,
  studioBranches,
  studioProducts,
  studioPullRequests,
  studioReservations,
  studioReviews,
  studioTasks,
} from "../src/db/schema";
import { createDelivery, verifyStack } from "../src/studio/delivery";
import { createGitHubDelivery, type GhRunner } from "../src/studio/github";
import { createTaskStore } from "../src/studio/task-store";
import { testDatabaseUrl } from "./support/database";

/**
 * The gates between "somebody wrote some code" and "it is in the trunk".
 *
 * Each one exists because of a specific way work goes wrong quietly: criteria written after the
 * fact, an approval that was really about the previous commit, an author approving themselves, a
 * second pull request for the same branch after a timeout, and a stacked child whose diff shows its
 * parent's work as its own. None of those produce an error at the time.
 */

const database = createDatabase(testDatabaseUrl(), { max: 3 });

const suite = randomUUID().slice(0, 8);
const PRODUCT = `delivery-product-${suite}`;
const ENGINEER = "react-native-engineer";
const TL = "technical-lead";
const QA = "quality-engineer";

const tasks = createTaskStore(database);
const delivery = createDelivery(database);

const id = (name: string) => `${suite}-${name}`;

async function clean() {
  for (const table of [
    studioReviews,
    studioAcceptance,
    studioPullRequests,
    studioBranches,
    studioReservations,
  ]) {
    await database.delete(table).where(like(table.taskId, `${suite}-%`));
  }
  await database.delete(studioTasks).where(like(studioTasks.id, `${suite}-%`));
  /*
   * Every product, not only this suite's.
   *
   * One active product is a real rule, so a product left behind by anything else — another suite
   * that died mid-file, or an evidence run pointed at this database — makes `activateProduct`
   * refuse and every test here fail against the leftover rather than against its own code. The same
   * lesson the delegation suite learned from a leftover Bot called "Engineer".
   */
  await database.delete(studioProducts);
}

beforeEach(async () => {
  await clean();
  await tasks.activateProduct({ id: PRODUCT, name: "Delivery pilot" });
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

async function task(name: string, state = "backlog" as const) {
  await tasks.createTask({
    id: id(name),
    productId: PRODUCT,
    title: name,
    state,
  });
  return id(name);
}

const READY = {
  criteria: ["The empty state appears when there are no items"],
  requiredReviewers: [TL],
};

describe("becoming Ready, which is where the criteria are written", () => {
  test("a task with no acceptance criteria cannot become Ready", async () => {
    const taskId = await task("no-criteria");
    const outcome = await delivery.makeReady(taskId, {
      ...READY,
      criteria: ["   "],
    });
    /*
     * Without criteria, whatever gets built becomes the definition of what was asked for, and the
     * review that follows cannot fail honestly.
     */
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(
      "definition of what was asked for",
    );
  });

  test("a task with no named reviewer cannot become Ready", async () => {
    const taskId = await task("no-reviewer");
    const outcome = await delivery.makeReady(taskId, {
      ...READY,
      requiredReviewers: [],
    });
    // Deciding who reviews after the work is done is how the author ends up approving themselves.
    expect(outcome.ok).toBe(false);
  });

  test("criteria are frozen, and changing them is a deliberate act rather than an edit", async () => {
    const taskId = await task("frozen");
    expect((await delivery.makeReady(taskId, READY)).ok).toBe(true);
    const second = await delivery.makeReady(taskId, {
      ...READY,
      criteria: ["Something much easier"],
    });
    expect(second.ok).toBe(false);
    // The refusal names the way through, because the legitimate case is common and a gate with no
    // way through is a gate people route around.
    expect(second.ok === false && second.reason).toContain("deliberately");
  });
});

describe("review, which is about a commit and not about a task", () => {
  const COMMIT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
  const NEXT_COMMIT = "ffffffffffffffffffffffffffffffffffffffff";

  async function inReview(name: string) {
    const taskId = await task(name, "backlog");
    await delivery.makeReady(taskId, READY);
    await tasks.transition(taskId, "ready");
    await tasks.transition(taskId, "in_progress");
    return taskId;
  }

  test("an author cannot review their own work", async () => {
    const taskId = await inReview("self-review");
    const outcome = await delivery.recordReview({
      id: `${suite}-r1`,
      taskId,
      commit: COMMIT,
      reviewerId: ENGINEER,
      authorId: ENGINEER,
      verdict: "approved",
    });
    /*
     * Refused at the door rather than filtered at the gate: a stored self-review looks like evidence
     * on every screen that does not know to exclude it, and somebody will write that screen.
     */
    expect(outcome.ok).toBe(false);
    const rows = await delivery.reviewsFor(taskId, COMMIT);
    expect(rows).toHaveLength(0);
  });

  test("a task cannot go into review without a candidate commit", async () => {
    const taskId = await inReview("no-commit");
    const outcome = await delivery.intoReview(taskId, "  ");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(
      "candidate commit",
    );
  });

  test("an approval of an earlier commit does not approve a newer one", async () => {
    const taskId = await inReview("stale-approval");
    await delivery.recordReview({
      id: `${suite}-r2`,
      taskId,
      commit: COMMIT,
      reviewerId: TL,
      authorId: ENGINEER,
      verdict: "approved",
    });
    expect((await delivery.readyToIntegrate(taskId, COMMIT)).ok).toBe(true);

    // The engineer pushes again. The approval that exists is about a tree that is no longer what
    // would be merged.
    const after = await delivery.readyToIntegrate(taskId, NEXT_COMMIT);
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.reason).toContain(
      "not evidence about this one",
    );
  });

  test("a required reviewer who has not looked blocks it, by name", async () => {
    const taskId = await task("missing-reviewer");
    await delivery.makeReady(taskId, {
      ...READY,
      requiredReviewers: [TL, QA],
    });
    await tasks.transition(taskId, "ready");
    await tasks.transition(taskId, "in_progress");
    await delivery.recordReview({
      id: `${suite}-r3`,
      taskId,
      commit: COMMIT,
      reviewerId: TL,
      authorId: ENGINEER,
      verdict: "approved",
    });
    const outcome = await delivery.readyToIntegrate(taskId, COMMIT);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(QA);
  });

  test("a review that found blockers is not an approval", async () => {
    const taskId = await inReview("blockers");
    await delivery.recordReview({
      id: `${suite}-r4`,
      taskId,
      commit: COMMIT,
      reviewerId: TL,
      authorId: ENGINEER,
      verdict: "changes_required",
      findings: { blockers: ["the empty state is not announced to VoiceOver"] },
    });
    expect((await delivery.readyToIntegrate(taskId, COMMIT)).ok).toBe(false);
  });

  test("a task needing native verification is not passed by a code review alone", async () => {
    const taskId = await task("native-gate");
    await delivery.makeReady(taskId, {
      ...READY,
      requiredReviewers: [TL],
      requiresNativeVerification: true,
    });
    await tasks.transition(taskId, "ready");
    await tasks.transition(taskId, "in_progress");
    await delivery.recordReview({
      id: `${suite}-r5`,
      taskId,
      commit: COMMIT,
      reviewerId: TL,
      authorId: ENGINEER,
      verdict: "approved",
    });
    const outcome = await delivery.readyToIntegrate(taskId, COMMIT);
    // An unavailable check is untested, not passed -- and it blocks only the gate it was agreed for.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(
      "untested, not passed",
    );

    await delivery.recordReview({
      id: `${suite}-r6`,
      taskId,
      commit: COMMIT,
      reviewerId: QA,
      authorId: ENGINEER,
      verdict: "approved",
    });
    expect((await delivery.readyToIntegrate(taskId, COMMIT)).ok).toBe(true);
  });

  test("a material design decision waits for a direction to be approved", async () => {
    const taskId = await task("design-gate");
    await delivery.makeReady(taskId, {
      ...READY,
      requiresDesignApproval: true,
    });
    await tasks.transition(taskId, "ready");
    await tasks.transition(taskId, "in_progress");
    expect((await delivery.intoReview(taskId, COMMIT)).ok).toBe(false);
    await delivery.approveDesign(taskId);
    expect((await delivery.intoReview(taskId, COMMIT)).ok).toBe(true);
  });

  test("the integrated commit is built and smoke tested, not the one that was reviewed", async () => {
    const taskId = await inReview("integrate");
    await delivery.recordReview({
      id: `${suite}-r7`,
      taskId,
      commit: COMMIT,
      reviewerId: TL,
      authorId: ENGINEER,
      verdict: "approved",
    });
    await tasks.transition(taskId, "in_review");
    await tasks.transition(taskId, "ready_to_integrate");
    /*
     * A squash merge produces a commit that has never existed and nobody reviewed. "It passed on the
     * branch" is a statement about a different tree.
     */
    const untested = await delivery.integrate(taskId, "0".repeat(40), {
      smokeTested: false,
    });
    expect(untested.ok).toBe(false);
    expect(
      (await delivery.integrate(taskId, "0".repeat(40), { smokeTested: true }))
        .ok,
    ).toBe(true);
  });
});

describe("opening a pull request exactly once", () => {
  const REPO = "AbdullahFoqha/openbot-studio-pilot";

  /** A `gh` that records what it was asked and can be made to fail the way a timeout does. */
  function fakeGh(options: {
    existing?: Record<string, unknown>[];
    createExitCode?: number;
    /** What `pr list` returns after a create, so a timeout can be simulated honestly. */
    afterCreate?: Record<string, unknown>[];
  }) {
    const calls: string[][] = [];
    let created = false;
    const runner: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        const rows = created
          ? (options.afterCreate ?? options.existing ?? [])
          : (options.existing ?? []);
        return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        created = true;
        return {
          exitCode: options.createExitCode ?? 0,
          stdout: "",
          stderr: options.createExitCode
            ? "timed out waiting for response"
            : "",
        };
      }
      if (args[0] === "pr" && args[1] === "edit") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    };
    return { runner, calls };
  }

  const PR = (over: Record<string, unknown> = {}) => ({
    number: 7,
    url: `https://github.com/${REPO}/pull/7`,
    baseRefName: "main",
    headRefName: `studio/${suite}-empty-state`,
    isDraft: true,
    state: "OPEN",
    ...over,
  });

  test("a retry after a timed-out create finds the pull request instead of opening a second", async () => {
    const taskId = await task("pr-timeout");
    /*
     * The exact ambiguous failure: gh exits non-zero, GitHub already accepted the request, and the
     * exit code cannot distinguish that from a refusal. Reported as an error, the retry opens a
     * second pull request and a reviewer approves whichever they found.
     */
    const { runner, calls } = fakeGh({
      createExitCode: 1,
      afterCreate: [PR()],
    });
    const github = createGitHubDelivery(database, runner);
    const outcome = await github.openDraft({
      taskId,
      repository: REPO,
      headBranch: `studio/${suite}-empty-state`,
      baseBranch: "main",
      title: "Empty state",
      body: "task",
      cwd: "/tmp",
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.pull.number).toBe(7);
    // Reconciled, not created again.
    expect(outcome.ok && outcome.created).toBe(false);
    expect(calls.filter((call) => call[1] === "create")).toHaveLength(1);
  });

  test("a second call finds the existing pull request and creates nothing", async () => {
    const taskId = await task("pr-existing");
    const { runner, calls } = fakeGh({ existing: [PR()] });
    const github = createGitHubDelivery(database, runner);
    const outcome = await github.openDraft({
      taskId,
      repository: REPO,
      headBranch: `studio/${suite}-empty-state`,
      baseBranch: "main",
      title: "Empty state",
      body: "task",
    });
    expect(outcome.ok && outcome.created).toBe(false);
    // The search is the correctness step, and it runs before the first attempt too.
    expect(calls.some((call) => call[1] === "create")).toBe(false);
  });

  test("a pull request is opened as a draft against an explicit base", async () => {
    const taskId = await task("pr-new");
    const { runner, calls } = fakeGh({
      afterCreate: [PR({ baseRefName: "studio/parent" })],
    });
    const github = createGitHubDelivery(database, runner);
    const outcome = await github.openDraft({
      taskId,
      repository: REPO,
      headBranch: `studio/${suite}-empty-state`,
      baseBranch: "studio/parent",
      title: "Empty state",
      body: "task",
    });
    expect(outcome.ok && outcome.created).toBe(true);
    const create = calls.find((call) => call[1] === "create") as string[];
    expect(create).toContain("--draft");
    /*
     * The base is explicit every time. A stacked child defaulted to the trunk shows a diff
     * containing its parent's changes as if the child had written them.
     */
    expect(create[create.indexOf("--base") + 1]).toBe("studio/parent");

    const [row] = await database
      .select()
      .from(studioPullRequests)
      .where(eq(studioPullRequests.taskId, taskId));
    expect(row?.number).toBe(7);
    // Cleared, so a later attempt knows nothing is in flight.
    expect(row?.pendingSince).toBeNull();
  });

  test("a closed pull request for the branch still counts as one having been opened", async () => {
    const taskId = await task("pr-closed");
    const { runner, calls } = fakeGh({ existing: [PR({ state: "CLOSED" })] });
    const github = createGitHubDelivery(database, runner);
    await github.openDraft({
      taskId,
      repository: REPO,
      headBranch: `studio/${suite}-empty-state`,
      baseBranch: "main",
      title: "Empty state",
      body: "task",
    });
    expect(calls.some((call) => call[1] === "create")).toBe(false);
  });

  test("a create that fails for real is reported, not recorded as a pull request", async () => {
    const taskId = await task("pr-failed");
    const { runner } = fakeGh({ createExitCode: 1, afterCreate: [] });
    const github = createGitHubDelivery(database, runner);
    const outcome = await github.openDraft({
      taskId,
      repository: REPO,
      headBranch: `studio/${suite}-empty-state`,
      baseBranch: "main",
      title: "Empty state",
      body: "task",
    });
    expect(outcome.ok).toBe(false);
    const [row] = await database
      .select()
      .from(studioPullRequests)
      .where(eq(studioPullRequests.taskId, taskId));
    // The row remembers the attempt so a later retry searches, and records no number it cannot see.
    expect(row?.number).toBeNull();
    expect(row?.pendingSince).not.toBeNull();
  });
});

describe("a stack, after the parent merges", () => {
  test("a squash-merged parent means retargeting is not enough, and it says so", async () => {
    const taskId = await task("child");
    await database.insert(studioPullRequests).values({
      taskId,
      repository: "AbdullahFoqha/openbot-studio-pilot",
      number: 12,
      url: "https://github.com/x/pull/12",
      baseBranch: "studio/parent",
      headBranch: "studio/child",
    });
    await database.insert(studioBranches).values({
      taskId,
      branch: "studio/child",
      baseCommit: "1".repeat(40),
      baseBranch: "studio/parent",
    });

    const github = createGitHubDelivery(database, async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const outcome = await github.retarget({
      taskId,
      repository: "AbdullahFoqha/openbot-studio-pilot",
      newBase: "main",
      mergeStrategy: "squash",
    });
    /*
     * After a squash the parent's commits are not in the trunk under ANY id the child knows, so the
     * child still carries them and its diff shows the parent's work as the child's. Squash is the
     * common default, which is why this is said rather than assumed away.
     */
    expect(outcome.ok && outcome.needsRestack).toBe(true);
    expect(outcome.ok && outcome.reason).toContain("Rebase this branch");

    const [row] = await database
      .select()
      .from(studioPullRequests)
      .where(eq(studioPullRequests.taskId, taskId));
    expect(row?.baseBranch).toBe("main");
  });

  test("an ordinary merge needs no restack, and the checks are still rerun", async () => {
    const taskId = await task("child-merge");
    await database.insert(studioPullRequests).values({
      taskId,
      repository: "r",
      number: 13,
      url: "u",
      baseBranch: "studio/parent",
      headBranch: "studio/child",
    });
    await database.insert(studioBranches).values({
      taskId,
      branch: "studio/child",
      baseCommit: "1".repeat(40),
      baseBranch: "studio/parent",
    });
    const github = createGitHubDelivery(database, async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const outcome = await github.retarget({
      taskId,
      repository: "r",
      newBase: "main",
      mergeStrategy: "merge",
    });
    expect(outcome.ok && outcome.needsRestack).toBe(false);
    expect(outcome.ok && outcome.reason).toContain("Rerun the checks");
  });

  test("ancestry is checked by commit, because a branch name proves nothing", async () => {
    const taskId = await task("ancestry");
    await database.insert(studioBranches).values({
      taskId,
      branch: "studio/child",
      baseCommit: "abc123abc123abc123abc123abc123abc123abcd",
      baseBranch: "studio/parent",
    });
    /*
     * A child branch named after its parent but actually cut from the trunk looks identical in a
     * listing. The difference is whether its pull request's diff contains the parent's changes.
     */
    const rebuiltElsewhere = await verifyStack(
      database,
      taskId,
      async () => false,
    );
    expect(rebuiltElsewhere.ok).toBe(false);
    expect(rebuiltElsewhere.ok === false && rebuiltElsewhere.reason).toContain(
      "diff nobody intended",
    );
    expect((await verifyStack(database, taskId, async () => true)).ok).toBe(
      true,
    );
  });
});
