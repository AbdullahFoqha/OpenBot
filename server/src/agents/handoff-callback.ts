/**
 * Handing work on from somebody else's endpoint.
 *
 * A Bot that runs its own loop at its own URL is handed tool *descriptions* and calls them back
 * through `/api/agent-tools/call`. Until this existed that route executed MCP refs and host tools
 * only, so `message_bot` was a tool a remote Bot could be told about and never invoke — which is
 * why `enablementRefusal` refused to store the grant at all rather than store a dead one.
 *
 * THIS IS THE EXECUTING HALF, AND IT IS THE SAME ONE. It does not re-implement a hop: it calls the
 * same `HandoffDesk` the built-in path calls, which resolves the roster the asking person can see,
 * reads the grant, applies the depth and fan-out caps, writes the same audit rows and puts the hop
 * on the same durable queue. A second delegation path would be a second set of caps to keep in
 * agreement, and they would not stay in agreement.
 *
 * WHAT THE MODEL SUPPLIES IS THE WORK, NEVER THE IDENTITY. The Bot, the person, the run, the
 * conversation an answer returns to and how deep the chain already is all come from the assertion
 * this deployment signed and the adapter merely carried. A remote process that edits any of them is
 * editing a signature it does not hold. The arguments are parsed with the same schema the in-process
 * tool uses, so the two paths cannot drift in what they accept.
 */
import { createHash } from "node:crypto";
import { HANDED_OVER } from "../../../shared/handoff-markers";
import type { RunAssertion } from "./callback-token";
import type { HandoffDesk } from "./handoff";
import { HANDOFF_TOOL, handoffToolParameters } from "./handoff-tool";

/** The store-shaped ref the callback route resolves for this tool. Matches `handoffTool`'s. */
export const HANDOFF_TOOL_REF = `bot/${HANDOFF_TOOL}`;

export type CallbackResult = { text: string; isError: boolean };

/**
 * The id one callback tool call is recorded under.
 *
 * Derived, never chosen. A model that names its own operation id can replay another run's recorded
 * answer by guessing one, and the guessing is not hard when ids are readable. Every ingredient here
 * is either signed by this deployment or the exact arguments the call carried, so the same call
 * retried lands on the same id and a different call cannot.
 *
 * The arguments are serialised with their keys sorted, because two JSON encodings of one object are
 * the same call and a retry that reorders them is still a retry.
 */
export function operationIdFor(input: {
  botId: string;
  runId: string;
  toolRef: string;
  args: Record<string, unknown>;
  /**
   * The adapter's own id for this call, when it sent one.
   *
   * PREFERRED OVER THE ARGUMENTS WHEN PRESENT, because the arguments answer the wrong question for
   * some tools. Two `computer_scroll` calls with the same `deltaY` in one run are a Bot scrolling
   * twice, and deduplicating them would silently drop half the scrolling. The adapter's call id
   * distinguishes a second call from a second delivery of the first, which is exactly the
   * distinction being made.
   */
  callId?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        input.callId
          ? [input.botId, input.runId, input.toolRef, "call", input.callId]
          : [input.botId, input.runId, input.toolRef, canonical(input.args)],
      ),
    )
    .digest("hex");
}

/**
 * Whether a repeated call to this tool, with no adapter call id, may be answered from the record.
 *
 * TRUE ONLY WHERE AN IDENTICAL REPEAT IS ALREADY A REPEAT. Handing the same work to the same Bot
 * twice in one run is one hop — the handoff desk decided that long before this existed — and a host
 * command is approved by a person per command. A browser action is not like that: a Bot may click
 * the same button or scroll the same page twice in one run and mean it both times, and answering
 * the second from the record would drop work while reporting success.
 *
 * With an adapter call id there is no guessing and this does not apply: a retry and a second call
 * are told apart by the caller, which is the only place that really knows.
 */
