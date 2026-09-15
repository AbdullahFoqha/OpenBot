import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  studioProducts,
  studioReservations,
  studioTasks,
} from "../src/db/schema";
import { createAdmission, DEFAULT_LEASE_MS } from "../src/studio/admission";
import { DEFAULT_STUDIO_POLICY } from "../src/studio/policy";
import { createTaskStore } from "../src/studio/task-store";
import { testDatabaseUrl } from "./support/database";

/**
 * Whether the studio's capacity rule is a rule.
 *
 * Every property here is Postgres's rather than this code's, which is why none of it is tested with
 * a fake: whether two transactions counting the same rows can both pass a cap, whether a lease
 * comparison uses one clock, and whether raising a fence stops a worker that is still running. A
 * fake answers all three the way its author hoped.
 *
 * The connection pool is deliberately larger than the suite's default: several of these tests open
 * concurrent transactions ON PURPOSE, and with two connections they would serialise on the pool and
 * pass without ever testing the thing they exist to test.
 */

const database = createDatabase(testDatabaseUrl(), { max: 8 });

const suite = randomUUID().slice(0, 8);
const PRODUCT = `studio-product-${suite}`;
const BOT_A = `studio-bot-a-${suite}`;
const BOT_B = `studio-bot-b-${suite}`;
const BOT_C = `studio-bot-c-${suite}`;
const BOT_D = `studio-bot-d-${suite}`;

const tasks = createTaskStore(database);
const policy = { ...DEFAULT_STUDIO_POLICY };
const admission = createAdmission(database, policy);

const task = (name: string) => `${suite}-${name}`;

async function clean() {
  await database
    .delete(studioReservations)
    .where(sql`${studioReservations.taskId} like ${`${suite}-%`}`);
  await database.delete(studioTasks).where(like(studioTasks.id, `${suite}-%`));
  // Every product, for the reason the delivery suite gives: one active product is a real rule, so a
  // leftover from anything else makes this file fail against the leftover rather than its own code.
  await database.delete(studioProducts);
  await database.delete(agents).where(like(agents.id, "studio-bot-%"));
}

beforeEach(async () => {
  await clean();
  for (const id of [BOT_A, BOT_B, BOT_C, BOT_D]) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "built_in", configuration: {} })
      .onConflictDoNothing();
  }
  await tasks.activateProduct({ id: PRODUCT, name: "Pilot" });
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

async function ready(
  name: string,
  over: {
    kind?: "execution" | "review" | "coordination";
    parentTaskId?: string;
    dependsOn?: string[];
  } = {},
) {
  await tasks.createTask({
    id: task(name),
    productId: PRODUCT,
    title: name,
    state: "ready",
    ...over,
  });
  return task(name);
}

