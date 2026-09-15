import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createComputerGateway } from "../src/computer/gateway";
import { createPageFrameStore } from "../src/computer/page-frames";
import type { ActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import type { SnapshotResult } from "../src/computer/schema";
import { computerServerTools } from "../src/computer/server-tools";
import { createDatabase } from "../src/db/client";
import { computerPageFrame } from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

/**
 * A Bot using its own computer with every tab closed.
 *
 * THERE IS NO FRONTEND IN THIS FILE, and that absence is the test. The computer tools were
 * registered by the app and posted to `/api/computers/...` with a person's session, so a routine at
 * three in the morning and a specialist answering a hop on a replica nobody is watching had no
 * browser at all. Everything below runs with nothing open.
 *
 * What it must NOT be is a second route to the computer. Every call goes through the same gateway a
 * person's click goes through, so the policy still decides, the row is still written, and a human
 * holding the wheel still stops it — proven here by making each of those refuse.
 *
 * The evidence is checked in the database rather than in a return value, because an unattended run
 * has no Activity panel and "it worked, you had to be there" is not evidence.
 */

const database = createDatabase(testDatabaseUrl(), { max: 3 });
const frames = createPageFrameStore(database);

const suite = randomUUID().slice(0, 8);
const BOT = `computer-bot-${suite}`;
const OTHER_BOT = `computer-other-${suite}`;

/** The page the Bot is sent to, carrying a value only a real read could report. */
const NONCE = `nonce-${randomUUID()}`;

const SNAPSHOT: SnapshotResult = {
  snapshotId: 4,
  url: "https://controlled.test/page",
  title: "Controlled page",
  truncated: false,
  elements: [
    { ref: "e1", role: "textbox", name: "Search", type: "text" },
    { ref: "e2", role: "button", name: "Submit order" },
  ],
};

const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** A stand-in agent-computer, so the gateway's own HTTP path is exercised rather than mocked out. */
function fakeComputer(options?: {
  control?: { mode: string; reason?: string };
  navigateStatus?: number;
}) {
  const reached: string[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async (botId) => `http://computer.invalid/${botId}`,
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl = (async (url: string) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/[^/]+/, "") || parsed.pathname;
    reached.push(`${parsed.pathname.split("/")[1]}:${path}`);
    switch (path) {
      case "/snapshot":
        return Response.json(SNAPSHOT);
      case "/read":
        return Response.json({
          url: SNAPSHOT.url,
          title: SNAPSHOT.title,
          text: `The value on this page is ${NONCE}.`,
          truncated: false,
        });
      case "/navigate":
        if (options?.navigateStatus) {
          return Response.json(
            { error: "a person has taken control of this computer" },
            { status: options.navigateStatus },
          );
        }
        return Response.json({
          url: SNAPSHOT.url,
          title: SNAPSHOT.title,
          text: `The value on this page is ${NONCE}.`,
          truncated: false,
          elapsedMs: 3,
        });
      case "/screenshot":
        return Response.json({
          // A real PNG header, base64. Small, and recognisably an image rather than a sentinel.
          base64: "iVBORw0KGgoAAAANSUhEUg==",
          width: 1280,
          height: 800,
          capturedAt: new Date().toISOString(),
          url: SNAPSHOT.url,
        });
      case "/click":
      case "/type":
      case "/key":
      case "/scroll":
        return Response.json({
          action: path.slice(1),
          url: SNAPSHOT.url,
          elapsedMs: 1,
        });
      case "/control":
        return Response.json(options?.control ?? { mode: "bot" });
      default:
        return Response.json({ error: `no ${path}` }, { status: 404 });
    }
  }) as unknown as typeof fetch;
  return { provider, fetchImpl, reached };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

async function toolsFor(options?: {
  policy?: ActionPolicy;
  control?: { mode: string; reason?: string };
  navigateStatus?: number;
  mayAct?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  initiator?: { kind: "routine"; id: string };
  botId?: string;
  evidenceId?: string;
  withFrames?: boolean;
}) {
  const { provider, fetchImpl, reached } = fakeComputer({
    ...(options?.control ? { control: options.control } : {}),
    ...(options?.navigateStatus
      ? { navigateStatus: options.navigateStatus }
      : {}),
  });
  const { store, rows } = fakeAudit();
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore: store,
    policy: () => options?.policy ?? PERMISSIVE,
  });
  const botId = options?.botId ?? BOT;
  // The server holds the snapshot a ref is resolved against, exactly as the real flow does.
  await gateway.snapshot(botId);
  const tools = computerServerTools({
    gateway,
    botId,
    actor: { id: "person-1" },
    ...(options?.initiator ? { initiator: options.initiator } : {}),
    ...(options?.withFrames === false ? {} : { frames }),
    ...(options?.mayAct ? { mayAct: options.mayAct } : {}),
    ...(options?.evidenceId
      ? { nextEvidenceId: () => options.evidenceId as string }
      : {}),
  });
  const call = (name: string, args: unknown = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  return { call, tools, rows, reached };
}

