import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/cursor-adapter/backend";
import {
  createCallbackClient,
  deploymentToolNames,
  runAssertionFrom,
} from "../src/cursor-adapter/callback";
import {
  createCliBackend,
  eventForLine,
  linesFrom,
} from "../src/cursor-adapter/cli-backend";
import {
  emptyRunNotice,
  encodeSse,
  newTranslationState,
  translate,
} from "../src/cursor-adapter/events";

/**
 * What a coding agent's output becomes, and what it must never become.
 *
 * The lines below are taken verbatim from a real `cursor-agent -p --output-format stream-json` run
 * on this machine, not invented. A parser tested against a transcript its author wrote is a parser
 * tested against its author's assumptions, and the fields that matter here — `apiKeySource`, the
 * reported `model`, `usage` — are exactly the ones a hand-written fixture gets wrong.
 */

/** Captured on 14 September 2026 from a bounded run. Ids are real; nothing here is secret. */
const CAPTURED = [
  `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp/probe","session_id":"a967f12d-1479-4524-816c-f1b77f4d09d6","model":"Cursor Grok 4.6 Extra High","permissionMode":"default"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word READY."}]},"session_id":"a967f12d"}`,
  `{"type":"thinking","subtype":"delta","text":"Preparing to reply with","session_id":"a967f12d"}`,
  `{"type":"thinking","subtype":"completed","session_id":"a967f12d"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"READY"}]},"session_id":"a967f12d"}`,
  `{"type":"result","subtype":"success","duration_ms":3481,"is_error":false,"result":"READY","session_id":"a967f12d","request_id":"d25faa4d","usage":{"inputTokens":18197,"outputTokens":40,"cacheReadTokens":2304,"cacheWriteTokens":0}}`,
];

describe("reading the CLI as a stream of events", () => {
  test("the init line carries the identity a report has to be able to state", () => {
    const event = eventForLine(JSON.parse(CAPTURED[0] as string));
    expect(event).toEqual({
      type: "session",
      sessionId: "a967f12d-1479-4524-816c-f1b77f4d09d6",
      // What the provider says it is running, which is not always what was asked for.
      model: "Cursor Grok 4.6 Extra High",
      // "which account paid for this" is the question a person actually has. `login` means the
      // subscription, not an API key -- the distinction the whole billing section turns on.
      credentialSource: "login",
    });
  });

  test("the result line carries reported usage, and an absent one stays absent", () => {
    const event = eventForLine(JSON.parse(CAPTURED[5] as string));
    expect(event).toMatchObject({
      type: "result",
      ok: true,
      usage: { inputTokens: 18197, outputTokens: 40, cacheReadTokens: 2304 },
    });
    // Unknown is not zero. A report that reads a missing number as free is worse than one that says
    // it does not know.
    expect(
      eventForLine({ type: "result", is_error: false, result: "done" }),
    ).toMatchObject({ usage: null });
  });

  test("a tool call is named from the key it arrives under, which is not where a guess would look", () => {
    /*
     * Captured verbatim from a real run. Written against a guessed `{name, status}` shape, every
     * tool call parsed as nothing and a run that edited files reported having run no tools at all --
     * a silent, plausible, completely wrong record, which is exactly the kind a live run catches and
     * a hand-written fixture does not.
     */
    // The id really does contain a newline, so `String.raw` keeps the wire bytes exactly as the CLI
    // wrote them rather than letting an escape get interpreted on the way into the fixture.
    const started = JSON.parse(
      String.raw`{"type":"tool_call","subtype":"started","call_id":"call-da95\nfc_2dcd_0","tool_call":{"globToolCall":{"args":{"globPattern":"**/greeting.ts"}},"hookAdditionalContexts":[],"toolCallId":"call-da95\nfc_2dcd_0","startedAtMs":"1789431882267"},"session_id":"7756123b"}`,
    );
    expect(eventForLine(started)).toEqual({
      type: "tool",
      id: "call-da95\nfc_2dcd_0",
      name: "glob",
      status: "started",
    });

    const completed = JSON.parse(
      `{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"writeToolCall":{"args":{"path":"greeting.ts"},"result":{"success":{}}},"toolCallId":"c1","completedAtMs":"1"},"session_id":"7756123b"}`,
    );
    expect(eventForLine(completed)).toMatchObject({
      name: "write",
      status: "finished",
    });
  });

  test("a call whose tool cannot be named is dropped rather than counted as something", () => {
    // "1 unknown tool" in a record is worse than nothing in it.
    expect(
      eventForLine({
        type: "tool_call",
        subtype: "started",
        tool_call: { toolCallId: "x", startedAtMs: "1" },
      }),
    ).toBeNull();
  });

  test("a line this adapter does not understand is dropped rather than forwarded", () => {
    // The CLI emits more than this, and will emit more again after an update. Forwarding an unknown
    // line puts vendor internals into a person's transcript; refusing it breaks on upgrade.
    expect(
      eventForLine({ type: "some_future_event", text: "internals" }),
    ).toBeNull();
    expect(eventForLine(JSON.parse(CAPTURED[1] as string))).toBeNull();
    expect(eventForLine(JSON.parse(CAPTURED[3] as string))).toBeNull();
  });

  test("a chunk that splits a line in half does not lose the line", () => {
    /*
     * A stream over a pipe splits wherever the kernel felt like it. `JSON.parse` per chunk fails on
     * the first long tool argument and the run looks like it produced nothing -- the bug that only
     * shows up under load, which is why the buffering is its own tested function.
     */
    const buffer = { rest: "" };
    const whole = `${CAPTURED.join("\n")}\n`;
    const parsed = [
      ...linesFrom(buffer, whole.slice(0, 137)),
      ...linesFrom(buffer, whole.slice(137, 400)),
      ...linesFrom(buffer, whole.slice(400)),
    ];
    expect(parsed).toHaveLength(CAPTURED.length);
    expect(parsed[0]?.apiKeySource).toBe("login");
    expect(parsed[5]?.usage?.inputTokens).toBe(18197);
  });

  test("a line that is not JSON is dropped, not quoted back as an answer", () => {
    const buffer = { rest: "" };
    const parsed = [
      ...linesFrom(buffer, "Checking for updates...\n" + CAPTURED[4] + "\n"),
    ];
    // The CLI prints human-readable notices too. Relabelling one as the model's answer is how a
    // warning ends up quoted to a person as a result.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("assistant");
  });
});

