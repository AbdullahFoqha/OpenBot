/**
 * Turning what a coding agent did into what an AG-UI surface shows.
 *
 * THE RULE IS ONE TO ONE AND NOTHING ELSE. Every AG-UI event here corresponds to a named thing the
 * backend reported. Nothing is synthesised to look busy, and nothing the adapter did not understand
 * is forwarded on the chance that it might be text. An adapter that pipes a CLI's stdout into
 * `TEXT_MESSAGE_CONTENT` produces a transcript where a tool's progress bar, a deprecation warning
 * and the model's actual answer are the same thing.
 *
 * THINKING IS NOT AN ANSWER, and it is dropped rather than shown. A coding agent thinks in long
 * passages about files it is about to read; relayed as assistant text it buries the answer, and
 * relayed as a separate message it fills a channel a person reads. The adapter keeps it for the run
 * record instead, where somebody debugging can find it.
 *
 * A TOOL THE AGENT RAN ITSELF IS NOT A TOOL CALL THE SURFACE SHOULD RUN. AG-UI's `TOOL_CALL_*`
 * events mean "the client should execute this and come back", which is exactly wrong for a shell
 * command the agent already ran inside its own loop. Those are reported as progress in the run
 * record, not as calls the surface is being asked to make.
 */
import type { AgentEvent } from "./backend";

/** The shape an AG-UI SSE frame takes on the wire. `data: {json}\n\n`, as the encoder writes it. */
export function encodeSse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export type AgUiEvent = Record<string, unknown> & { type: string };

export type TranslationState = {
  messageId: string;
  textOpen: boolean;
  /**
   * Whether anything was ever said, as opposed to whether a message is open right now.
   *
   * THE DIFFERENCE IS THE WHOLE BUG. `textOpen` goes back to false when the message is closed, so a
   * perfectly ordinary run that answered and finished looked, to a check written against it, exactly
   * like one that said nothing — and a live run duly reported "the agent finished without saying
   * anything" underneath the answer it had just given.
   */
  saidAnything: boolean;
  /** Counted rather than kept, so a run record can say what happened without keeping the contents. */
  toolCalls: Record<string, number>;
  delegatedCalls: Record<string, number>;
  thinkingCharacters: number;
};

export function newTranslationState(runId: string): TranslationState {
  return {
    messageId: `msg_${runId}`,
    textOpen: false,
    saidAnything: false,
    toolCalls: {},
    delegatedCalls: {},
    thinkingCharacters: 0,
  };
}

/**
 * The AG-UI events one backend event produces, in order.
 *
 * Returns an array rather than emitting, so the whole translation is a pure function of the event
 * and the state. The bugs in this kind of code are all ordering bugs — a `TEXT_MESSAGE_CONTENT`
 * before its `START`, an unclosed message at the end — and they are only cheap to find when the
 * translation can be driven from a list of events in a test.
 */
export function translate(
  event: AgentEvent,
  state: TranslationState,
): AgUiEvent[] {
  switch (event.type) {
    case "session":
      // Not an AG-UI event. Identity for the run record; the surface learns nothing from it.
      return [];

    case "thinking":
      state.thinkingCharacters += event.text.length;
      return [];

    case "text": {
      const events: AgUiEvent[] = [];
      if (!state.textOpen) {
        events.push({
          type: "TEXT_MESSAGE_START",
          messageId: state.messageId,
          role: "assistant",
        });
        state.textOpen = true;
      }
      state.saidAnything = true;
      events.push({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: state.messageId,
        delta: event.text,
      });
      return events;
    }

    case "tool":
      /*
       * Counted, not emitted.
       *
       * `TOOL_CALL_*` means "surface, run this and come back with the result". A shell command the
       * agent already ran inside its own loop is not that, and emitting it would have the surface
       * try to execute a tool it does not have, fail, and append a failure to a conversation where
       * the work had actually succeeded.
       */
      if (event.status === "started") {
        state.toolCalls[event.name] = (state.toolCalls[event.name] ?? 0) + 1;
      }
      return [];

    case "delegated":
      // Executed by the adapter against this deployment's callback, not by the surface. Counted here
      // so the run record can say which of OpenBot's tools were really used.
      state.delegatedCalls[event.name] =
        (state.delegatedCalls[event.name] ?? 0) + 1;
      return [];

    case "result": {
      const events: AgUiEvent[] = [];
      /*
       * The final text, when the stream did not already carry it.
       *
       * The CLI sends the answer twice — once as assistant deltas and once as the result — and
       * sending both would show a person the answer and then the answer again. The result is used
       * only when nothing opened a message, which is the tool-only run: work happened, nothing was
       * said, and a run that ends with no text at all reads as the Bot ignoring the request.
       */
      if (!state.textOpen && event.text) {
        events.push({
          type: "TEXT_MESSAGE_START",
          messageId: state.messageId,
          role: "assistant",
        });
        events.push({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: state.messageId,
          delta: event.text,
        });
        state.textOpen = true;
        state.saidAnything = true;
      }
      if (state.textOpen) {
        events.push({ type: "TEXT_MESSAGE_END", messageId: state.messageId });
        state.textOpen = false;
      }
      return events;
    }

    case "error": {
      const events: AgUiEvent[] = [];
      // Close what was opened before reporting the failure. A surface left holding an open message
      // renders a half-written answer with no end to it.
      if (state.textOpen) {
        events.push({ type: "TEXT_MESSAGE_END", messageId: state.messageId });
        state.textOpen = false;
      }
      events.push({ type: "RUN_ERROR", message: event.message });
      return events;
    }
  }
}

/**
 * What a run that produced no text at all should say.
 *
 * MARKED HONESTLY RATHER THAN LEFT EMPTY. A coding run whose whole output was edits and a build is a
 * real and common outcome, and an empty answer reads to a person as the Bot having ignored them. The
 * setup kit asks specifically for tool-only and empty answers to be marked rather than smoothed over.
 */
export function emptyRunNotice(state: TranslationState): string | null {
  // Whether anything was EVER said, not whether a message happens to be open: see `saidAnything`.
  if (state.saidAnything) return null;
  const tools = Object.entries(state.toolCalls);
  if (tools.length === 0) {
    return "The agent finished without saying anything and without running any tools. Nothing was changed.";
  }
  return `The agent finished without a written answer. It ran ${tools
    .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
    .join(", ")}. Check the worktree for what changed.`;
}