async function clean() {
  await database
    .delete(computerPageFrame)
    .where(like(computerPageFrame.computerId, "computer-%"));
}

beforeEach(clean);
afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

describe("browsing with nothing open", () => {
  test("a Bot opens a controlled page and reports what is actually on it", async () => {
    const { call } = await toolsFor();
    const answer = await call("computer_navigate", {
      url: "https://controlled.test/page",
    });
    // The nonce exists only on the page. A tool that reported success without reading could not
    // produce it, which is why the assertion is on the value rather than on "ok".
    expect(answer).toContain(NONCE);
    expect(answer).toContain("https://controlled.test/page");
  });

  test("a screenshot is kept where somebody can find it after the run", async () => {
    const evidenceId = `evidence-${suite}`;
    const { call } = await toolsFor({ evidenceId });
    const answer = await call("computer_screenshot");
    expect(answer).toContain(evidenceId);

    /*
     * Read back from the database rather than from the return value.
     *
     * The Activity panel is a live view of a browser session, and an unattended run has no session
     * to look at. Evidence that exists only in a transient panel is evidence nobody can produce
     * later.
     */
    const stored = await frames.load(BOT, evidenceId);
    expect(stored?.url).toBe(SNAPSHOT.url);
    expect(stored?.frame).toBe("iVBORw0KGgoAAAANSUhEUg==");
  });

  test("a deployment with nowhere to keep evidence says so rather than implying it kept some", async () => {
    const { call } = await toolsFor({ withFrames: false });
    const answer = await call("computer_screenshot");
    expect(answer).toContain("not kept");
    // The Bot is told not to call it evidence, because it is not.
    expect(answer).toContain("do not refer to it as evidence");
  });

  test("a snapshot tells the model the one thing that makes its refs usable", async () => {
    const { call } = await toolsFor();
    const answer = await call("computer_snapshot");
    expect(answer).toContain("snapshotId 4");
    expect(answer).toContain("e2\tbutton\tSubmit order");
    // Without this line a model reuses a ref from an older snapshot, is refused, and reads the
    // refusal as the page being broken.
    expect(answer).toContain("Send this snapshotId with every click");
  });

  test("clicking and typing go through, and what was typed is never echoed", async () => {
    const { call } = await toolsFor();
    expect(
      await call("computer_click", { ref: "e2", snapshotId: 4 }),
    ).toContain("Submit order");
    const typed = await call("computer_type", {
      ref: "e1",
      snapshotId: 4,
      text: "hunter2-is-a-password",
    });
    expect(typed).toContain("21 characters");
    // This string becomes conversation history and an audit payload. A form field is exactly where
    // a password or a one-time code lives.
    expect(typed).not.toContain("hunter2");
  });
});

