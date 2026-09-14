import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { RunAssertion } from "../src/agents/callback-token";
import { createHandoffDesk, HANDOFF_KIND } from "../src/agents/handoff";
import {
  HANDOFF_TOOL_REF,
  operationIdFor,
  runDelegationCallback,
} from "../src/agents/handoff-callback";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  callbackOperations,
  pluginGrants,
  workItems,
} from "../src/db/schema";
import { createDelegationStore } from "../src/studio/delegation-store";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A Bot at its own endpoint handing work to another, driven against the real database.
 *
 * Everything load-bearing here belongs to Postgres rather than to the code: whether two retries of
 * one callback can both execute, whether a registration withdrawn a moment ago stops the next call,
 * and whether a hop that was decided leaves a durable row for another replica to claim. A fake
 * answers all three the way its author expected, which is the wrong witness for these questions.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const REMOTE = `delegation-remote-${suite}`;
const TARGET = `delegation-target-${suite}`;
const ACTOR = `delegation-actor-${suite}`;

const profiles = createAgentProfileStore(database);
const queue = createWorkQueue(database);
const delegationStore = createDelegationStore(database);
const desk = createHandoffDesk({
  queue,
  profiles,
  actorFor: async (id: string) => ({ id, role: "user" as const }),
  mayAddress: async (fromBotId, toBotId) => {
    const rows = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "bot"), eq(pluginGrants.agentId, fromBotId)),
      );
    return rows.some((row) => row.ref === toBotId);
  },
  auditStore: createAuditStore(database),
  caps: { maxDepth: 2, maxPerRun: 3 },
});

const caps = { maxDepth: 2, maxPerRun: 3 };

const callback = (
  run: RunAssertion,
  args: Record<string, unknown>,
  over: { mayDelegate?: boolean } = {},
) =>
  runDelegationCallback(
    {
      desk,
      mayDelegate: (botId) =>
        over.mayDelegate === undefined
          ? delegationStore.mayDelegateOverCallback(botId)
          : Promise.resolve(over.mayDelegate),
      markVerified: (botId, runId) =>
        delegationStore.markVerified(botId, runId),
      caps,
    },
    { ref: HANDOFF_TOOL_REF, args, run },
  );

const assertion = (over: Partial<RunAssertion> = {}): RunAssertion => ({
  botId: REMOTE,
  actorId: ACTOR,
  runId: `run-${suite}-1`,
  threadId: `thread-${suite}`,
  depth: 0,
  initiator: { kind: "person" },
  ...over,
});

async function clean() {
  /*
   * By what the hop is about rather than by its key.
   *
   * Hop keys are hashed from the run, so `like 'hop:%'` is the only prefix match available and it
   * would take another suite's rows with it. The payload names the Bot, which is this suite's own.
   */
  await database
    .delete(workItems)
    .where(
      and(
        eq(workItems.kind, HANDOFF_KIND),
        sql`${workItems.payload}->>'fromBotId' = ${REMOTE}`,
      ),
    );
  await database
    .delete(callbackOperations)
    .where(like(callbackOperations.runId, `run-${suite}%`));
  /*
   * The audit trail is not cleaned, because it cannot be: a database trigger refuses every delete
   * on `audit_events`, which is the append-only promise the product is built on. Rows this suite
   * writes are named after it and are left behind deliberately.
   */
  /*
   * Every suite's Bots, not only this run's.
   *
   * A previous run that died mid-file leaves an "Engineer" behind, and the desk refuses an
   * ambiguous name outright rather than guessing — correctly, and it made this file fail against a
   * leftover rather than against its own code. Cleaning the family removes that dependency on how
   * the last run ended.
   */
  for (const prefix of ["delegation-remote-%", "delegation-target-%"]) {
    await database
      .delete(pluginGrants)
      .where(like(pluginGrants.agentId, prefix));
    await database
      .delete(agentProfiles)
      .where(like(agentProfiles.agentId, prefix));
    await database.delete(agents).where(like(agents.id, prefix));
  }
}