describe("refusing to run somewhere it cannot be confined", () => {
  test("an unacknowledged deployment gets a refusal instead of an unconfined agent", async () => {
    const backend = createCliBackend({
      spawnImpl: (() => {
        throw new Error("nothing should be spawned");
      }) as never,
    });
    const run = await backend.start({
      prompt: "edit the file",
      cwd: "/tmp/worktree",
      model: "cursor-grok-4.6-xhigh",
    });
    const events = [];
    for await (const event of run.events) events.push(event);
    /*
     * Measured on this machine rather than assumed: cursor-agent with --workspace and --trust wrote
     * a file outside the workspace through the shell, and did it again with --sandbox enabled. So
     * `cwd` is where the agent starts and says nothing about where it may go, and a deployment
     * pointing this at a real repository has to say it accepts that somewhere a person chose it.
     */
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain(
      "not confined to its worktree",
    );
  });

  test("the capability report does not claim a sandbox it does not have", () => {
    const backend = createCliBackend();
    expect(backend.capabilities.sandbox).toBe(false);
    // And the delegated-tool gap is reported rather than papered over: OpenBot's own tools would
    // need an MCP server this adapter hosts, which is real work rather than a missing flag.
    expect(backend.capabilities.delegatedTools).toBe(false);
    expect(backend.reason).toContain("credential store");
  });
});

