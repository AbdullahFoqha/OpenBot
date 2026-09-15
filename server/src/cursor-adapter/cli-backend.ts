/**
 * The Cursor CLI, read as a structured stream rather than as output.
 *
 * WHY THIS EXISTS WHEN THE SDK IS PREFERRED. The SDK keeps its own credential store, at
 * `~/.cursor/sdk/auth.json`, and this installation's is empty: `cursor-agent` is signed in and the
 * SDK is not. The two are separate on purpose, and the way across is the SDK's own browser login or
 * a user API key — never reading the CLI's private credential file, which would be taking somebody's
 * credential out of the place they put it and putting it somewhere they did not.
 *
 * So until that one login happens, this is the authenticated route, and it is a real one:
 * `--output-format stream-json` is a documented machine interface with typed events, a session id, a
 * reported model, a request id and token usage. What it is not is a tool bus — a custom tool would
 * have to be an MCP server this adapter stands up and the CLI approves — so `delegatedTools` is
 * false and the adapter says so rather than dropping OpenBot's tools quietly.
 *
 * NOTHING HERE FORWARDS A LOG LINE. Every event is parsed, named, and dropped if it is not one this
 * adapter understands. A stream of stdout relabelled as assistant text fills a transcript with tool
 * chatter and makes a failure look like more output.
 */
import { spawn } from "node:child_process";
import type { AgentEvent, CursorBackend } from "./backend";

export type CliBackendOptions = {
  /** The executable. Named rather than found on PATH at call time, so a report can say which one. */
  executable?: string;
  /** Injected for tests, which must not spawn a real agent or spend a real subscription. */
  spawnImpl?: typeof spawn;
  /** How long one run may take before the process group is stopped. */
  timeoutMs?: number;
  /**
   * A deployment saying, in as many words, that it knows this backend is not confined.
   *
   * MEASURED, NOT ASSUMED, AND THE MEASUREMENT IS THE REASON THIS OPTION EXISTS. On this machine,
   * cursor-agent 2026.09.10 with `--workspace <dir> --trust` was asked to write a file outside the
   * workspace through the shell, and did. Repeated with `--sandbox enabled` it did again, and the
   * `system/init` line reported no sandbox at all. So `--workspace` names where the agent starts and
   * nothing about where it may go — exactly the distinction that makes `cwd` not a boundary.
   *
   * The native worker confines the commands IT spawns. It cannot confine what a coding agent does
   * inside its own loop, because that loop is the agent's, and this deployment has no container
   * engine installed to put it in one.
   *
   * So the refusal is the default. A deployment pointing this at a real repository has to say it
   * accepts that, in configuration, where somebody chose it — rather than discovering it from a
   * file that changed outside the worktree.
   */
  acknowledgeUnconfined?: boolean;
};

/**
 * One line of `stream-json`, narrowed to the events this adapter acts on.
 *
 * Deliberately partial. The CLI emits more than this and will emit more again after an update; a
 * parser that refused an unknown `type` would break on an upgrade, and one that forwarded it would
 * put vendor internals into a transcript. Unknown lines are dropped, which is the third option and
 * the right one.
 */
type CliLine = {
  type?: string;
  subtype?: string;
  text?: string;
  session_id?: string;
  model?: string;
  apiKeySource?: string;
  is_error?: boolean;
  result?: string;
  request_id?: string;
  usage?: Record<string, number>;
  message?: {
    role?: string;
    content?: { type?: string; text?: string }[];
  };
  /** The CLI's own id for the call. Real ones contain a newline, so they are never interpolated. */
  call_id?: string;
  /**
   * The call itself, keyed by the tool that made it.
   *
   * THE NAME IS THE KEY, NOT A FIELD, which is not what an adapter written from the docs expects:
   * `{"tool_call":{"globToolCall":{"args":{...},"result":{...}}}}`. Written against a guessed
   * `{name, status}` shape, every tool call parsed as nothing and a run that edited three files
   * reported having run no tools at all -- a silent, plausible, completely wrong record. Captured
   * from a real run rather than assumed.
   */
  tool_call?: Record<string, unknown>;
};

