import { describe, expect, test } from "bun:test";
import type { RunAssertion } from "../src/agents/callback-token";
import type { HandoffDesk, HandoffOutcome } from "../src/agents/handoff";
import {
  HANDOFF_TOOL_REF,
  operationIdFor,
  runDelegationCallback,
} from "../src/agents/handoff-callback";

/**
 * Handing work on from somebody else's endpoint.
 *
 * The property worth testing here is not that a hop happens — `handoff.ts` already owns that and has
 * its own suite against the real database. It is that NOTHING THE CALLING PROCESS SAYS ABOUT ITSELF
 * IS BELIEVED. A remote adapter composes the arguments; this deployment composes the identity, and
 * the two must never meet. So every test below hands the callback arguments that contradict the
 * signed assertion and checks the assertion won.
 */

const ASSERTION: RunAssertion = {
  botId: "researcher",
  actorId: "person_1",
  runId: "run_1",
  threadId: "thread_1",
  depth: 1,
  initiator: { kind: "person" },
};

/** A desk that records what it was asked rather than doing anything, so the input is the assertion. */
function recordingDesk(
  outcome: HandoffOutcome = {
    ok: true,
    to: "engineer",
    toName: "Engineer",
  },
) {
  const seen: Parameters<HandoffDesk["send"]>[0][] = [];
  const desk: HandoffDesk = {
    send: async (input) => {
      seen.push(input);
      return outcome;
    },
  };
  return { desk, seen };
}

const caps = { maxDepth: 2, maxPerRun: 3 };
const always = async () => true;