beforeEach(async () => {
  await clean();
  for (const [id, name, type] of [
    // The asking Bot runs somewhere else: that is the case this whole feature is about.
    [REMOTE, "Remote Researcher", "remote_ag_ui"],
    [TARGET, "Engineer", "built_in"],
  ] as const) {
    await database
      .insert(agents)
      .values({ id, name, type, configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        name,
        title: "",
        roleDescription: "",
        avatarSeed: id,
        visibility: "public",
      })
      .onConflictDoNothing();
  }
  await database
    .insert(pluginGrants)
    .values({ kind: "bot", ref: TARGET, agentId: REMOTE, grantedBy: "test" })
    .onConflictDoNothing();
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

const hopRows = () =>
  database
    .select({ key: workItems.key, payload: workItems.payload })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, HANDOFF_KIND),
        sql`${workItems.payload}->>'fromBotId' = ${REMOTE}`,
      ),
    );

describe("a remote Bot delegating through the signed callback", () => {
  test("registering the endpoint is what turns the refusal into a queued hop", async () => {
    const before = await callback(assertion(), {
      bot: "Engineer",
      task: "add the empty state",
    });
    expect(before?.text).toContain("has not been registered");
    expect(await hopRows()).toHaveLength(0);

    await delegationStore.declare(REMOTE, null);

    const after = await callback(assertion(), {
      bot: "Engineer",
      task: "add the empty state",
    });
    expect(after?.text).toContain("Engineer");
    const rows = await hopRows();
    expect(rows).toHaveLength(1);
    /*
     * The durable row carries what this deployment signed, not what the adapter sent. `depth` is one
     * deeper than the asking run and the thread is the one the assertion named, so the answer has
     * somewhere to land and the chain keeps counting on whichever replica claims this.
     */
    expect(rows[0]?.payload).toMatchObject({
      fromBotId: REMOTE,
      toBotId: TARGET,
      actorId: ACTOR,
      threadId: `thread-${suite}`,
      depth: 1,
    });
  });

  test("a registration withdrawn a moment ago stops the very next call", async () => {
    await delegationStore.declare(REMOTE, null);
    expect(
      (await callback(assertion(), { bot: "Engineer", task: "first" }))?.text,
    ).toContain("Engineer");

    await delegationStore.revoke(REMOTE);

    const after = await callback(assertion({ runId: `run-${suite}-2` }), {
      bot: "Engineer",
      task: "second",
    });
    expect(after?.text).toContain("has not been registered");
    // Read per call, so only the first hop exists.
    expect(await hopRows()).toHaveLength(1);
  });

  test("the endpoint is recorded as verified only once a hop really happened", async () => {
    await delegationStore.declare(REMOTE, null);
    expect(
      (await delegationStore.list()).find((row) => row.agentId === REMOTE)
        ?.verifiedAt,
    ).toBeNull();

    await callback(assertion(), {
      bot: "Engineer",
      task: "add the empty state",
    });

    const row = (await delegationStore.list()).find(
      (entry) => entry.agentId === REMOTE,
    );
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.verifiedRunId).toBe(`run-${suite}-1`);
  });

  test("re-declaring after a withdrawal does not resurrect the old verification", async () => {
    await delegationStore.declare(REMOTE, null);
    await callback(assertion(), { bot: "Engineer", task: "prove it" });
    await delegationStore.revoke(REMOTE);
    await delegationStore.declare(REMOTE, null);

    const row = (await delegationStore.list()).find(
      (entry) => entry.agentId === REMOTE,
    );
    // A new claim about an endpoint that may now be different software. Configured again, not
    // observed again.
    expect(row?.revokedAt).toBeNull();
    expect(row?.verifiedAt).toBeNull();
  });

  test("a Bot it has not been granted is refused, and nothing is queued", async () => {
    await delegationStore.declare(REMOTE, null);
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, REMOTE));

    const result = await callback(assertion(), {
      bot: "Engineer",
      task: "add the empty state",
    });
    expect(result?.text).toContain("not been given");
    expect(await hopRows()).toHaveLength(0);
  });

  test("a run already at the deployment's depth cannot start another chain", async () => {
    await delegationStore.declare(REMOTE, null);
    const result = await callback(assertion({ depth: caps.maxDepth }), {
      bot: "Engineer",
      task: "go deeper",
    });
    expect(result?.text).toContain("as far as this deployment allows");
    expect(await hopRows()).toHaveLength(0);
  });

  test("an assertion with no conversation cannot be used to send anything", async () => {
    await delegationStore.declare(REMOTE, null);
    /*
     * An assertion minted before threads travelled in them still verifies. It must not become a way
     * to address a Bot with nowhere for the answer to go — and, more to the point, it must not be
     * completable from the tool arguments, which is the only other place a thread could come from.
     */
    const noThread = assertion();
    delete (noThread as { threadId?: string }).threadId;
    const result = await callback(noThread, {
      bot: "Engineer",
      task: "add the empty state",
      threadId: `thread-${suite}`,
    });
    expect(result?.text).toContain("not in a conversation");
    expect(await hopRows()).toHaveLength(0);
  });
});