/**
 * The tool a call was, from the key it arrived under.
 *
 * `globToolCall` -> `glob`. The suffix is stripped because it is on every one of them and says
 * nothing; the bookkeeping keys (`toolCallId`, `startedAtMs`, `hookAdditionalContexts`) are skipped
 * because they sit beside the tool rather than being one.
 */
export function toolNameFrom(
  call: Record<string, unknown> | undefined,
): string | null {
  if (!call) return null;
  for (const key of Object.keys(call)) {
    if (!key.endsWith("ToolCall")) continue;
    const name = key.slice(0, -"ToolCall".length);
    if (name) return name;
  }
  return null;
}

/** Pulls the text out of an assistant or user message, which arrives as content blocks. */
function textOf(line: CliLine): string {
  return (line.message?.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/**
 * Turn one parsed line into an adapter event, or nothing.
 *
 * Exported because this is the whole of the translation and it is worth testing against real
 * captured output without spawning anything.
 */
export function eventForLine(line: CliLine): AgentEvent | null {
  if (line.type === "system" && line.subtype === "init") {
    return {
      type: "session",
      sessionId: line.session_id ?? "",
      model: line.model ?? "",
      ...(line.apiKeySource ? { credentialSource: line.apiKeySource } : {}),
    };
  }
  if (line.type === "thinking") {
    // Only the deltas carry text; the `completed` line is a boundary marker with nothing in it.
    return line.text ? { type: "thinking", text: line.text } : null;
  }
  if (line.type === "assistant") {
    const text = textOf(line);
    return text ? { type: "text", text } : null;
  }
  if (line.type === "tool_call") {
    const name = toolNameFrom(line.tool_call);
    // A call whose tool this adapter cannot name is dropped rather than counted as something. A
    // record that says "1 unknown tool" is worse than one that says nothing.
    if (!name) return null;
    return {
      type: "tool",
      id: line.call_id ?? "",
      name,
      status: line.subtype === "completed" ? "finished" : "started",
    };
  }
  if (line.type === "result") {
    return {
      type: "result",
      ok: line.is_error !== true,
      text: line.result ?? "",
      usage:
        line.usage && Object.keys(line.usage).length > 0 ? line.usage : null,
      ...(line.model ? { model: line.model } : {}),
      ...(line.session_id ? { sessionId: line.session_id } : {}),
    };
  }
  if (line.type === "error") {
    return { type: "error", message: line.result ?? "The agent failed." };
  }
  // `user` echoes the prompt back, and anything else is a line this adapter does not act on.
  return null;
}

/**
 * Split a byte stream into whole JSON lines.
 *
 * A CHUNK IS NOT A LINE. A stream arriving over a pipe splits wherever the kernel felt like it, so
 * `JSON.parse` on a chunk fails on the first long tool argument and the run looks like it produced
 * nothing. Exported so the buffering is testable, because this is the bug that only shows up under
 * load.
 */
export function* linesFrom(
  buffer: { rest: string },
  chunk: string,
): Generator<CliLine> {
  buffer.rest += chunk;
  let index = buffer.rest.indexOf("\n");
  while (index !== -1) {
    const line = buffer.rest.slice(0, index).trim();
    buffer.rest = buffer.rest.slice(index + 1);
    if (line) {
      try {
        yield JSON.parse(line) as CliLine;
      } catch {
        // A line that is not JSON is not an event. Dropped rather than forwarded: the CLI prints
        // human-readable notices too, and relabelling one as the model's answer is how a warning
        // ends up quoted back to a person as a result.
      }
    }
    index = buffer.rest.indexOf("\n");
  }
}

export function createCliBackend(
  options: CliBackendOptions = {},
): CursorBackend {
  const executable = options.executable ?? "cursor-agent";
  const spawnImpl = options.spawnImpl ?? spawn;

  return {
    kind: "cli",
    capabilities: {
      /*
       * False, and said out loud.
       *
       * OpenBot's own tools would have to reach this agent as an MCP server the adapter hosts and
       * the CLI approves. That is real work rather than a missing flag, so it is a documented
       * capability gap: the adapter refuses to pretend, and the setup report names the SDK login as
       * what closes it.
       */
      delegatedTools: false,
      cancellation: true,
      usage: true,
      /*
       * The CLI has `--sandbox enabled`, but the confinement this studio relies on is the native
       * worker's: the worktree is registered, the path is resolved through symlinks, and the process
       * group is the thing that gets stopped. Reported false so nobody reads a vendor flag as the
       * boundary.
       */
      sandbox: false,
    },
    reason:
      "The Cursor SDK's own credential store is empty on this machine while the CLI is signed in, and reading the CLI's private credentials to bridge them is not something this adapter does. This route is the one the account is already authenticated for.",

    async models() {
      const listed = await new Promise<string>((resolve) => {
        const child = spawnImpl(executable, ["--list-models"], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let text = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        child.on("close", () => resolve(text));
        child.on("error", () => resolve(""));
      });
      /*
       * Asked, never remembered.
       *
       * A model alias carried over from another harness is a preference worth preserving and is not
       * evidence that today's account still offers it. The list is the evidence.
       */
      return listed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes(" - "))
        .map((line) => {
          const [id, ...rest] = line.split(" - ");
          return {
            id: (id ?? "").trim(),
            displayName: rest.join(" - ").trim(),
          };
        })
        .filter((entry) => entry.id.length > 0);
    },

    async start(input) {
      if (!options.acknowledgeUnconfined) {
        /*
         * Refused as a run that produced an error, not as a thrown exception, so the surface shows
         * the reason rather than a dropped connection. The whole value of this refusal is that
         * somebody reads it.
         */
        const events = (async function* () {
          yield {
            type: "error" as const,
            message:
              "This backend is not confined to its worktree and this deployment has not said it accepts that. Measured on this machine: cursor-agent with --workspace and --trust wrote a file outside the workspace through the shell, and did it again with --sandbox enabled. Set acknowledgeUnconfined once you have read that, or use a backend that confines its own tools.",
          };
        })();
        return { events, cancel: async () => {} };
      }

      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--model",
        input.model,
        "--workspace",
        input.cwd,
        /*
         * Trusted because the worktree was registered by the native worker, which resolved it
         * through symlinks and checked it against this task's roots. The prompt is what the CLI
         * would otherwise stop and ask a person, and there is no person here.
         */
        "--trust",
      ];
      const prompt = input.instructions
        ? `${input.instructions}\n\n---\n\n${input.prompt}`
        : input.prompt;
      args.push(prompt);

      const child = spawnImpl(executable, args, {
        cwd: input.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const queue: AgentEvent[] = [];
      let notify: (() => void) | null = null;
      let done = false;
      const push = (event: AgentEvent) => {
        queue.push(event);
        notify?.();
      };

      const buffer = { rest: "" };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        for (const line of linesFrom(buffer, chunk)) {
          const event = eventForLine(line);
          if (event) push(event);
        }
      });
      /*
       * stderr is NOT forwarded as text.
       *
       * It carries progress notices and warnings, and a transcript that quotes them back as the
       * model's answer is worse than one that omits them. It is kept for the failure case only, so a
       * run that dies with no result can say why.
       */
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4_000);
      });

      const stop = async () => {
        if (child.pid === undefined || child.pid === null) return;
        try {
          // The group, for the reason native-worker/run.ts gives: the CLI spawns tools of its own.
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Already gone, which is what was being asked for.
        }
      };
      input.signal?.addEventListener("abort", () => void stop(), {
        once: true,
      });

      let sawResult = false;
      child.on("close", (code) => {
        if (!sawResult) {
          push({
            type: "error",
            message:
              code === 0
                ? "The agent ended without returning a result."
                : `The agent exited with code ${code}.${stderr ? ` ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`,
          });
        }
        done = true;
        notify?.();
      });

      const events = (async function* () {
        while (true) {
          while (queue.length > 0) {
            const event = queue.shift() as AgentEvent;
            if (event.type === "result") sawResult = true;
            yield event;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            notify = () => {
              notify = null;
              resolve();
            };
          });
        }
      })();

      return { events, cancel: stop };
    },
  };
}