export function dedupesByArgumentsAlone(toolRef: string): boolean {
  return toolRef === HANDOFF_TOOL_REF || toolRef.startsWith("host_");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export type DelegationCallbackOptions = {
  desk: HandoffDesk;
  /**
   * Whether this Bot's adapter has been declared to implement this contract.
   *
   * Asked per call rather than at boot. A capability an administrator withdrew has to stop the next
   * call, which is the same promise the grant read makes one layer down.
   */
  mayDelegate: (botId: string) => Promise<boolean>;
  /** Recorded the first time an adapter really completes one. Best-effort; never fails the hop. */
  markVerified?: (botId: string, runId: string) => Promise<void>;
  /**
   * Whether this Bot is holding live studio work, checked HERE rather than at the offer.
   *
   * A grant is a fact about configuration and a reservation is a fact about right now. Checking
   * capacity only when the tool list is built lets a Bot admitted an hour ago — whose task has
   * since been suspended, released or handed to another process — keep queueing hops that consume
   * capacity nobody reserved. The queue would happily run them.
   *
   * Absent means a deployment that has not adopted the studio's task admission, which behaves as
   * every deployment did before it existed: the grant and the caps are the whole check.
   */
  hasReservation?: (botId: string) => Promise<boolean>;
  caps: { maxDepth: number; maxPerRun: number };
};

/**
 * Run one delegating callback, or say why not.
 *
 * Returns null when the ref is not this tool, so the caller can fall through to whatever else
 * serves that name. Everything else is an answer the asking model can say out loud, including every
 * refusal: the remote Bot is mid-run with a person waiting, and a thrown error ends that run with
 * nothing said.
 */
export async function runDelegationCallback(
  options: DelegationCallbackOptions,
  call: { ref: string; args: Record<string, unknown>; run: RunAssertion },
): Promise<CallbackResult | null> {
  if (call.ref !== HANDOFF_TOOL_REF) return null;

  const { desk, mayDelegate, markVerified, caps } = options;

  /*
   * Switched off is refused here as well as at the offer.
   *
   * `handoffTool` declines to offer the tool when either cap is zero, and a remote adapter is handed
   * descriptions rather than the tool itself: an adapter holding a stale description from a run
   * before the deployment turned this off would otherwise reach a desk that had no reason to
   * recheck the deployment-level switch.
   */
  if (caps.maxDepth <= 0 || caps.maxPerRun <= 0) {
    return {
      text: "This deployment does not let one Bot hand work to another.",
      isError: false,
    };
  }

  /*
   * The capability, before the desk and before the grant.
   *
   * An adapter that has not been declared gets a sentence saying so rather than a hop. This is the
   * refusal `enablementRefusal` used to make at the grant screen, moved to where it can be true:
   * the grant may now exist, and whether the endpoint behind it can really call back is a separate
   * fact about somebody else's process.
   */
  if (!(await mayDelegate(call.run.botId))) {
    return {
      text: "This Bot runs at its own endpoint and has not been registered as able to hand work on. An administrator registers that after checking the endpoint calls tools back.",
      isError: false,
    };
  }

  /*
   * Capacity before the desk, after the capability.
   *
   * Ordered this way because the answers differ in kind: "your endpoint is not registered" is a
   * configuration problem an administrator fixes, and "you are not holding work" is a state that
   * changes by itself. Telling a Bot the second when the first is also true would send somebody
   * looking in the wrong place.
   */
  if (options.hasReservation) {
    const holding = await options
      .hasReservation(call.run.botId)
      .catch(() => false);
    if (!holding) {
      return {
        text: "You are not holding a task in this studio right now, so there is no capacity to hand work on with. Ask for the work to be assigned first.",
        isError: false,
      };
    }
  }

  const parsed = handoffToolParameters.safeParse(call.args);
  if (!parsed.success) {
    return {
      text: "That handoff was not sent: name the Bot and say what you are asking it to do.",
      isError: true,
    };
  }

  /*
   * `from` IS THE ASSERTION, WHOLE AND UNEDITED.
   *
   * Not a value rebuilt from parts, and not spread over with anything from `call.args`. The desk
   * takes the Bot, the person, the run, the thread an answer returns to and the depth from this one
   * object, so the single place a caller could lie is a signature it does not hold. An assertion
   * minted before threads travelled in them carries no `threadId`, and the desk refuses that as
   * having nowhere for an answer to land — which is the correct reading of an old assertion and the
   * reason it is not quietly filled in from anywhere else.
   */
  const outcome = await desk.send({
    from: call.run,
    target: parsed.data.bot,
    envelope: {
      task: parsed.data.task,
      ...(parsed.data.constraints
        ? { constraints: parsed.data.constraints }
        : {}),
      ...(parsed.data.expecting ? { expecting: parsed.data.expecting } : {}),
    },
  });

  if (!outcome.ok) return { text: outcome.refusal, isError: false };

  // The claim was about somebody else's process; this is the observation. After the hop, so a
  // failure to record it cannot be a reason the hop did not happen.
  await markVerified?.(call.run.botId, call.run.runId).catch(() => {});

  return {
    text: `${HANDED_OVER}${outcome.toName}. Its answer will be relayed back into this conversation when it finishes, so tell the person you have asked it and what for, and do not answer on its behalf.`,
    isError: false,
  };
}
