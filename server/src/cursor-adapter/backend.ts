/**
 * What a coding agent on this Mac does, said in one vocabulary.
 *
 * TWO WAYS IN, AND THE DIFFERENCE IS DELIBERATE RATHER THAN HISTORICAL. The Cursor SDK's local mode
 * is the preferred one: it gives a structured run stream, in-process custom tools, cancellation and
 * reported usage as interfaces rather than as text to be parsed. The CLI's `--output-format
 * stream-json` is the fallback, and it exists because it is the route this installation is already
 * authenticated for — `cursor-agent status` is logged in, the SDK's own credential store is not, and
 * reading the CLI's private credentials to bridge the two is exactly the thing not to do.
 *
 * NEITHER BACKEND EMITS RAW LOGS. Every event below is a named thing that happened. A stream of CLI
 * stdout forwarded as assistant text is not an adapter: the transcript fills with tool chatter,
 * nothing can tell a thought from an answer, and a failure reads as more output.
 *
 * WHAT THEY DO NOT BOTH SUPPORT IS STATED, NOT PAPERED OVER. `capabilities.delegatedTools` says
 * whether this backend can execute OpenBot's own tools — handing work to another Bot, driving the
 * browser — by calling them back through the signed callback. The SDK can, through `customTools`.
 * The CLI cannot without standing up an MCP server for it, so it reports false and the adapter says
 * so instead of quietly dropping the tools and letting a model wonder why nothing worked.
 */

/** One thing that happened, in the adapter's own vocabulary rather than a vendor's. */
export type AgentEvent =
  /** Emitted once, as early as the backend can say it. */
  | {
      type: "session";
      sessionId: string;
      /** What the provider says it is running, which is not always what was asked for. */
      model: string;
      /**
       * Where the credential came from, as the backend reports it.
       *
       * Recorded because "which account paid for this" is the question a person actually has, and
       * an adapter that cannot answer it is an adapter nobody should point at a subscription.
       */
      credentialSource?: string;
    }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  /** A tool the agent ran itself, inside its own loop. */
  | {
      type: "tool";
      id: string;
      name: string;
      status: "started" | "finished";
      detail?: string;
    }
  /**
   * A tool this deployment owns, which the agent is asking the adapter to run.
   *
   * The adapter calls it back through `/api/agent-tools/call` with the run assertion it was handed.
   * Only a backend whose `capabilities.delegatedTools` is true ever emits this.
   */
  | {
      type: "delegated";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "result";
      ok: boolean;
      text: string;
      /** Null when the provider reported none. Never zero: unknown is not free. */
      usage: Record<string, number> | null;
      model?: string;
      sessionId?: string;
    }
  | { type: "error"; message: string };

export type BackendCapabilities = {
  /** Whether this backend can execute OpenBot's own tools through the signed callback. */
  delegatedTools: boolean;
  /** Whether a run can be stopped through a supported interface rather than by killing a process. */
  cancellation: boolean;
  /** Whether the provider reports token usage for a run. */
  usage: boolean;
  /** Whether filesystem and shell access can be confined by the backend itself. */
  sandbox: boolean;
};

export type BackendRun = {
  /** The normalised stream. Ends when the run ends, for any reason. */
  events: AsyncIterable<AgentEvent>;
  /** Stop it. Supported where `capabilities.cancellation` is true; best effort otherwise. */
  cancel: () => Promise<void>;
};

export type CursorBackend = {
  readonly kind: "sdk" | "cli";
  readonly capabilities: BackendCapabilities;
  /**
   * Why this backend and not the other, in a sentence a person reads in the setup report.
   *
   * REQUIRED RATHER THAN OPTIONAL. A fallback chosen silently is a fallback nobody revisits, and the
   * whole point of preferring the SDK is that somebody should be able to see when the preference was
   * not met and what would meet it.
   */
  readonly reason: string;
  /** What the account actually offers, asked rather than assumed from a remembered alias. */
  models: () => Promise<{ id: string; displayName?: string }[]>;
  start: (input: {
    prompt: string;
    /** The worktree. Already registered and admitted by the native worker. */
    cwd: string;
    /** The model to request. Recorded beside whatever the provider says it ran. */
    model: string;
    /** The compiled role and workflow, forwarded deliberately rather than hoped for. */
    instructions?: string;
    /** OpenBot's own tools, offered only where `capabilities.delegatedTools` is true. */
    delegatedTools?: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[];
    /** How a delegated tool is actually executed. Called by the backend, never by the model. */
    callDelegated?: (
      name: string,
      args: Record<string, unknown>,
      toolCallId: string,
    ) => Promise<{ text: string; isError: boolean }>;
    signal?: AbortSignal;
  }) => Promise<BackendRun>;
};

/**
 * What the adapter records about one run, whichever backend served it.
 *
 * REQUESTED AND REPORTED ARE SEPARATE FIELDS, and that is the point of the type. An alias carried
 * over from another harness may be accepted, silently mapped, and answered by something else; a
 * report that shows only what was asked for cannot tell that from a match. The setup kit is explicit
 * that a remembered model string is a preference to preserve, not evidence that today's provider
 * still accepts it.
 */
export type RunRecord = {
  backend: "sdk" | "cli";
  requestedModel: string;
  reportedModel: string | null;
  sessionId: string | null;
  credentialSource: string | null;
  usage: Record<string, number> | null;
  ok: boolean;
  durationMs: number;
  /** Tool calls the agent made itself, by name and count. Not their contents. */
  toolCalls: Record<string, number>;
  /** OpenBot tools executed through the callback, by name and count. */
  delegatedCalls: Record<string, number>;
};
