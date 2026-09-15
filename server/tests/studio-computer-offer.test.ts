import { describe, expect, test } from "bun:test";
import {
  isServerComputerTool,
  notAlreadyOffered,
  SERVER_COMPUTER_TOOLS,
} from "../src/computer/server-tools";
import {
  dedupesByArgumentsAlone,
  HANDOFF_TOOL_REF,
  operationIdFor,
} from "../src/agents/handoff-callback";
import type { GrantedTool } from "../src/plugins/tools";

/**
 * Which of two places drives the browser, and when a repeat is a retry.
 *
 * Both are small functions and both decide something that is invisible until it goes wrong: one
 * model call executed twice against one browser, and one browser action dropped because it looked
 * like a retry of the previous one.
 */

const tool = (name: string): GrantedTool =>
  ({ name, ref: `computer/${name}` }) as GrantedTool;

describe("who drives the browser", () => {
  test("a chat run, where the app registered the tools, is offered no server twins", () => {
    /*
     * The failure this prevents: two tools with one name in front of one model, one executed in the
     * browser with the person's session and one executed here, both against the same computer.
     */
    const offered = notAlreadyOffered(
      [...SERVER_COMPUTER_TOOLS].map(tool),
      SERVER_COMPUTER_TOOLS,
    );
    expect(offered).toEqual([]);
  });

  test("a run with no browser open is offered all of them", () => {
    const offered = notAlreadyOffered([...SERVER_COMPUTER_TOOLS].map(tool), []);
    expect(offered.map((entry) => entry.name)).toEqual([
      ...SERVER_COMPUTER_TOOLS,
    ]);
  });

  test("a surface that registered only some of them is topped up with the rest", () => {
    // A real possibility rather than a hypothetical: the app's set and this one are maintained
    // separately, so they are compared by name per run rather than assumed to match.
    const offered = notAlreadyOffered([...SERVER_COMPUTER_TOOLS].map(tool), [
      "computer_navigate",
      "computer_screenshot",
    ]);
    expect(offered.map((entry) => entry.name)).not.toContain(
      "computer_navigate",
    );
    expect(offered.map((entry) => entry.name)).toContain("computer_click");
  });

  test("unrelated tools the surface offered do not remove anything", () => {
    const offered = notAlreadyOffered([...SERVER_COMPUTER_TOOLS].map(tool), [
      "render_chart",
      "confirm_dialog",
    ]);
    expect(offered).toHaveLength(SERVER_COMPUTER_TOOLS.length);
  });

  test("the names a callback will execute are exactly the names offered", () => {
    // A tool offered but not routed is one a Bot announces and cannot use; a name routed but not
    // offered is a door nothing opens. Both sides come from the same list.
    for (const name of SERVER_COMPUTER_TOOLS) {
      expect(isServerComputerTool(name)).toBe(true);
    }
    for (const name of [
      "computer_run_command",
      "computer_write_file",
      "host_run_command",
      HANDOFF_TOOL_REF,
    ]) {
      expect(isServerComputerTool(name)).toBe(false);
    }
  });
});

describe("when a repeated call is a retry", () => {
  const base = { botId: "bot", runId: "run", args: { deltaY: 400 } };

  test("a browser action repeated with no call id is two actions, not one", () => {
    /*
     * A Bot may scroll the same page twice in one run and mean it both times. Answering the second
     * from the record would drop work while reporting success, which is a worse failure than the
     * duplicate the record exists to prevent.
     */
    expect(dedupesByArgumentsAlone("computer_scroll")).toBe(false);
    expect(dedupesByArgumentsAlone("computer_click")).toBe(false);
  });

  test("handing the same work to the same Bot twice in one run is already one hop", () => {
    // Decided by the handoff desk long before this existed, so the record agrees with it rather
    // than contradicting it.
    expect(dedupesByArgumentsAlone(HANDOFF_TOOL_REF)).toBe(true);
    expect(dedupesByArgumentsAlone("host_run_command")).toBe(true);
  });

  test("with a call id, a retry and a second call are told apart by the caller", () => {
    const first = operationIdFor({
      ...base,
      toolRef: "computer_scroll",
      callId: "call-1",
    });
    const retry = operationIdFor({
      ...base,
      toolRef: "computer_scroll",
      callId: "call-1",
    });
    const second = operationIdFor({
      ...base,
      toolRef: "computer_scroll",
      callId: "call-2",
    });
    expect(retry).toBe(first);
    // Identical arguments, different call: the only place that knows is the caller, and it said so.
    expect(second).not.toBe(first);
  });

  test("a call id cannot be used to collect another run's answer", () => {
    // The Bot and the run are signed, and they are in the hash. The worst a caller can do by
    // choosing this field is collect its own earlier answer.
    const mine = operationIdFor({
      ...base,
      toolRef: "computer_scroll",
      callId: "call-1",
    });
    const theirs = operationIdFor({
      ...base,
      botId: "another-bot",
      toolRef: "computer_scroll",
      callId: "call-1",
    });
    const otherRun = operationIdFor({
      ...base,
      runId: "another-run",
      toolRef: "computer_scroll",
      callId: "call-1",
    });
    expect(theirs).not.toBe(mine);
    expect(otherRun).not.toBe(mine);
  });
});
