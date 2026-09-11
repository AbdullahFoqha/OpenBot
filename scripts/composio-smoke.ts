/**
 * Does this deployment's Composio key actually open Composio?
 *
 * `server/tests/composio-live.test.ts` asks what the vendor does; this asks what THIS KEY can see.
 * They are different questions and only the second one is about an operator's own account: a key
 * with no project behind it, a project with no auth config for the app, or a person who never
 * finished the consent page all produce a product that looks configured and answers nothing. So
 * everything below is a read, and every read is one an operator would otherwise make by clicking
 * around Composio's dashboard and guessing which of the three it was.
 *
 *     COMPOSIO_API_KEY=... bun run composio:smoke -- --user <id> [--call]
 *
 * IT MINTS NO CONNECT LINK AND CREATES NO SESSION. `broker.authorize` answers a url that attaches
 * an account to whoever opens it, so a diagnostic that printed one would be leaving somebody's
 * mailbox in a terminal scrollback and in whatever captured it; this script never calls it, and a
 * person connects in their own browser through the product instead. Sessions are the other half:
 * `createComposioClient` builds a plain per-call client — see the boundary written down at the top
 * of `server/src/plugins/composio-adapter.ts` — and nothing here reaches past it.
 *
 * THE KEY IS NEVER PRINTED. It is read once, handed to {@link createComposioClient}, and after that
 * every line this script writes goes through {@link say}, which redacts it. That is belt and braces
 * on purpose: the adapter promises not to quote the key, but a vendor exception is a foreign object
 * and "this SDK does not put the key in an error" is not a promise this file is in a position to
 * make on the SDK's behalf.
 */
import {
  type ComposioResult,
  effectOf,
  LISTING_LIMIT,
} from "../server/src/plugins/composio";
import { createComposioClient } from "../server/src/plugins/composio-adapter";

/**
 * The app the numbers below are about.
 *
 * One app rather than all of them, because the question is whether a real connection works and a
 * person only ever has one app connected at a time when they are debugging this. Gmail because it
 * is the app this deployment's Composio work has been written against throughout, and because its
 * action count is large enough that a truncated or "important"-filtered listing shows up as an
 * obviously wrong number rather than as a plausible one.
 */
const APP = "gmail";

/**
 * The one action `--call` runs, and why it is safe to run against somebody's real account.
 *
 * A profile read: it answers the address and the message counts, and it touches no message. The
 * slug is named rather than discovered so that what a `--call` does is readable here instead of
 * depending on whatever Composio happens to list first — but the name is not the guarantee. The
 * guarantee is the {@link effectOf} check below, which reads the vendor's own behaviour label at
 * call time and refuses anything that is not marked read-only.
 */
const READ_ACTION = "GMAIL_GET_PROFILE";

const args = process.argv.slice(2);
const userFlag = args.indexOf("--user");
const given = userFlag === -1 ? undefined : args[userFlag + 1];
/*
 * A value that is itself a flag is a missing id rather than a strange one: `--user --call` reads
 * as somebody who forgot the id, and taking `--call` as the user would ask Composio about a person
 * who does not exist and report "no connection" as though that were a finding about them.
 */
const user = given?.startsWith("--") ? undefined : given;
const call = args.includes("--call");

if (!user) {
  console.error(
    "Usage: COMPOSIO_API_KEY=... bun run composio:smoke -- --user <id> [--call]\n\n" +
      "The user id is the one this deployment sends Composio as the person a call is for — the\n" +
      "same id `composio_connections` records. --call additionally runs one read-only action as\n" +
      "that person, which only works once they have connected the app in their own browser.",
  );
  process.exit(2);
}

const configured = process.env.COMPOSIO_API_KEY?.trim();
if (!configured) {
  console.error(
    "COMPOSIO_API_KEY is empty or unset, so there is nothing to ask Composio with and every answer below would be an absence rather than a finding. Run it as COMPOSIO_API_KEY=... bun run composio:smoke -- --user <id>.",
  );
  process.exit(1);
}
/*
 * Rebound so that {@link say}, which is a closure and therefore outside the narrowing above, holds
 * a `string` by declaration rather than by a cast. A cast would be the wrong tool twice over: it
 * asserts what the refusal above already proved, and this is the one variable in the file where
 * silencing the type checker is least welcome.
 */
const key: string = configured;