describe("a delegating callback", () => {
  test("is not this tool, and says so by declining rather than refusing", async () => {
    const { desk } = recordingDesk();
    expect(
      await runDelegationCallback(
        { desk, mayDelegate: always, caps },
        { ref: "host_run_command", args: {}, run: ASSERTION },
      ),
    ).toBeNull();
  });

  test("takes the Bot, person, run, thread and depth from the assertion, never the arguments", async () => {
    const { desk, seen } = recordingDesk();
    const result = await runDelegationCallback(
      { desk, mayDelegate: always, caps },
      {
        ref: HANDOFF_TOOL_REF,
        args: {
          bot: "Engineer",
          task: "build the thing",
          /*
           * Everything a compromised or merely creative adapter would try. Each one names a field
           * the desk reads, and each one is the difference between a bounded chain and a Bot
           * dropping a turn into somebody else's conversation at depth zero forever.
           */
          botId: "studio-lead",
          actorId: "person_2",
          runId: "run_99",
          threadId: "somebody-elses-thread",
          depth: 0,
          initiator: { kind: "deployment" },
        },
        run: ASSERTION,
      },
    );

    expect(result?.isError).toBe(false);
    expect(seen).toHaveLength(1);
    // Identity is the assertion, whole and unedited.
    expect(seen[0]?.from).toEqual(ASSERTION);
    // And the work is the arguments, which is the half the model is allowed to choose.
    expect(seen[0]?.target).toBe("Engineer");
    expect(seen[0]?.envelope).toEqual({ task: "build the thing" });
  });

  test("an unregistered endpoint is refused before the desk is reached", async () => {
    const { desk, seen } = recordingDesk();
    const result = await runDelegationCallback(
      { desk, mayDelegate: async () => false, caps },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    expect(seen).toHaveLength(0);
    expect(result?.text).toContain("has not been registered");
    // A refusal, not an error: the remote Bot is mid-run with a person waiting and is owed a
    // sentence it can say out loud.
    expect(result?.isError).toBe(false);
  });

  test("a deployment with delegation switched off refuses even a registered endpoint", async () => {
    const { desk, seen } = recordingDesk();
    for (const off of [
      { maxDepth: 0, maxPerRun: 3 },
      { maxDepth: 2, maxPerRun: 0 },
    ]) {
      const result = await runDelegationCallback(
        { desk, mayDelegate: always, caps: off },
        {
          ref: HANDOFF_TOOL_REF,
          args: { bot: "Engineer", task: "build the thing" },
          run: ASSERTION,
        },
      );
      expect(result?.text).toContain(
        "does not let one Bot hand work to another",
      );
    }
    // Neither reached the desk: an adapter holding a stale tool description cannot get past a
    // deployment-level switch by calling back anyway.
    expect(seen).toHaveLength(0);
  });

  test("a Bot holding no studio task cannot spend capacity nobody reserved", async () => {
    const { desk, seen } = recordingDesk();
    const result = await runDelegationCallback(
      { desk, mayDelegate: always, hasReservation: async () => false, caps },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    expect(seen).toHaveLength(0);
    expect(result?.text).toContain("not holding a task");
  });

  test("an unregistered endpoint is told that first, even when it also holds no task", async () => {
    // The two answers differ in kind: one is a configuration problem an administrator fixes, the
    // other is a state that changes by itself. Reporting the second would send somebody looking in
    // the wrong place.
    const { desk } = recordingDesk();
    const result = await runDelegationCallback(
      {
        desk,
        mayDelegate: async () => false,
        hasReservation: async () => false,
        caps,
      },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    expect(result?.text).toContain("has not been registered");
  });

  test("a deployment that has not adopted the board checks the grant and the caps, as it always did", async () => {
    const { desk, seen } = recordingDesk();
    const result = await runDelegationCallback(
      // No `hasReservation` at all.
      { desk, mayDelegate: always, caps },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    expect(seen).toHaveLength(1);
    expect(result?.isError).toBe(false);
  });

  test("a capacity read that fails refuses rather than letting the hop through", async () => {
    const { desk, seen } = recordingDesk();
    const result = await runDelegationCallback(
      {
        desk,
        mayDelegate: always,
        hasReservation: async () => {
          throw new Error("the database blinked");
        },
        caps,
      },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    // Failing closed costs a hop; failing open spends capacity nobody counted.
    expect(seen).toHaveLength(0);
    expect(result?.text).toContain("not holding a task");
  });

  test("arguments that are not a handoff are refused, and nothing is sent", async () => {
    const { desk, seen } = recordingDesk();
    for (const args of [
      {},
      { bot: "Engineer" },
      { task: "build the thing" },
      { bot: 42, task: "build the thing" },
    ] as Record<string, unknown>[]) {
      const result = await runDelegationCallback(
        { desk, mayDelegate: always, caps },
        { ref: HANDOFF_TOOL_REF, args, run: ASSERTION },
      );
      expect(result?.isError).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });

  test("the desk's refusal is passed through as the answer, not swallowed", async () => {
    const { desk } = recordingDesk({
      ok: false,
      refusal: "You have not been given Engineer to hand work to.",
    });
    const result = await runDelegationCallback(
      { desk, mayDelegate: always, caps },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    expect(result).toEqual({
      text: "You have not been given Engineer to hand work to.",
      isError: false,
    });
  });

  test("a hop that really happened is what marks the endpoint verified, and only after the fact", async () => {
    const verified: [string, string][] = [];
    const { desk } = recordingDesk();
    await runDelegationCallback(
      {
        desk,
        mayDelegate: always,
        markVerified: async (botId, runId) => {
          verified.push([botId, runId]);
        },
        caps,
      },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    expect(verified).toEqual([["researcher", "run_1"]]);

    // A refused hop proves nothing about the adapter, so it records nothing.
    verified.length = 0;
    const refusing = recordingDesk({ ok: false, refusal: "no" });
    await runDelegationCallback(
      {
        desk: refusing.desk,
        mayDelegate: always,
        markVerified: async (botId, runId) => {
          verified.push([botId, runId]);
        },
        caps,
      },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    expect(verified).toEqual([]);
  });

  test("failing to record the observation does not undo the hop", async () => {
    const { desk } = recordingDesk();
    const result = await runDelegationCallback(
      {
        desk,
        mayDelegate: always,
        markVerified: async () => {
          throw new Error("the database blinked");
        },
        caps,
      },
      {
        ref: HANDOFF_TOOL_REF,
        args: { bot: "Engineer", task: "build the thing" },
        run: ASSERTION,
      },
    );
    // The hop is queued. Losing the note that it worked must not turn into losing the work.
    expect(result?.isError).toBe(false);
  });
});

describe("the id one callback operation is recorded under", () => {
  const base = {
    botId: "researcher",
    runId: "run_1",
    toolRef: HANDOFF_TOOL_REF,
  };

  test("is the same for the same call sent twice, which is what makes a retry a retry", () => {
    expect(
      operationIdFor({ ...base, args: { bot: "Engineer", task: "go" } }),
    ).toBe(operationIdFor({ ...base, args: { bot: "Engineer", task: "go" } }));
  });

  test("does not depend on the order the arguments were serialised in", () => {
    // Two JSON encodings of one object are one call. An adapter that re-serialises on retry — which
    // is what a retry usually is — must land on the same id or the dedupe is decorative.
    expect(
      operationIdFor({ ...base, args: { bot: "Engineer", task: "go" } }),
    ).toBe(operationIdFor({ ...base, args: { task: "go", bot: "Engineer" } }));
  });

  test("differs for a different ask, a different run, a different Bot and a different tool", () => {
    const original = operationIdFor({
      ...base,
      args: { bot: "Engineer", task: "go" },
    });
    for (const other of [
      operationIdFor({ ...base, args: { bot: "Engineer", task: "stop" } }),
      operationIdFor({
        ...base,
        runId: "run_2",
        args: { bot: "Engineer", task: "go" },
      }),
      operationIdFor({
        ...base,
        botId: "designer",
        args: { bot: "Engineer", task: "go" },
      }),
      operationIdFor({
        ...base,
        toolRef: "host_run_command",
        args: { bot: "Engineer", task: "go" },
      }),
    ]) {
      expect(other).not.toBe(original);
    }
  });

  test("is not guessable from anything the model writes", () => {
    // Every ingredient is either signed by this deployment or the exact arguments. A readable id
    // would let a model collect another run's recorded answer by naming one.
    expect(
      operationIdFor({ ...base, args: { bot: "Engineer", task: "go" } }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
