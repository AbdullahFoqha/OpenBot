/**
 * Driving a Bot's computer with nobody watching.
 *
 * WHAT WAS MISSING. The computer tools are registered by the browser: `app/src/lib/copilot/
 * computer-tools.tsx` declares them and posts to `/api/computers/:botId/...` with the person's
 * session. That is a good shape for a conversation — the screen is open, a person can take the
 * wheel — and it means a Bot with every tab closed has no browser at all. A routine at three in the
 * morning, and a specialist answering a hop on a replica nobody is looking at, were offered nothing.
 *
 * WHAT THIS IS NOT. It is not a second way to reach the computer. Every call here goes through the
 * same `ComputerGateway` the routes go through, which resolves the ref against the snapshot THIS
 * SERVER fetched, asks the policy, writes the audit row, and only then acts. Calling the computer
 * service directly would be quicker and would take the gateway's three jobs with it, which are the
 * product. A human holding control, a stale snapshot, a denied host and a refused element all
 * refuse here exactly as they refuse a person's click, because it is the same code refusing.
 *
 * WHAT IS DIFFERENT IS WHO IS ASKING. The Bot, the person on whose behalf, and what started the run
 * all come from the authenticated runtime — never from a tool argument. A headless run carries a
 * routine or handoff initiator, and it reaches the policy as well as the trail, so
 * `initiator.kind == "routine"` is a rule an operator can write about unattended browsing alone.
 *
 * EVIDENCE OUTLIVES THE RUN. A screenshot taken here is written to the page-frame store under an id
 * the tool hands back, because the Activity panel is a live view of a browser session and an
 * unattended run has no session to look at. "It worked, you had to be there" is not evidence.
 */
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import type { GrantedTool } from "../plugins/tools";
import {
  ActionRefusedError,
  type ActionActor,
  type ComputerGateway,
} from "./gateway";
import type { PageFrameStore } from "./page-frames";

/**
 * How much page text one call may put in front of the model.
 *
 * The gateway already truncates, and this is a second ceiling for the same reason the relay has
 * one: a tool result becomes conversation history, is re-sent on every subsequent turn, and a
 * single enormous page would crowd out the work. `truncated` is reported so the Bot says the page
 * was longer rather than answering as though it had all of it.
 */
const MAX_TEXT = 8_000;

/** How many elements a snapshot hands back. Enough to fill a form; not enough to drown a turn. */
const MAX_ELEMENTS = 120;

export type ComputerToolContext = {
  gateway: ComputerGateway;
  /** Whose computer. From the run being built, never from an argument. */
  botId: string;
  /** Who this is for, and what started it. From the authenticated runtime. */
  actor: ActionActor;
  initiator?: AuditInitiator;
  /**
   * Where a screenshot is kept so it survives the run. Absent means no durable evidence, which is
   * said in the result rather than quietly true.
   */
  frames?: PageFrameStore;
  /**
   * The evidence id for the next screenshot.
   *
   * Injected so a test can pin one and so a caller can key evidence to its own task. A default is
   * provided rather than required, because a caller that forgot would otherwise silently overwrite
   * one row.
   */
  nextEvidenceId?: () => string;
  /**
   * Whether this run may still act at all.
   *
   * THE CANCELLATION AND ADMISSION SEAM, checked before every action rather than at the start. A
   * run whose task was reclaimed, suspended or stopped must not keep clicking: the browser does not
   * know the run ended, and a click that lands after a stop is the one side effect nobody can undo.
   * Absent means a deployment with no task admission, which is every deployment before P3.
   */
  mayAct?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
};

const EMPTY = z.object({});

/**
 * One refusal shape for every tool.
 *
 * A refusal is an answer, not an exception, for the reason the handoff desk gives: the model is
 * mid-run with somebody waiting, and a throw ends the run with nothing said. The gateway's own
 * errors already carry sentences written for a person, so they are passed through rather than
 * replaced with a generic one.
 */
async function answering<T>(
  context: ComputerToolContext,
  run: () => Promise<T>,
  describe: (result: T) => string,
): Promise<string> {
  if (context.mayAct) {
    const allowed = await context.mayAct();
    if (!allowed.ok) return `Not done: ${allowed.reason}`;
  }
  try {
    return describe(await run());
  } catch (error) {
    if (error instanceof ActionRefusedError) {
      return `Refused: ${error.message}${error.rule ? ` (rule: ${error.rule})` : ""}`;
    }
    /*
     * Everything else by its message, and the class names matter here.
     *
     * `HumanHasControlError` is the one worth naming: a person has taken the wheel, which is not a
     * failure and not something to retry around. The gateway exports it and its message already
     * says so, so the honest thing is to repeat it rather than to translate it into "could not".
     */
    return `Not done: ${error instanceof Error ? error.message : "the computer could not be reached"}`;
  }
}

