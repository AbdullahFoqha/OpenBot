/**
 * How this adapter runs a tool that belongs to the deployment rather than to the agent.
 *
 * THE ADAPTER IS THE ONLY THING THAT MAY DO THIS, and it does it by carrying credentials the model
 * never sees. Two of them, doing different jobs: the agent token says which registered Bot is
 * calling, and the run assertion — signed by the deployment, arriving in `forwardedProps.openbotRun`
 * — says which Bot, which person, which conversation and how deep the chain already is. The second
 * is the one that makes a delegating call safe, and it is handed back exactly as received. Editing
 * it, rebuilding it from parts, or filling in a field it does not carry are all the same mistake.
 *
 * WHAT THE MODEL CHOOSES IS THE WORK. The tool name and its arguments come from the agent; every
 * question about identity is answered by the assertion. A model that names another Bot, another
 * person or a different depth is naming fields that are not read.
 *
 * A TOOL CALL ID TRAVELS WITH IT, because the deployment deduplicates retries and cannot otherwise
 * tell a second scroll from a second delivery of the first. It is the agent's own id for the call,
 * and it decides nothing else.
 */

export type CallbackClient = {
  call: (input: {
    name: string;
    args: Record<string, unknown>;
    /** The agent's own id for this tool call. Used only to tell a retry from a repeat. */
    toolCallId?: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string; isError: boolean }>;
};

export type CallbackOptions = {
  /** Where the deployment's callback lives, e.g. https://openbot.internal/api/agent-tools/call */
  url: string;
  /** This agent's own token, issued to it by the deployment. Never logged, never in a prompt. */
  agentToken: string;
  /**
   * The run assertion, exactly as it arrived in `forwardedProps.openbotRun`.
   *
   * Opaque here on purpose. This adapter does not parse it, does not validate it and cannot mint
   * one: it is the deployment's statement about the run, and the only correct thing to do with it is
   * hand it back unchanged.
   */
  runAssertion: string;
  fetchImpl?: typeof fetch;
  /** How long one tool call may take. A hop is queued quickly; a browser action is not instant. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;

export function createCallbackClient(options: CallbackOptions): CallbackClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async call({ name, args, toolCallId, signal }) {
      const controller = new AbortController();
      const deadline = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      deadline.unref?.();
      signal?.addEventListener("abort", () => controller.abort(), {
        once: true,
      });

      try {
        const response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // The header, not the body: the body is what the model influenced.
            "x-openbot-agent-token": options.agentToken,
          },
          body: JSON.stringify({
            name,
            args,
            ...(toolCallId ? { toolCallId } : {}),
            run: options.runAssertion,
          }),
          signal: controller.signal,
        });

        const body = (await response.json().catch(() => null)) as {
          text?: string;
          isError?: boolean;
          error?: string;
        } | null;

        if (!response.ok) {
          /*
           * A refusal comes back as something the model can say, not as a thrown error.
           *
           * The agent is mid-run with a person waiting. A throw ends the run with nothing said,
           * which reads as the Bot ignoring them — and a 401 here is the deployment's most confusing
           * failure: a Bot whose token no longer matches has every call rejected, returns nothing to
           * its own model, and the model tells the person there were no results.
           */
          return {
            text:
              body?.error ??
              `That tool could not be called (${response.status}).`,
            isError: true,
          };
        }
        return {
          text: body?.text ?? "",
          isError: body?.isError === true,
        };
      } catch (error) {
        return {
          text:
            controller.signal.aborted && !signal?.aborted
              ? "That tool did not answer in time."
              : `That tool could not be reached: ${error instanceof Error ? error.message : "unknown error"}`,
          isError: true,
        };
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

/**
 * The run assertion carried on an AG-UI run, or nothing.
 *
 * READ, NEVER RECONSTRUCTED. `forwardedProps` is where the deployment puts it — a header would
 * arrive at this process's HTTP layer and be gone by the time a tool call needs it — and an adapter
 * that could not find one must refuse to call tools rather than call them without one. A Bot that
 * cannot prove whose run it is should not be spending anybody's grants.
 */
export function runAssertionFrom(forwardedProps: unknown): string | null {
  if (!forwardedProps || typeof forwardedProps !== "object") return null;
  const value = (forwardedProps as { openbotRun?: unknown }).openbotRun;
  return typeof value === "string" && value ? value : null;
}

/**
 * Which of the offered tools this deployment executes, as it said so itself.
 *
 * `input.tools` mixes two kinds a name cannot tell apart: the Bot's grants, which run through the
 * deployment's policy and audit trail, and components a browser draws. Only the deployment knows
 * which is which, so it says, in `forwardedProps.openbotDeploymentTools`. An adapter that guessed
 * would hand a coding agent a chart tool and have it apologise for not showing the chart.
 */
export function deploymentToolNames(forwardedProps: unknown): string[] {
  if (!forwardedProps || typeof forwardedProps !== "object") return [];
  const value = (forwardedProps as { openbotDeploymentTools?: unknown })
    .openbotDeploymentTools;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