describe("running out of usage", () => {
  test("a quota refusal is reported as itself, and nothing quietly switches model or account", async () => {
    /*
     * The real text, captured from this account on 14 September 2026 after a few bounded runs:
     * "ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to
     * Auto, or ask your admin to increase your limit to continue."
     *
     * "Switch to Auto" is the provider suggesting a DIFFERENT MODEL, which is the one thing an
     * unattended adapter must not do on its own: it is a different route, a different cost and a
     * decision with somebody's money behind it. The correct behaviour is to stop and say so, and
     * this pins it -- a future convenience that retries on another model would fail here.
     */
    const backend = createCliBackend({
      acknowledgeUnconfined: true,
      spawnImpl: ((_command: string, _args: string[]) => {
        const stdout = new (require("node:stream").PassThrough)();
        const stderr = new (require("node:stream").PassThrough)();
        const child = new (require("node:events").EventEmitter)() as never as {
          stdout: unknown;
          stderr: unknown;
          pid: number;
          on: (event: string, handler: (...args: unknown[]) => void) => void;
          emit: (event: string, ...args: unknown[]) => void;
        };
        (child as { stdout: unknown }).stdout = stdout;
        (child as { stderr: unknown }).stderr = stderr;
        (child as { pid: number }).pid = 0;
        queueMicrotask(() => {
          stderr.write(
            "ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.\n",
          );
          child.emit("close", 1);
        });
        return child;
      }) as never,
    });

    const run = await backend.start({
      prompt: "make the change",
      cwd: "/tmp/worktree",
      model: "cursor-grok-4.6-xhigh",
    });
    const events = [];
    for await (const event of run.events) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    const message = (events[0] as { message: string }).message;
    expect(message).toContain("out of usage");
    // No second run, no other model, no other credential. One attempt, reported.
    expect(events.filter((event) => event.type === "session")).toHaveLength(0);
  });
});

describe("what a surface is shown", () => {
  const run = (events: AgentEvent[]) => {
    const state = newTranslationState("run-1");
    const emitted = events.flatMap((event) => translate(event, state));
    return { state, emitted, types: emitted.map((entry) => entry.type) };
  };

  test("a plain answer opens, streams and closes exactly once", () => {
    const { types } = run([
      { type: "session", sessionId: "s", model: "m" },
      { type: "thinking", text: "long internal monologue" },
      { type: "text", text: "READY" },
      { type: "result", ok: true, text: "READY", usage: null },
    ]);
    expect(types).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
  });

  test("the answer is not shown twice when the stream and the result both carry it", () => {
    const { emitted } = run([
      { type: "text", text: "READY" },
      { type: "result", ok: true, text: "READY", usage: null },
    ]);
    const contents = emitted.filter(
      (entry) => entry.type === "TEXT_MESSAGE_CONTENT",
    );
    // The CLI sends it both ways. Showing both shows a person the answer and then the answer again.
    expect(contents).toHaveLength(1);
  });

  test("a run whose only output was the result still says something", () => {
    const { types } = run([
      { type: "result", ok: true, text: "Done: 3 files changed.", usage: null },
    ]);
    // A tool-only run that ends with nothing at all reads as the Bot ignoring the request.
    expect(types).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
  });

  test("thinking never reaches the surface", () => {
    const { emitted, state } = run([
      { type: "thinking", text: "I should read package.json first" },
      { type: "thinking", text: " and then the lockfile" },
    ]);
    /*
     * A coding agent thinks in long passages about files it is about to read. Relayed as assistant
     * text it buries the answer; relayed as its own message it fills a channel a person reads.
     */
    expect(emitted).toEqual([]);
    expect(state.thinkingCharacters).toBeGreaterThan(0);
  });

  test("a tool the agent ran itself is counted, never emitted as a call for the surface to make", () => {
    const { emitted, state } = run([
      { type: "tool", id: "t1", name: "shell", status: "started" },
      { type: "tool", id: "t1", name: "shell", status: "finished" },
      { type: "tool", id: "t2", name: "edit", status: "started" },
    ]);
    /*
     * TOOL_CALL_* means "surface, run this and come back". A shell command the agent already ran is
     * not that: the surface would try to execute a tool it does not have, fail, and append a failure
     * to a conversation where the work succeeded.
     */
    expect(emitted).toEqual([]);
    expect(state.toolCalls).toEqual({ shell: 1, edit: 1 });
  });

  test("a failure closes the open message before reporting itself", () => {
    const { types } = run([
      { type: "text", text: "Starting the build" },
      { type: "error", message: "The agent exited with code 1." },
    ]);
    // A surface left holding an open message renders a half-written answer with no end to it.
    expect(types).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_ERROR",
    ]);
  });

  test("an empty run is marked honestly rather than left blank", () => {
    const state = newTranslationState("run-1");
    expect(emptyRunNotice(state)).toContain("without running any tools");
    state.toolCalls = { shell: 2, edit: 1 };
    const notice = emptyRunNotice(state);
    expect(notice).toContain("shell x2");
    expect(notice).toContain("edit");
  });

  test("a run that answered is not reported as having said nothing", () => {
    /*
     * `textOpen` goes back to false when the message closes, so a check written against it saw an
     * ordinary completed answer as silence. A live run duly printed "the agent finished without
     * saying anything" directly underneath the answer it had just given.
     */
    const { state } = run([
      { type: "text", text: "READY" },
      { type: "result", ok: true, text: "READY", usage: null },
    ]);
    expect(state.textOpen).toBe(false);
    expect(emptyRunNotice(state)).toBeNull();
  });

  test("a run whose only output was the result is not reported as silent either", () => {
    const { state } = run([
      { type: "result", ok: true, text: "Done: 3 files changed.", usage: null },
    ]);
    expect(emptyRunNotice(state)).toBeNull();
  });

  test("the SSE framing is what an AG-UI client reads", () => {
    expect(encodeSse({ type: "RUN_STARTED", threadId: "t", runId: "r" })).toBe(
      `data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n`,
    );
  });
});