describe("how many things run at once", () => {
  test("four eligible tasks claimed at once by four processes admit exactly three", async () => {
    const ids = await Promise.all(
      ["one", "two", "three", "four"].map((name) => ready(name)),
    );
    const bots = [BOT_A, BOT_B, BOT_C, BOT_D];

    /*
     * All four at once, which is the case a count-then-insert cap fails.
     *
     * Each of these is a separate transaction on a separate connection, so without the advisory
     * lock every one of them reads a count taken before any of the others had written and all four
     * pass a cap of three.
     */
    const outcomes = await Promise.all(
      ids.map((id, index) =>
        admission.claim({
          taskId: id,
          botId: bots[index] as string,
          owner: `process-${index}`,
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(3);
    const refused = outcomes.filter((outcome) => !outcome.ok);
    expect(refused).toHaveLength(1);
    // Waiting, not refused: the fourth task is fine and its turn has not come.
    expect(refused[0]?.ok === false && refused[0].reason).toBe("waiting");
    expect(await admission.active()).toHaveLength(3);
  });

  test("the fourth gets in as soon as one of the three finishes", async () => {
    const ids = await Promise.all(
      ["one", "two", "three", "four"].map((name) => ready(name)),
    );
    const bots = [BOT_A, BOT_B, BOT_C, BOT_D];
    const held = [];
    for (let index = 0; index < 3; index += 1) {
      const outcome = await admission.claim({
        taskId: ids[index] as string,
        botId: bots[index] as string,
        owner: `process-${index}`,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) held.push(outcome.ticket);
    }
    expect(
      (
        await admission.claim({
          taskId: ids[3] as string,
          botId: BOT_D,
          owner: "process-3",
        })
      ).ok,
    ).toBe(false);

    await admission.release(held[0]!);

    expect(
      (
        await admission.claim({
          taskId: ids[3] as string,
          botId: BOT_D,
          owner: "process-3",
        })
      ).ok,
    ).toBe(true);
  });

  test("a review is a task like any other and cannot slip past the cap", async () => {
    const work = await Promise.all(
      ["one", "two", "three"].map((n) => ready(n)),
    );
    const bots = [BOT_A, BOT_B, BOT_C];
    for (let index = 0; index < 3; index += 1) {
      expect(
        (
          await admission.claim({
            taskId: work[index] as string,
            botId: bots[index] as string,
            owner: `process-${index}`,
          })
        ).ok,
      ).toBe(true);
    }
    // Calling the fourth thing a review does not make it free. Three agent turns is three agent
    // turns, and the whole reason the cap exists is what they cost.
    const review = await ready("review", { kind: "review" });
    const outcome = await admission.claim({
      taskId: review,
      botId: BOT_D,
      owner: "process-3",
    });
    expect(outcome.ok).toBe(false);
  });

  test("coordination is exempt, which is the only exemption there is", async () => {
    const work = await Promise.all(
      ["one", "two", "three"].map((n) => ready(n)),
    );
    const bots = [BOT_A, BOT_B, BOT_C];
    for (let index = 0; index < 3; index += 1) {
      await admission.claim({
        taskId: work[index] as string,
        botId: bots[index] as string,
        owner: `process-${index}`,
      });
    }
    const coordinating = await ready("lead", { kind: "coordination" });
    expect(
      (
        await admission.claim({
          taskId: coordinating,
          botId: BOT_D,
          owner: "process-3",
        })
      ).ok,
    ).toBe(true);
    // And it does not consume a slot, so the studio is still running three pieces of work.
    expect(
      (await admission.active()).filter((row) => row.kind !== "coordination"),
    ).toHaveLength(3);
  });

  test("one Bot cannot hold two pieces of work at once", async () => {
    const first = await ready("first");
    const second = await ready("second");
    expect(
      (await admission.claim({ taskId: first, botId: BOT_A, owner: "p1" })).ok,
    ).toBe(true);
    const outcome = await admission.claim({
      taskId: second,
      botId: BOT_A,
      owner: "p2",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.detail).toContain(
      "already has a task in progress",
    );
  });

  test("two processes racing to give ONE Bot two tasks still leaves it with one", async () => {
    const [first, second] = await Promise.all([
      ready("first"),
      ready("second"),
    ]);
    const outcomes = await Promise.all([
      admission.claim({ taskId: first, botId: BOT_A, owner: "p1" }),
      admission.claim({ taskId: second, botId: BOT_A, owner: "p2" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  });
});

describe("the shape of the hierarchy", () => {
  test("a temporary leaf cannot be given work below itself", async () => {
    const lead = await ready("lead-task");
    const specialist = await ready("specialist", { parentTaskId: lead });
    const leaf = await ready("leaf", { parentTaskId: specialist });
    // Lead -> Specialist -> leaf is the whole allowance, so this is one level too many.
    const tooDeep = await ready("too-deep", { parentTaskId: leaf });

    expect(
      (await admission.claim({ taskId: leaf, botId: BOT_A, owner: "p1" })).ok,
    ).toBe(true);
    const outcome = await admission.claim({
      taskId: tooDeep,
      botId: BOT_B,
      owner: "p2",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("refused");
  });

  test("the depth refusal survives being retried, because it is walked not counted once", async () => {
    const lead = await ready("lead-task");
    const specialist = await ready("specialist", { parentTaskId: lead });
    const leaf = await ready("leaf", { parentTaskId: specialist });
    const tooDeep = await ready("too-deep", { parentTaskId: leaf });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (await admission.claim({ taskId: tooDeep, botId: BOT_B, owner: "p2" }))
          .ok,
      ).toBe(false);
    }
  });
});

describe("dependencies", () => {
  test("a task waits until everything it depends on is integrated, not merely finished", async () => {
    const parent = await ready("parent");
    const child = await ready("child", { dependsOn: [parent] });

    const blocked = await admission.claim({
      taskId: child,
      botId: BOT_B,
      owner: "p2",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.detail).toContain(parent);

    // In review is not integrated. A stack built on a commit that may still change is the thing
    // restack recovery exists to clean up.
    await tasks.transition(parent, "in_progress");
    await tasks.transition(parent, "in_review");
    expect(
      (await admission.claim({ taskId: child, botId: BOT_B, owner: "p2" })).ok,
    ).toBe(false);

    await tasks.transition(parent, "ready_to_integrate");
    await tasks.transition(parent, "integrated");
    expect(
      (await admission.claim({ taskId: child, botId: BOT_B, owner: "p2" })).ok,
    ).toBe(true);
  });
});

describe("stopping, losing and taking over", () => {
  test("a live reservation cannot be taken, however much somebody wants it", async () => {
    const id = await ready("live");
    const claimed = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
    });
    expect(claimed.ok).toBe(true);

    const stolen = await admission.reclaim({ taskId: id, owner: "p2" });
    expect(stolen.ok).toBe(false);
    expect(stolen.ok === false && stolen.detail).toContain("still live");
    // And the original holder is untouched.
    expect(
      (await admission.mayAct((claimed as { ticket: never }).ticket)).ok,
    ).toBe(true);
  });

  test("taking over a lost reservation stops the old worker before the new one acts", async () => {
    const id = await ready("lost");
    const claimed = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
    });
    expect(claimed.ok).toBe(true);
    const old = claimed.ok ? claimed.ticket : null;

    // The lease expires. Expressed in the database's clock, because the whole failure this guards
    // against is two processes disagreeing about what time it is.
    await database
      .update(studioReservations)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(studioReservations.taskId, id));

    const taken = await admission.reclaim({ taskId: id, owner: "p2" });
    expect(taken.ok).toBe(true);

    /*
     * THE PROPERTY THIS FILE EXISTS FOR.
     *
     * The old worker may still be running — mid-build, mid-browse, mid-anything. It is not stopped
     * by being noticed; it is stopped because the fence it holds is no longer the fence on the row,
     * and every side effect goes through this gate.
     */
    const refused = await admission.mayAct(old!);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain(
      "another worker holds it now",
    );
    expect((await admission.renew(old!)).ok).toBe(false);
    expect((await admission.spendTurn(old!)).ok).toBe(false);
    expect((await admission.suspend(old!, { where: "half way" })).ok).toBe(
      false,
    );

    // And the new holder can.
    expect(
      (await admission.mayAct((taken as { ticket: never }).ticket)).ok,
    ).toBe(true);
  });

  test("a released reservation does not free a slot the old worker can still spend", async () => {
    const id = await ready("released");
    const claimed = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
    });
    const ticket = claimed.ok ? claimed.ticket : null;
    await admission.release(ticket!);
    expect((await admission.mayAct(ticket!)).ok).toBe(false);
    expect(await admission.active()).toHaveLength(0);
  });

  test("a restarted worker that still owns its task carries on rather than queueing behind itself", async () => {
    const id = await ready("restart");
    const first = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
    });
    expect(first.ok).toBe(true);
    // The same process asking again. This is what a worker that lost its in-memory ticket looks
    // like, and answering "somebody else has it" would deadlock it against itself.
    const again = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
    });
    expect(again.ok).toBe(true);
    expect(again.ok && again.ticket.fence).toBe(
      first.ok ? first.ticket.fence : -1,
    );
  });
});