const clip = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[...truncated]` : text;

/**
 * The tools a run gets when there is no browser to register them.
 *
 * Returned as ordinary `GrantedTool`s so they travel every path a granted tool travels: offered to
 * a built-in run, described to a remote one, and executed through the signed callback. The set is
 * deliberately the reading and acting core — navigate, read, snapshot, screenshot, click, type, key
 * and scroll. FILE AND SHELL TOOLS ARE NOT HERE: they are a different kind of reach, and adding
 * them because they were nearby is how a browsing capability becomes a shell one.
 *
 * NOTHING THAT DRAWS IS HERE EITHER. A chart or an approval dialog is rendered by a frontend, and a
 * headless runner pretending to execute one would report success for something nobody can see.
 */
export function computerServerTools(
  context: ComputerToolContext,
): GrantedTool[] {
  const { gateway, botId, actor: baseActor, initiator } = context;
  const actor: ActionActor = {
    ...baseActor,
    ...(initiator ? { initiator } : {}),
  };
  const evidenceId =
    context.nextEvidenceId ?? (() => `evidence-${crypto.randomUUID()}`);

  const tool = (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: never) => Promise<string>,
  ): GrantedTool => ({
    name,
    // The same `<group>/<tool>` spelling a grant uses, so selection and the callback route resolve
    // these exactly as they resolve everything else.
    ref: `computer/${name}`,
    description,
    parameters,
    execute: execute as (args: unknown) => Promise<string>,
  });

  return [
    tool(
      "computer_navigate",
      "Open a web page on your own computer and read it. Use this when you need something from the web that you do not already know.",
      z.object({ url: z.string().describe("The full URL to open") }),
      async (args: { url: string }) =>
        answering(
          context,
          () => gateway.navigate(botId, actor, args.url),
          (result) =>
            `Opened ${result.url} — ${result.title}\n\n${clip(result.text)}${
              result.truncated ? "\n\n[the page continues past this]" : ""
            }`,
        ),
    ),

    tool(
      "computer_read",
      "Read the page your computer is already showing, without opening anything.",
      EMPTY,
      async () =>
        answering(
          context,
          () => gateway.read(botId),
          (result) =>
            `${result.url} — ${result.title}\n\n${clip(result.text)}${
              result.truncated ? "\n\n[the page continues past this]" : ""
            }`,
        ),
    ),

    tool(
      "computer_snapshot",
      "List the things on the current page you can click or type into. Take one of these before every click: the refs it gives you are the only way to name an element, and they belong to this snapshot alone.",
      EMPTY,
      async () =>
        answering(
          context,
          () => gateway.snapshot(botId),
          (result) => {
            const elements = result.elements
              .slice(0, MAX_ELEMENTS)
              .map(
                (element) =>
                  `${element.ref}\t${element.role}\t${element.name}${
                    element.value ? `\t= ${element.value}` : ""
                  }${element.disabled ? "\t(disabled)" : ""}`,
              )
              .join("\n");
            return [
              `snapshotId ${result.snapshotId} of ${result.url}`,
              // Said rather than left to be inferred: an action citing a ref from an older snapshot
              // is refused, and a model that does not know the id is the thing that ties them will
              // reuse one and read the refusal as the page being broken.
              "Send this snapshotId with every click, type and key.",
              elements,
              result.elements.length > MAX_ELEMENTS || result.truncated
                ? "[there are more elements on this page than are listed]"
                : "",
            ]
              .filter(Boolean)
              .join("\n");
          },
        ),
    ),

    tool(
      "computer_screenshot",
      "Take a picture of what your computer is showing and keep it as evidence. The id it returns is how anyone finds that picture later.",
      EMPTY,
      async () =>
        answering(
          context,
          async () => {
            const shot = await gateway.screenshot(botId);
            const id = evidenceId();
            /*
             * Kept BEFORE the result is described, so a screenshot the tool says it stored is one
             * the store has. Describing first and writing after is how a transcript ends up
             * referring to evidence that is not there.
             *
             * A store that refuses the frame — too large, or absent entirely — is reported as no
             * evidence rather than silently succeeding. An unattended run has no Activity panel to
             * fall back on, so "you had to be there" is not available.
             */
            const kept = context.frames
              ? await context.frames
                  .save({
                    computerId: botId,
                    toolCallId: id,
                    url: shot.url ?? "about:blank",
                    frame: shot.base64,
                  })
                  .then(() => true)
                  .catch(() => false)
              : false;
            return { shot, id, kept };
          },
          ({ shot, id, kept }) =>
            kept
              ? `Screenshot of ${shot.url ?? "the current page"} kept as ${id} (${shot.width}x${shot.height}, taken ${shot.capturedAt}).`
              : `Screenshot taken (${shot.width}x${shot.height}) but not kept: this deployment has nowhere durable to put it, so do not refer to it as evidence.`,
        ),
    ),

    tool(
      "computer_click",
      "Click something on the current page. Take a snapshot first and use a ref from it.",
      z.object({
        ref: z.string().describe("The ref from the latest snapshot"),
        snapshotId: z
          .number()
          .int()
          .describe("The snapshotId that ref came from"),
      }),
      async (args: { ref: string; snapshotId: number }) =>
        answering(
          context,
          () => gateway.click(botId, actor, args),
          (result) =>
            `Clicked ${result.element?.name ?? args.ref}. The page is now ${result.url}.`,
        ),
    ),

    tool(
      "computer_type",
      "Type into a field on the current page. Take a snapshot first and use a ref from it.",
      z.object({
        ref: z.string().describe("The ref from the latest snapshot"),
        snapshotId: z
          .number()
          .int()
          .describe("The snapshotId that ref came from"),
        text: z.string().describe("What to type"),
        submit: z
          .boolean()
          .optional()
          .describe("Press Enter afterwards, to submit a single-field form"),
      }),
      async (args: {
        ref: string;
        snapshotId: number;
        text: string;
        submit?: boolean;
      }) =>
        answering(
          context,
          () => gateway.type(botId, actor, args),
          (result) =>
            // What was typed is never echoed, for the reason `ActionResult` gives: a form field is
            // exactly where a password or a one-time code lives, and this string reaches both the
            // model's history and the trail.
            `Typed ${result.characters ?? args.text.length} characters into ${
              result.element?.name ?? args.ref
            }${result.submitted ? " and submitted" : ""}. The page is now ${result.url}.`,
        ),
    ),

    tool(
      "computer_key",
      "Press a key on the current page, such as Enter or Escape.",
      z.object({
        key: z.string().describe("The key to press, such as Enter"),
        ref: z.string().optional().describe("The element to press it in"),
        snapshotId: z
          .number()
          .int()
          .optional()
          .describe("The snapshotId that ref came from"),
      }),
      async (args: { key: string; ref?: string; snapshotId?: number }) =>
        answering(
          context,
          () => gateway.key(botId, actor, args),
          (result) => `Pressed ${result.key}. The page is now ${result.url}.`,
        ),
    ),

    tool(
      "computer_scroll",
      "Scroll the current page.",
      z.object({
        deltaY: z
          .number()
          .optional()
          .describe("How far, in pixels. Positive scrolls down."),
      }),
      async (args: { deltaY?: number }) =>
        answering(
          context,
          () => gateway.scroll(botId, actor, args),
          (result) => `Scrolled. The page is now ${result.url}.`,
        ),
    ),
  ];
}

/**
 * The tools this run should be offered, given what the surface already offered it.
 *
 * THE WHOLE OF THE DOUBLE-EXECUTION GUARD, and it is a set difference rather than a flag. In a chat
 * run the app has registered `computer_navigate` and its siblings and executes them in the browser
 * with the person's session; adding server-owned twins would put two tools with one name in front
 * of one model, and one browser would be driven from two places. The names the surface sent are the
 * names this drops, so the two sets cannot overlap by construction rather than because somebody
 * remembered to set a flag correctly.
 *
 * Kept here rather than inline at the call site so it can be tested without booting a runtime, and
 * so a second caller cannot reimplement it slightly differently.
 */
export function notAlreadyOffered(
  tools: GrantedTool[],
  offeredBySurface: Iterable<string>,
): GrantedTool[] {
  const already = new Set(offeredBySurface);
  return tools.filter((tool) => !already.has(tool.name));
}

/** The names this module offers, so a caller can tell them from a grant without executing one. */
export const SERVER_COMPUTER_TOOLS = [
  "computer_navigate",
  "computer_read",
  "computer_snapshot",
  "computer_screenshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
] as const;

export function isServerComputerTool(name: string): boolean {
  return (SERVER_COMPUTER_TOOLS as readonly string[]).includes(name);
}