/**
 * Every line this script writes, with the key taken back out of it.
 *
 * A plain `split`/`join` rather than a regular expression, because a key is an arbitrary string and
 * building a pattern out of one is how a `+` or a `.` in a credential turns a redaction into a
 * mismatch. Applied to the vendor's words as well as to this file's own: the only lines that carry
 * text nobody here wrote are the failure lines, which are exactly the ones worth guarding.
 */
function say(line: string): void {
  console.info(line.split(key).join("<COMPOSIO_API_KEY>"));
}

/**
 * What a thrown failure is allowed to contribute to the output.
 *
 * The MESSAGE, never the object. A caught value from an SDK carries a request, a config and
 * whatever else the vendor attached to it, and `console.error(error)` prints all of it — which is
 * the path by which a key ends up in a terminal and in whatever captured it. So the shape is
 * discarded here and the one human sentence is kept, and even that goes out through {@link say}.
 */
function sentence(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const { actions, broker } = createComposioClient(key);

const apps = await broker.listApps();
const app = apps.find((candidate) => candidate.slug === APP);
say(`Composio listed ${apps.length} apps for this key.`);
if (!app) {
  /*
   * Stated rather than shrugged at. A catalogue that does not contain Gmail is a key pointed at
   * something other than what this script assumes, and reporting "0 actions" for it would read as
   * an empty app rather than as a listing that never included it.
   */
  say(
    `${APP} was not among them, so the action count and the connection below are about an app this key cannot see.`,
  );
  process.exit(1);
}
say(`${app.name} publishes ${app.actionCount} actions.`);

const connected = await broker.isConnected({ userId: user, toolkit: APP });
say(
  connected
    ? `${user} has a live ${APP} connection.`
    : `${user} has no live ${APP} connection. They connect one in their own browser, from the app's page in the product; nothing here can do it for them.`,
);

if (!call) {
  say("Nothing was called. Pass --call to run one read-only action.");
  process.exit(0);
}

if (!connected) {
  say(
    `--call was passed, but there is no connection to call through, so nothing was sent. Connect ${APP} for ${user} first.`,
  );
  process.exit(1);
}

/*
 * The action is looked up in a real listing rather than called from the constant alone, for the two
 * things only the listing carries: the concrete version, which the SDK refuses to execute without,
 * and the behaviour labels, which are what makes the claim "read-only" checkable instead of
 * asserted in a comment.
 */
const listed = await actions.listActions(APP, { limit: LISTING_LIMIT });
const action = listed.find((candidate) => candidate.slug === READ_ACTION);
if (!action) {
  say(
    `Composio does not list ${READ_ACTION} for ${APP}, so nothing was called. Pick another read-only action rather than calling one of the writes.`,
  );
  process.exit(1);
}
const { effect, destructive } = effectOf(action.tags);
if (effect !== "read" || destructive) {
  /*
   * The vendor's label decides, and a disagreement stops the run. `effectOf` treats anything
   * unlabelled as a write, so this also covers the case where Composio stops publishing labels
   * altogether — which would otherwise turn a smoke test into an unreviewed write.
   */
  say(
    `Composio no longer marks ${READ_ACTION} as read-only, so nothing was called. This script only ever runs a read.`,
  );
  process.exit(1);
}
if (!action.version) {
  say(
    `Composio listed ${READ_ACTION} with no version, so no versioned call could be made and nothing was sent.`,
  );
  process.exit(1);
}

let result: ComposioResult;
try {
  result = await actions.execute(
    {
      toolkit: APP,
      slug: action.slug,
      userId: user,
      version: action.version,
    },
    /*
     * No arguments. A profile read is about the connected account itself, and the one parameter it
     * takes defaults to it — so an empty bag is both the smallest request and the one that cannot
     * accidentally name somebody else's mailbox.
     */
    {},
  );
} catch (error) {
  say(`${READ_ACTION} threw: ${sentence(error)}`);
  process.exit(1);
}

/*
 * A resolution is not a success. Composio reports most failures by answering with `successful:
 * false` rather than by throwing, and a smoke test that only watched for exceptions would report a
 * working key on top of a call that failed.
 */
say(
  result.successful
    ? `${READ_ACTION} succeeded.`
    : `${READ_ACTION} failed: ${result.error ?? "Composio said so without saying why."}`,
);
say(`Log id: ${result.logId ?? "none was returned."}`);
process.exit(result.successful ? 0 : 1);