describe("suspending, which is the only way a waiting parent gives up its slot", () => {
  test("suspending frees the slot and keeps the checkpoint", async () => {
    const work = await Promise.all(
      ["one", "two", "three"].map((n) => ready(n)),
    );
    const bots = [BOT_A, BOT_B, BOT_C];
    const tickets = [];
    for (let index = 0; index < 3; index += 1) {
      const outcome = await admission.claim({
        taskId: work[index] as string,
        botId: bots[index] as string,
        owner: `p${index}`,
      });
      if (outcome.ok) tickets.push(outcome.ticket);
    }
    const fourth = await ready("fourth");
    expect(
      (await admission.claim({ taskId: fourth, botId: BOT_D, owner: "p3" })).ok,
    ).toBe(false);

    expect(
      (await admission.suspend(tickets[0]!, { resumeFrom: "review notes" })).ok,
    ).toBe(true);

    expect(
      (await admission.claim({ taskId: fourth, botId: BOT_D, owner: "p3" })).ok,
    ).toBe(true);

    const [row] = await database
      .select({ checkpoint: studioReservations.checkpoint })
      .from(studioReservations)
      .where(eq(studioReservations.taskId, tickets[0]!.taskId));
    // Suspending without somewhere to start again is a cancellation calling itself a pause.
    expect(row?.checkpoint).toEqual({ resumeFrom: "review notes" });
  });

  test("a suspended worker may not keep acting", async () => {
    const id = await ready("suspended");
    const claimed = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
    });
    const ticket = claimed.ok ? claimed.ticket : null;
    await admission.suspend(ticket!, { resumeFrom: "here" });
    expect((await admission.mayAct(ticket!)).ok).toBe(false);
  });
});