describe("calling a tool that belongs to the deployment", () => {
  const ASSERTION = "signed.assertion.value";

  function client(handler: (request: Request) => Response | Promise<Response>) {
    const seen: {
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const request = new Request(url, init);
      seen.push({
        url,
        headers: request.headers,
        body: JSON.parse(String(init.body ?? "{}")),
      });
      return handler(request);
    }) as unknown as typeof fetch;
    return {
      seen,
      client: createCallbackClient({
        url: "https://openbot.test/api/agent-tools/call",
        agentToken: "obot_agt_secret",
        runAssertion: ASSERTION,
        fetchImpl,
      }),
    };
  }

  test("the assertion is handed back exactly as it arrived, and the token travels in the header", async () => {
    const { client: callback, seen } = client(() =>
      Response.json({ text: "Handed over to Engineer.", isError: false }),
    );
    await callback.call({
      name: "bot/message_bot",
      args: { bot: "Engineer", task: "add the empty state" },
      toolCallId: "call-1",
    });

    expect(seen[0]?.headers.get("x-openbot-agent-token")).toBe(
      "obot_agt_secret",
    );
    /*
     * Unchanged, unparsed, not rebuilt from parts. It is the deployment's statement about the run,
     * and it is the only thing that makes a delegating call safe.
     */
    expect(seen[0]?.body.run).toBe(ASSERTION);
    expect(seen[0]?.body.toolCallId).toBe("call-1");
    expect(seen[0]?.body.args).toEqual({
      bot: "Engineer",
      task: "add the empty state",
    });
  });

  test("a refusal comes back as something the model can say, not as a thrown error", async () => {
    const { client: callback } = client(() =>
      Response.json(
        { error: "That token is not for this Bot." },
        { status: 403 },
      ),
    );
    const result = await callback.call({ name: "bot/message_bot", args: {} });
    /*
     * The agent is mid-run with a person waiting. A throw ends the run with nothing said -- and a
     * 401 here is the deployment's most confusing failure: every call rejected, nothing returned to
     * the model, and the model telling the person there were no results.
     */
    expect(result).toEqual({
      text: "That token is not for this Bot.",
      isError: true,
    });
  });

  test("an unreachable deployment is an answer too", async () => {
    const { client: callback } = client(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await callback.call({ name: "bot/message_bot", args: {} });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("could not be reached");
  });
});

describe("what the deployment says about a run", () => {
  test("the assertion is read from forwardedProps and nowhere else", () => {
    expect(runAssertionFrom({ openbotRun: "signed.value" })).toBe(
      "signed.value",
    );
    // Absent means this deployment could not sign, and a Bot that cannot prove whose run it is
    // should not be spending anybody's grants.
    expect(runAssertionFrom({})).toBeNull();
    expect(runAssertionFrom(undefined)).toBeNull();
    expect(runAssertionFrom({ openbotRun: 42 })).toBeNull();
  });

  test("which offered tools this deployment executes comes from the deployment", () => {
    /*
     * `input.tools` mixes grants, which run through the policy and the audit trail, with components
     * a browser draws. A name cannot tell them apart, so the deployment says which is which -- an
     * adapter that guessed would hand a coding agent a chart tool and have it apologise for not
     * showing the chart.
     */
    expect(
      deploymentToolNames({
        openbotDeploymentTools: ["bot/message_bot", "computer_navigate"],
      }),
    ).toEqual(["bot/message_bot", "computer_navigate"]);
    expect(deploymentToolNames({})).toEqual([]);
    expect(deploymentToolNames({ openbotDeploymentTools: "all" })).toEqual([]);
  });
});