describe("the boundaries a person's click has, applied to a run with no person", () => {
  test("a denied action never reaches the computer", async () => {
    const { call, reached, rows } = await toolsFor({
      policy: {
        ...PERMISSIVE,
        deny: ['contains(element.name, "Submit order")'],
      },
    });
    const answer = await call("computer_click", { ref: "e2", snapshotId: 4 });
    expect(answer).toStartWith("Refused:");
    // The decision happens before the effect, and the trail says it happened.
    expect(reached.some((entry) => entry.endsWith(":/click"))).toBe(false);
    expect(
      rows.some((row) => row.eventType === "computer.action_refused"),
    ).toBe(true);
  });

  test("a denied navigation is refused too, so the trail is not silent about where it tried to go", async () => {
    const { call, reached } = await toolsFor({
      policy: {
        ...PERMISSIVE,
        deny: ['page.host == "controlled.test"'],
      },
    });
    expect(
      await call("computer_navigate", { url: "https://controlled.test/page" }),
    ).toStartWith("Refused:");
    expect(reached.some((entry) => entry.endsWith(":/navigate"))).toBe(false);
  });

  test("a ref from a superseded snapshot is refused rather than clicked", async () => {
    const { call, reached } = await toolsFor();
    // The page re-rendered. Acting on the old citation is not an error, it is clicking the wrong
    // button, which is why the snapshot id travels with every action.
    const answer = await call("computer_click", { ref: "e2", snapshotId: 3 });
    expect(answer).toStartWith("Not done:");
    expect(reached.some((entry) => entry.endsWith(":/click"))).toBe(false);
  });

  test("a person holding the wheel stops an unattended run", async () => {
    const { call, reached } = await toolsFor({ navigateStatus: 409 });
    const answer = await call("computer_navigate", {
      url: "https://controlled.test/page",
    });
    // Not a failure and not something to retry around: somebody is using this computer.
    expect(answer).toStartWith("Not done:");
    expect(answer).toContain("control");
    expect(
      reached.filter((entry) => entry.endsWith(":/navigate")),
    ).toHaveLength(1);
  });

  test("a cancelled run stops before the action rather than after it", async () => {
    const { call, reached } = await toolsFor({
      mayAct: async () => ({
        ok: false,
        reason:
          "this run no longer holds a task in the studio, so it has stopped.",
      }),
    });
    for (const [name, args] of [
      ["computer_navigate", { url: "https://controlled.test/page" }],
      ["computer_click", { ref: "e2", snapshotId: 4 }],
      ["computer_screenshot", {}],
    ] as const) {
      expect(await call(name, args)).toStartWith("Not done:");
    }
    /*
     * A browser does not know its run ended. A click that lands after a stop is the one side effect
     * nobody can undo, so the question is asked before every action rather than once at the start.
     */
    expect(
      reached.filter(
        (entry) =>
          !entry.endsWith(":/snapshot") && !entry.endsWith(":/control"),
      ),
    ).toEqual([]);
  });

  test("a call can only ever reach the computer of the Bot it was built for", async () => {
    const { call, reached } = await toolsFor({ botId: OTHER_BOT });
    await call("computer_navigate", { url: "https://controlled.test/page" });
    /*
     * The Bot is a property of the tool, not an argument to it, so naming another one is not
     * refused — it is unrepresentable. Every address the gateway resolved is this Bot's.
     */
    expect(reached.every((entry) => entry.startsWith(`${OTHER_BOT}:`))).toBe(
      true,
    );
    expect(reached.some((entry) => entry.startsWith(`${BOT}:`))).toBe(false);
  });
});

describe("what the trail says started it", () => {
  test("a routine's browsing is recorded as a routine's, not as a person's", async () => {
    const { call, rows } = await toolsFor({
      initiator: { kind: "routine", id: `routine-${suite}` },
    });
    await call("computer_click", { ref: "e2", snapshotId: 4 });
    const acted = rows.find(
      (row) => row.eventType === "computer.action_allowed",
    );
    /*
     * This was hardcoded to a person, truthfully, while the only path to an action was a frontend
     * tool in somebody's session. A headless run has no session, and labelling its actions as a
     * person's would put a claim in the trail that nobody made.
     */
    expect(acted?.initiator).toEqual({
      kind: "routine",
      id: `routine-${suite}`,
    });
  });

  test("an ordinary run with no initiator still reads as a person, exactly as before", async () => {
    const { call, rows } = await toolsFor();
    await call("computer_click", { ref: "e2", snapshotId: 4 });
    const acted = rows.find(
      (row) => row.eventType === "computer.action_allowed",
    );
    // Absent rather than defaulted here: `recordAuditEvent` already reads an absent initiator as a
    // person, and two places deciding that would be two places to change it.
    expect(acted?.initiator).toBeUndefined();
  });
});

describe("what is deliberately not offered", () => {
  test("no file, shell or drawing tool is in this set", async () => {
    const { tools } = await toolsFor();
    const names = tools.map((tool) => tool.name);
    /*
     * Reaching the workspace and running a command are a different kind of reach, and adding them
     * because they were nearby is how a browsing capability becomes a shell one. A chart or an
     * approval dialog is drawn by a frontend, and a headless runner pretending to execute one would
     * report success for something nobody can see.
     */
    for (const absent of [
      "computer_run_command",
      "computer_read_file",
      "computer_write_file",
      "computer_list_files",
      "computer_request_help",
      "computer_request_secret",
    ]) {
      expect(names).not.toContain(absent);
    }
    expect(names.sort()).toEqual([
      "computer_click",
      "computer_key",
      "computer_navigate",
      "computer_read",
      "computer_screenshot",
      "computer_scroll",
      "computer_snapshot",
      "computer_type",
    ]);
  });
});