describe("budgets a renewal cannot move", () => {
  test("turns run out, and the ceiling is not advisory when two calls overlap", async () => {
    const bounded = createAdmission(database, {
      ...DEFAULT_STUDIO_POLICY,
      initialPilotMaxAgentTurns: 3,
    });
    const id = await ready("turns");
    const claimed = await bounded.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
    });
    const ticket = claimed.ok ? claimed.ticket : null;

    // Six at once against a ceiling of three. Read-then-write would let all six through.
    const spent = await Promise.all(
      Array.from({ length: 6 }, () => bounded.spendTurn(ticket!)),
    );
    expect(spent.filter((outcome) => outcome.ok)).toHaveLength(3);
    expect(
      spent.find((outcome) => !outcome.ok)?.ok === false &&
        (spent.find((outcome) => !outcome.ok) as { reason: string }).reason,
    ).toContain("every turn it was given");
  });

  test("the wall clock is hard: renewing does not extend it", async () => {
    const id = await ready("clock");
    const claimed = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
      leaseMs: DEFAULT_LEASE_MS,
    });
    const ticket = claimed.ok ? claimed.ticket : null;
    expect((await admission.renew(ticket!)).ok).toBe(true);

    // The assignment's hard ceiling passes while its lease is perfectly healthy. A lease says
    // "still alive"; only this says "long enough".
    await database
      .update(studioReservations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(studioReservations.taskId, id));

    const acted = await admission.mayAct(ticket!);
    expect(acted.ok).toBe(false);
    expect(acted.ok === false && acted.reason).toContain("time limit");
    expect((await admission.renew(ticket!)).ok).toBe(false);
  });

  test("a caller cannot ask for more budget than the policy allows", async () => {
    const id = await ready("greedy");
    const claimed = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
      wallClockMinutes: 10_000,
      maxTurns: 10_000,
    });
    expect(claimed.ok).toBe(true);
    const [row] = await database
      .select({
        maxTurns: studioReservations.maxTurns,
        withinPolicy: sql<boolean>`${studioReservations.expiresAt} <= now() + make_interval(mins => ${DEFAULT_STUDIO_POLICY.initialPilotWallClockMinutes})`,
      })
      .from(studioReservations)
      .where(eq(studioReservations.taskId, id));
    expect(row?.maxTurns).toBe(DEFAULT_STUDIO_POLICY.initialPilotMaxAgentTurns);
    expect(row?.withinPolicy).toBe(true);
  });

  test("usage that the provider did not report stays unknown rather than becoming zero", async () => {
    const id = await ready("usage");
    const claimed = await admission.claim({
      taskId: id,
      botId: BOT_A,
      owner: "p1",
    });
    const [before] = await database
      .select({ usage: studioReservations.usage })
      .from(studioReservations)
      .where(eq(studioReservations.taskId, id));
    // A dashboard that reads a missing number as free is worse than one that says it does not know.
    expect(before?.usage).toBeNull();

    await admission.recordUsage(claimed.ok ? claimed.ticket : (null as never), {
      inputTokens: 1200,
      costUsd: null,
    });
    const [after] = await database
      .select({ usage: studioReservations.usage })
      .from(studioReservations)
      .where(eq(studioReservations.taskId, id));
    expect(after?.usage).toEqual({ inputTokens: 1200, costUsd: null });
  });
});

describe("what may be claimed at all", () => {
  test("a task that is not Ready is refused, and says which gate it is behind", async () => {
    await tasks.createTask({
      id: task("backlog"),
      productId: PRODUCT,
      title: "not ready",
    });
    const outcome = await admission.claim({
      taskId: task("backlog"),
      botId: BOT_A,
      owner: "p1",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.detail).toContain("backlog");
  });

  test("a task that does not exist is refused rather than created", async () => {
    const outcome = await admission.claim({
      taskId: task("ghost"),
      botId: BOT_A,
      owner: "p1",
    });
    expect(outcome.ok === false && outcome.reason).toBe("refused");
  });
});