describe("the same callback arriving twice", () => {
  const args = { bot: "Engineer", task: "add the empty state" };
  const operation = () =>
    operationIdFor({
      botId: REMOTE,
      runId: `run-${suite}-1`,
      toolRef: HANDOFF_TOOL_REF,
      args,
    });

  const claim = () =>
    delegationStore.claimOperation({
      operationId: operation(),
      botId: REMOTE,
      actorId: ACTOR,
      runId: `run-${suite}-1`,
      toolRef: HANDOFF_TOOL_REF,
    });

  test("exactly one of two racing retries executes, and the other is told to wait", async () => {
    /*
     * Both at once, because that is what a timeout on a slow hop produces: the adapter gives up on
     * the socket and sends again while the first call is still running. A read-then-write claim
     * passes both.
     */
    const [first, second] = await Promise.all([claim(), claim()]);
    const fresh = [first, second].filter((outcome) => outcome.fresh);
    expect(fresh).toHaveLength(1);
    const waiting = [first, second].find((outcome) => !outcome.fresh);
    expect(waiting && !waiting.fresh ? waiting.result.text : "").toContain(
      "already being handled",
    );
  });

  test("once it has finished, the retry is handed the first call's answer verbatim", async () => {
    await delegationStore.declare(REMOTE, null);
    const first = await claim();
    expect(first.fresh).toBe(true);

    const result = await callback(assertion(), args);
    expect(result).not.toBeNull();
    await delegationStore.completeOperation(operation(), result!);

    const retry = await claim();
    expect(retry.fresh).toBe(false);
    expect(retry.fresh === false && retry.result).toEqual(result!);
    /*
     * And the work happened once. The desk's own key would have caught a second `desk.send` with
     * identical arguments; what this proves is that the second call never got as far as deciding.
     */
    expect(await hopRows()).toHaveLength(1);
  });

  test("a different ask in the same run is still a different operation", async () => {
    await delegationStore.declare(REMOTE, null);
    expect((await claim()).fresh).toBe(true);
    const other = await delegationStore.claimOperation({
      operationId: operationIdFor({
        botId: REMOTE,
        runId: `run-${suite}-1`,
        toolRef: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "something else entirely" },
      }),
      botId: REMOTE,
      actorId: ACTOR,
      runId: `run-${suite}-1`,
      toolRef: HANDOFF_TOOL_REF,
    });
    // A run is allowed to ask for more than one thing. Deduplicating by run alone would break that.
    expect(other.fresh).toBe(true);
  });

  test("an unfinished operation reads as nothing rather than as an empty answer", async () => {
    await claim();
    // Mid-flight. A recorded empty string would reach the model as "the tool returned nothing",
    // which is the false negative this whole record exists to avoid.
    expect(await delegationStore.readOperation(operation())).toBeNull();
  });
});
