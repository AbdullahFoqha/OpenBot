import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import type { ComposioActions, ComposioResult } from "../src/plugins/composio";
import { useComposioClient } from "../src/plugins/composio";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * What ends a brokered connection, and what the trail says when nobody was asking.
 *
 * `composio_connections` is the sole gate on a brokered call: the row `(toolkit, user_id)` is the
 * whole of the permission, it points at no vault secret, and it references neither `users` nor
 * `mcp_servers`. Nothing therefore cascades it away, which is deliberate — the row has to outlive
 * the person so offboarding can still find it — and it means an explicit retirement is the ONLY
 * thing that can ever end one. Three store methods perform that retirement: `retireConnectionsFor`
 * when somebody is offboarded, `removeServer` when the app itself is taken away, and
 * `disconnectBrokered` when a person ends their own account. This file is about the two an
 * administrator performs on somebody else's behalf, and about the trail those two leave;
 * `disconnectBrokered` has its own coverage in `plugin-store.integration.test.ts`, which is why the
 * two here are described throughout as the two ACTS AN ADMINISTRATOR PERFORMS and never as all the
 * ways a connection can end.
 *
 * WHY THIS FILE OWNS ITS IDS OUTRIGHT, AND SO NEEDS NO REFUSE-TO-RUN GUARD.
 * `plugin-store.integration.test.ts` inserts at `gmail`, `notion` and `bot_helper` and refuses to
 * run when a database already holds them: it asserts things about a real vendor's own action
 * classification, so its ids are forced to be the spellings production uses, and a fixture at a
 * forced id cannot coexist with a real row at that id. Nothing here asserts anything about a real
 * vendor — `accessFor` answers `brokered` for ANY row whose provenance column says composio, and
 * reads the app slug straight off the url — so every id below carries a run-unique suffix and every
 * delete is keyed on one. That makes each row this file removes provably one it inserted, which is
 * the property that guard buys the other way round, and it also lets this file run beside that one.
 *
 * The production deletes under test are keyed the same way: `removeServer` deletes by toolkit and
 * `retireConnectionsFor` by user id, and both of those values are suite-scoped here, so neither can
 * reach another run's rows either.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
/** The app: its `mcp_servers.id`, and the slug in its url, which is what a connection is keyed on. */
const toolkit = `revocable-${suite}`;
const actionName = "APP_FETCH_ITEMS";
const ref = `${toolkit}/${actionName}`;
const botId = `agent_revoke_${suite}`;
/** Somebody who connected the app. */
const askerId = `user_asker_${suite}`;
/** Somebody who connected it and whose `users` row is then deleted out from under the connection. */
const leaverId = `user_leaver_${suite}`;
/**
 * The same app under a display id that is NOT its slug, which is a legal row and an ordinary one.
 *
 * `mcp_servers.id` is what an operator sees and what a grant is written against; the slug in the
 * url is what the broker is asked about. Nothing holds the two equal, and every fixture above
 * spells them the same — which is exactly why a defect that only shows when they differ survived.
 */
const renamedId = `renamed-${suite}`;
/**
 * A SECOND app the same person connected, which is what makes an offboarding's answer per-app.
 *
 * Spelled as an extension of {@link toolkit} rather than as an independent name, so that `toolkit`
 * sorts before it under every collation a database might be running: one string is a strict prefix
 * of the other, and no locale reorders that pair. The offboarding path reads its apps
 * `order by toolkit`, and an assertion about that order is worth nothing if the order it expects is
 * itself a guess about the server's locale.
 */
const secondToolkit = `${toolkit}-more`;
/**
 * The app this file ENABLES rather than inserts, and so the only one whose row it did not write.
 *
 * Every other fixture here is an `mcp_servers` insert made by hand, because what those tests are
 * about is what a removal does to a row that already stands. The two tests at the foot of this file
 * are about the row `addBrokeredApp` writes itself — its `auth_scheme` in particular — so the app
 * has to arrive the way an administrator's press of Add makes it arrive, id and all.
 */
const enabledToolkit = `enablable-${suite}`;
/** What `addBrokeredApp` spells that app's row, which is the id the two tests below read back. */
const enabledId = `composio-${enabledToolkit}`;
/**
 * The app somebody CONNECTS TWICE, which is the only shape that can tell a first key from a second.
 *
 * Its own name rather than {@link enabledToolkit}'s, because `audit_events` is append-only and no
 * cleanup in this file can reach it: the test below that asserts ONE `mcp.account_connected` row
 * under that app would be reading this test's rows too, and the two would pass or fail on whichever
 * order the runner happened to pick.
 */
const rekeyedToolkit = `rekeyable-${suite}`;
/** What `addBrokeredApp` spells that app's row, so {@link clean} can take it back. */
const rekeyedId = `composio-${rekeyedToolkit}`;
/**
 * THE APP WHOSE TYPED KEY IS ACTUALLY SPENT ON A CALL, which no other fixture here is.
 *
 * Its own name rather than {@link enabledToolkit}'s, because that app is the one the secrecy test
 * connects and it publishes no actions at all — which is the whole reason it stays unverified. An
 * app that gets probed has to hold an action a probe may use, and seeding one on that app would
 * change what that test is about. Added to {@link ownedToolkits} so its connection rows are swept,
 * and its `mcp_servers` row goes out with {@link probedId} in {@link clean}.
 */
const probedToolkit = `probed-${suite}`;
/** What `addBrokeredApp` spells that app's row, which is also the id the probe chooser is asked. */
const probedId = `composio-${probedToolkit}`;
/** The one action the chooser can pick for it: a read, asking for nothing, at a recorded version. */
const probeAction = "PROBED_GET_ME";
/**
 * The version the listing recorded for that action, and the reason it is on the fixture at all.
 *
 * Composio refuses a call without a specific version and the transport refuses one before dialling,
 * so an action recorded with no version is an action nothing here can call. A fixture that left it
 * null would have every probe below fail for this deployment's reason rather than the vendor's —
 * and the failure tests would pass while asserting nothing about a key.
 */
const probeVersion = "20260903_00";
/** The account Composio answers with when the key that was just typed is attached. */
const madeAccountId = `ca_${suite}`;
/**
 * AN ACCOUNT THE VENDOR HOLDS THAT THIS DEPLOYMENT NEVER MADE, which is the drift a sweep destroys.
 *
 * `revoke` ends every account a person holds for an app; `revokeAccount` ends the one it is handed.
 * The two differ only when Composio holds an account no row here names — an earlier connection this
 * deployment lost the row for, one made in Composio's own dashboard — and that is somebody's
 * WORKING connection. This id stands in for it, so "the undo was narrow" is an assertion about what
 * the vendor still holds afterwards rather than about how a call was spelled.
 */
const strandedAccountId = `ca_working_${suite}`;
/** Every app this run owns, which is the scope of every read and every delete below. */
const ownedToolkits = [
  toolkit,
  secondToolkit,
  enabledToolkit,
  rekeyedToolkit,
  probedToolkit,
];
/**
 * An app this file does NOT own, standing in for another run's fixture — or another file's.
 *
 * It carries this run's suffix so it cannot collide with a real row, and it is deliberately absent
 * from {@link ownedToolkits} so {@link clean} cannot reach it. Its whole purpose is to be the row
 * that a sweep keyed on `user_id` alone would take by mistake.
 */
const foreignToolkit = `foreign-${suite}`;
/**
 * The app the probe chooser reads, which holds actions and nothing else.
 *
 * Its own `mcp_servers` id rather than {@link toolkit}'s, because every other fixture here seeds
 * `APP_FETCH_ITEMS` — an argument-less read — and a chooser asked about that app would answer that
 * action whatever it did with the rows a probe test cares about. Named as an app id and not added to
 * {@link ownedToolkits}: nobody connects it, so it has no `composio_connections` row to sweep, and
 * its actions go out with the server rows in {@link clean}.
 */
const probeAppId = `probe-${suite}`;
const admin = "admin@openbot.local";
/**
 * THE SECRET A PERSON TYPES, which the test below looks for everywhere it must not be.
 *
 * A RUN-UNIQUE SPELLING, for the same reason every id here carries one and for one more. The
 * assertions about it are ABSENCE assertions read out of two shared tables, and `audit_events` is
 * append-only — nothing in this file can sweep it — so a fixed spelling would have one run's rows
 * answering another run's question. With the suffix, "this string is nowhere" is a sentence about
 * rows this run wrote.
 *
 * AND IT IS A KEY THE REDACTOR WOULD NOT SAVE, WHICH IS WHAT MAKES THE TEST WORTH RUNNING.
 * `redactAuditPayload` masks a value by the NAME of the key holding it, and neither `values` nor
 * `generic_api_key` — the name Composio publishes for Perplexity's key — is on its list. So a
 * payload that carried what somebody typed would carry it verbatim into the trail, and the absence
 * asserted below is the implementation's doing rather than the redactor's.
 */
const typedKey = `pplx-secret-value-${suite}`;
/**
 * THE SECOND KEY, the one somebody types when the first has been rotated or typed wrong.
 *
 * A different spelling from {@link typedKey} rather than the same value sent twice, because what
 * the reconnect test is about is a grant being REPLACED: two sends of one string would be a shape
 * an idempotent no-op could also produce.
 */
const rotatedKey = `pplx-rotated-value-${suite}`;

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/**
 * The vault, and every method loud.
 *
 * A brokered call reaches no credential at all — the deployment's Composio key belongs to the
 * transport and never travels through the store — and neither of the removals under test has a
 * secret of this suite's to retire, because no `mcp_user_token` is ever minted here. So any call to
 * any of these means this file has started exercising something it does not claim to, and a silent
 * stub would hide that.
 *
 * Typed as the interface rather than left to inference, so the shape being stood in for is stated
 * where a reader meets it instead of being inferred from the methods below. That annotation is
 * documentation TODAY AND NOT A CHECK: `tests` is outside `server/tsconfig.json`'s `include`, so
 * `tsc` never reads this file and a method added to the vault goes unremarked here — nothing in
 * this directory would fail, and neither would the assignment further down. It is written anyway so
 * that the day that directory is type-checked, this is already right.
 */
const credentialsStub: CredentialSecretReader & CredentialStore = {
  readSecret: async () => {
    throw new Error("a brokered call reads no credential");
  },
  create: async () => {
    throw new Error("this suite does not write credentials");
  },
  updateSecret: async () => {
    throw new Error("this suite does not write credentials");
  },
  rotate: async () => {
    throw new Error("this suite does not write credentials");
  },
  revoke: async () => {
    throw new Error("this suite mints no credential to revoke");
  },
  isLive: async () => {
    throw new Error("this suite holds no credential to ask about");
  },
  findLiveByKey: async () => {
    throw new Error("this suite holds no credential to ask about");
  },
};

/**
 * A store over the real database, keeping every event it writes.
 *
 * Recorded ALONGSIDE the real insert rather than instead of it: the payloads are what these tests
 * assert about, and a store whose audit insert never touched the database would not be exercising
 * the one it has.
 *
 * AND THOSE ROWS OUTLIVE THE RUN, WHICH {@link clean} CANNOT CHANGE. Every other table this file
 * touches is swept on the way out; `audit_events` is not, and the omission is the database's rule
 * rather than an oversight here. The trail is append-only, enforced by a trigger rather than by the
 * application (`0007_audit_retention_window.sql`): a plain `delete` raises "Audit events are
 * append-only", and the one exemption — a session that sets `openbot.audit_retention_days` to a
 * positive whole number — still refuses any row younger than that many days. The rows this file
 * writes are seconds old at the moment it would sweep them, so NO setting makes them deletable;
 * `3650` is refused for the same reason `1` is. A cleanup here would be a statement that always
 * throws.
 *
 * What that leaves is bounded rather than unbounded. Every row this file writes is keyed on an id
 * carrying this run's suffix — `targetId` is {@link toolkit}, {@link secondToolkit},
 * {@link renamedId} or {@link ref} on every one of them — so they are findable, they belong to no
 * other run, and the retention sweep removes them on its ordinary schedule once they age past the
 * deployment's window. That is the same treatment every audit row in the product gets, and the
 * guarantee that forbids the shortcut is the one the product sells.
 */
const events: Parameters<ReturnType<typeof createAuditStore>["insert"]>[0][] =
  [];
const persisting = createAuditStore(database);
const auditStore = {
  insert: async (event: (typeof events)[number]) => {
    events.push(event);
    await persisting.insert(event);
  },
};

/**
 * Every connection row THIS RUN owns, as `<app>/<person or "">`, in a fixed order.
 *
 * SCOPED TO THIS RUN'S APPS AND ORDERED, both load-bearing. Every name in {@link ownedToolkits}
 * carries this run's suffix, so this reads nothing another run inserted — which matters most for
 * the anonymous actor, whose half of the key names nobody and is therefore the one pair another run
 * legitimately holds too. A read filtered on the person alone would take in every app's anonymous
 * row at once, and a run that died before its cleanup would leave one standing that no cleanup here
 * can reach: these tests run against the shared development database, so that row would redden this
 * file for everybody until somebody edited the database by hand. The ordering is the same argument
 * one step down — Postgres promises none without one, so an unordered read of several rows is
 * compared against whichever order the plan happened to produce.
 */
async function connectionsHeld(): Promise<string[]> {
  const rows = await database
    .select({
      toolkit: composioConnections.toolkit,
      userId: composioConnections.userId,
    })
    .from(composioConnections)
    .where(inArray(composioConnections.toolkit, ownedToolkits))
    .orderBy(asc(composioConnections.toolkit), asc(composioConnections.userId));
  return rows.map((row) => `${row.toolkit}/${row.userId}`);
}

/**
 * THE BROKER, ASKED FOR REAL, because what these tests name is its own answer.
 *
 * Every `mcp.account_disconnected` row here carries `vendorRevocationRequested`, and the whole
 * value of that field is that a reader can tell an account this deployment ended at Composio from
 * one that outlives it there. A store built with NO broker cannot produce anything but `false` for
 * it: `removeServer` and `retireConnectionsFor` both spell the absent-broker case as that constant.
 * So a suite asserting `false` against a brokerless store was asserting the missing dependency and
 * never the implementation — and the same absence hid the revokes themselves and the auth config,
 * because with nothing to call, deleting all three call sites changed nothing this file could see.
 *
 * WHAT IS NOT NAMED THROWS, the discipline `plugin-store.integration.test.ts`'s own spy keeps, and
 * for its reason. "The removal asked the broker to revoke" is worth little beside "and asked it
 * nothing else": a removal that also listed the catalogue or began somebody's connection would be
 * acting on somebody's behalf in a way nothing here has reasoned about, and a stub answering
 * plausibly would let that pass unremarked. Nothing in this file lists the catalogue or begins
 * somebody's connection, so those two methods have no caller here and say so.
 *
 * `ensureAuthConfig` and `isConnected` are the exceptions, and both are recorded rather than
 * answered silently: the tests at the foot of this file enable an app for real and confirm a
 * connection for real, so each has a caller — and every assertion above compares {@link asksMade}
 * whole, so recording them keeps "and asked it nothing else" true of the removals as well.
 */
const unasked = (what: string) => async (): Promise<never> => {
  throw new Error(`this suite's path asked the broker to ${what}`);
};

/**
 * Each ask that reached the vendor, in order, with what this run's table held at the moment of it.
 *
 * `held` IS HOW "REVOKE BEFORE DELETE" BECOMES AN ASSERTION, and that order is the whole of both
 * removals: the row is the only thing in this deployment naming which app a person connected, so a
 * delete that ran first would leave a failed revoke with nothing to revoke under — a live grant on
 * somebody's mailbox that no operation here could reach. A spy that only counted calls would see
 * the two orders identically, so each handler reads the table itself rather than recording its own
 * arguments.
 */
const asks: { ask: string; held: string[] }[] = [];

/**
 * What the vendor was handed to connect somebody with, which is the ONE place it belongs.
 *
 * Kept beside {@link asks} rather than folded into it, because the two record opposite things. An
 * ask is a sentence safe to compare and to print; this holds a person's own credential, and the
 * only reason it is held at all is that "the secret is nowhere else" is worth nothing unless
 * something also asserts it ARRIVED. A test that only looked for the absence would pass just as
 * well against a method that sent Composio nothing.
 */
const valuesSent: Record<string, string>[] = [];

/** The asks alone, which is what an ordering assertion is about. */
function asksMade(): string[] {
  return asks.map((entry) => entry.ask);
}

/**
 * Whether the vendor finds an account to withdraw, which is the answer the trail has to carry.
 *
 * A function of the request rather than a flag, so one act can be given a different answer per
 * person — the shape that tells a passed-through answer from a constant of either polarity.
 */
let vendorFinds: (request: { userId: string; toolkit: string }) => boolean =
  () => true;

/**
 * Whether the vendor REFUSES TO ANSWER AT ALL, which is a different event from answering "none".
 *
 * `false` from {@link ComposioBroker.revoke} is a fact the vendor asserts — it looked and there was
 * no account — and a retirement may finish on it. A throw asserts nothing: the account may be alive
 * and untouched. The two must therefore end the act differently, and a seam that could only vary
 * the boolean could never say so. Separate from {@link vendorFinds} for exactly that reason: one
 * knob spelling both would read as though a refusal were a shade of "no".
 */
let vendorRefuses: (request: { userId: string; toolkit: string }) => boolean =
  () => false;

/**
 * EVERY ACCOUNT THE VENDOR STILL HOLDS, which is what an undo has to be judged against.
 *
 * A list rather than a counter, because the question the narrow undo answers is WHICH account went:
 * a sweep and a by-id withdrawal both leave "one fewer ask made" behind them, and they differ only
 * in what Composio is still holding afterwards. {@link connectWithFields} adds the account it made,
 * {@link ComposioBroker.revokeAccount} takes back the one it is handed, and {@link
 * ComposioBroker.revoke} empties it for the app — so a test can seed {@link strandedAccountId} and
 * assert it survived.
 */
let vendorHolds: string[] = [];

/**
 * Whether the vendor REFUSES TO TAKE ONE ACCOUNT BACK, which is the worst state this feature has.
 *
 * Separate from {@link vendorRefuses} rather than folded into it for the reason that knob is
 * separate from {@link vendorFinds}: that one is about the sweep a retirement makes, this is about
 * the by-id withdrawal a failed verification makes, and one flag spelling both would let a test
 * about an undo pass on a stub that only ever refused a retirement.
 */
let vendorKeepsAccount = false;

const broker: ComposioBroker = {
  listApps: unasked("list the catalogue"),
  ensureAuthConfig: async (config) => {
    // Named by app AND kind, because the kind is what decides which config is created: an enable
    // that forwarded nothing would record an ask whose second half is missing rather than one that
    // merely differs.
    asks.push({
      ask: `ensureAuthConfig:${config.toolkit}/${config.connection.kind}`,
      held: await connectionsHeld(),
    });
  },
  authorize: unasked("begin somebody's connection"),
  isConnected: async (request) => {
    asks.push({
      // Named by app AND person for the reason `revoke` is: a confirm is about one person's account
      // at one app, and "a connection was checked" names neither.
      ask: `isConnected:${request.toolkit}/${request.userId}`,
      held: await connectionsHeld(),
    });
    // Constant, and deliberately not a knob like {@link vendorFinds}. The no-answer is the branch
    // that DELETES a row, which is somebody else's coverage; what this file asks of the confirm is
    // what the yes-answer writes down, so a second polarity here would be a seam with no test
    // behind it pretending the other branch were covered.
    return true;
  },
  revoke: async (request) => {
    asks.push({
      // Named by app AND person: "two revokes happened" says nothing about who they were for, and
      // for `removeServer` who they were for is the whole of what makes a removal repeatable.
      ask: `revoke:${request.toolkit}/${request.userId}`,
      held: await connectionsHeld(),
    });
    // Recorded before it throws, so a refusal is still an ask that was made: the assertions about a
    // refused act are about what reached the vendor before it stopped, and what did not.
    if (vendorRefuses(request)) {
      throw new Error(
        `the vendor would not withdraw ${request.toolkit}/${request.userId}`,
      );
    }
    // A SWEEP, which is the whole difference from `revokeAccount` and the reason it is modelled
    // here at all: this ends every account the person holds for the app, including one this
    // deployment never made. See {@link strandedAccountId}.
    vendorHolds = [];
    return vendorFinds(request);
  },
  deleteAuthConfig: async (forToolkit) => {
    // Named by app as well, because the app and the `mcp_servers` id are allowed to differ and the
    // config belongs to the app. A removal that dropped the config for the row id would be deleting
    // a shape this deployment never made and leaving standing the one it did.
    asks.push({
      ask: `deleteAuthConfig:${forToolkit}`,
      held: await connectionsHeld(),
    });
  },
  // Nothing here draws a connect form, so nobody asks what an app wants typed.
  connectionFields: unasked("ask what an app wants typed"),
  connectWithFields: async (request) => {
    asks.push({
      // Named by app AND person, for `isConnected`'s reason: a connection is one person's account
      // at one app, and "a connection was made" names neither. The values are deliberately NOT in
      // this string — it is compared, printed on failure, and read by whoever is debugging.
      ask: `connectWithFields:${request.toolkit}/${request.userId}`,
      held: await connectionsHeld(),
    });
    valuesSent.push(request.values);
    // Held from here, so that what the vendor is left with afterwards is a fact about the act
    // rather than about the fixture: the account exists because this call made it.
    vendorHolds.push(madeAccountId);
    return { accountId: madeAccountId };
  },
  revokeAccount: async (accountId) => {
    asks.push({
      // Named by the ACCOUNT ID and by nothing else, because that is the whole of what this method
      // is handed and the whole of what makes it narrow. An ask spelled by app and person would be
      // indistinguishable from `revoke`'s, which is the call this one exists not to be.
      ask: `revokeAccount:${accountId}`,
      held: await connectionsHeld(),
    });
    // Recorded before it refuses, for `revoke`'s reason: an undo that failed is still an undo that
    // was attempted, and the tests about that state assert both halves.
    if (vendorKeepsAccount) {
      throw new Error(`the vendor would not take ${accountId} back`);
    }
    vendorHolds = vendorHolds.filter((held) => held !== accountId);
  },
};

const store = createPluginStore({
  database,
  auditStore,
  broker,
  credentials: credentialsStub,
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

/** Every action Composio was asked to run, so "was this call made" is an assertion and not a guess. */
const reached: string[] = [];

const answered: ComposioResult = { data: {}, error: null, successful: true };

/**
 * A client that answers everything, so a refusal in these tests is always this deployment's.
 *
 * The vendor is a process-wide registry, so `afterEach` takes it back out: a stub outliving its test
 * would be answering another file's calls.
 */
function useAnsweringClient(actions: Partial<ComposioActions> = {}) {
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return answered;
    },
    ...actions,
  });
}

/** Only this run's rows, and every one of them keyed on an id this run invented. */
async function clean() {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database
    .delete(mcpTools)
    .where(
      inArray(mcpTools.serverId, [
        toolkit,
        renamedId,
        enabledId,
        rekeyedId,
        probeAppId,
        probedId,
      ]),
    );
  await database
    .delete(mcpServers)
    .where(
      inArray(mcpServers.id, [
        toolkit,
        renamedId,
        enabledId,
        rekeyedId,
        probeAppId,
        probedId,
      ]),
    );
  await database
    .delete(composioConnections)
    .where(inArray(composioConnections.toolkit, ownedToolkits));
  await database.delete(users).where(inArray(users.id, [askerId, leaverId]));
}

/**
 * The stand-in for somebody else's fixture, taken back by hand.
 *
 * Deliberately NOT part of {@link clean}, because a test below asserts that `clean` leaves this row
 * standing: folding it in would make that assertion agree with itself. Run beside `clean` from
 * `beforeEach` and `afterAll` instead, so the row cannot outlive the run even if the test that
 * inserts it dies partway — the same shared database that makes the row worth protecting makes a
 * leaked one everybody's problem.
 */
async function cleanForeign() {
  await database
    .delete(composioConnections)
    .where(eq(composioConnections.toolkit, foreignToolkit));
}

/** Which of this run's app rows the deployment still holds, so "the app survived" is an assertion. */
async function appsHeld(): Promise<string[]> {
  const rows = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(inArray(mcpServers.id, [toolkit, renamedId]))
    .orderBy(asc(mcpServers.id));
  return rows.map((row) => row.id);
}

/** The app's row and its one granted action. Separated from the Bot, so a re-add can reuse the Bot. */
async function addApp() {
  await database.insert(mcpServers).values({
    id: toolkit,
    title: "Revocable App",
    vendor: "Composio",
    url: `composio://${toolkit}`,
    provenance: "composio",
  });
  await database.insert(mcpTools).values({
    serverId: toolkit,
    name: actionName,
    description: "Fetch some items.",
    effect: "read",
    version: "20260903_00",
  });
  await store.grant("mcp", ref, botId, admin);
}

/** The app, a Bot holding its one action, and optionally somebody who has connected it. */
async function seedApp(options: { connect?: boolean } = {}) {
  await database.insert(agents).values({
    id: botId,
    name: "Helper",
    type: "built_in",
    configuration: {},
  });
  await addApp();
  if (options.connect !== false) {
    await database
      .insert(composioConnections)
      .values({ toolkit, userId: askerId });
  }
}

/**
 * The probed app as an administrator's press of Add leaves it, plus the action a probe may use.
 *
 * ENABLED FOR REAL RATHER THAN INSERTED BY HAND, because what the connect path reads off the row is
 * the `auth_scheme` — and a fixture that wrote it itself would be asserting this file's idea of what
 * Add records instead of `addBrokeredApp`'s. The action is inserted directly afterwards, the way the
 * two chooser tests above insert theirs: nothing here is about how a listing turns Composio's tags
 * into an effect, and a stub that had to spell those tags would make every test below depend on it.
 *
 * `withProbe: false` LEAVES THE APP WITH NO ACTIONS AT ALL, which is an ordinary app and not a
 * broken one: most key-based apps in the live catalogue publish some argument-less read and PostHog
 * publishes none.
 */
async function addProbedApp(options: { withProbe?: boolean } = {}) {
  await store.addBrokeredApp({
    slug: probedToolkit,
    title: "Probed App",
    by: admin,
    connection: { kind: "fields", authScheme: "API_KEY" },
  });
  if (options.withProbe === false) return;
  await database.insert(mcpTools).values({
    serverId: probedId,
    name: probeAction,
    description: "Says who the key belongs to.",
    effect: "read",
    version: probeVersion,
  });
}

/**
 * Which of THIS RUN'S apps this deployment still believes somebody has connected.
 *
 * Narrowed to named apps and ordered for the reason {@link connectionsHeld} gives, which is the
 * same reason and matters for the same row: the anonymous actor. `notNull` admits the empty string,
 * so `(toolkit, "")` is a legal pair and every run of this file inserts one — and the only half of
 * it that is this run's is the app. Asking what `""` has connected across the whole table therefore
 * reads every other run's anonymous row too, including one left behind by a run that was
 * interrupted before its cleanup; against the shared development database that row is permanent,
 * unreachable by the cleanup here, and reddens this file for everybody until the database is edited
 * by hand. Narrowing to named apps is what makes the assertion about this run.
 *
 * `within` DEFAULTS TO THIS RUN'S OWN APPS and is passed explicitly only to ask about
 * {@link foreignToolkit} — the one row this file holds that it deliberately does not own, and
 * therefore the one it has to be able to ask about separately.
 */
async function connectedToolkitsFor(
  userId: string,
  within: string[] = ownedToolkits,
): Promise<string[]> {
  const rows = await database
    .select({ toolkit: composioConnections.toolkit })
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.userId, userId),
        inArray(composioConnections.toolkit, within),
      ),
    )
    .orderBy(asc(composioConnections.toolkit));
  return rows.map((row) => row.toolkit);
}

function recordedOfType(eventType: string) {
  return events.filter((event) => event.eventType === eventType);
}

// Cleaning BEFORE each test as well as after the run, so a run that dies halfway leaves the next
// one nothing to trip over.
beforeEach(async () => {
  await clean();
  await cleanForeign();
  events.length = 0;
  reached.length = 0;
  asks.length = 0;
  valuesSent.length = 0;
  // The vendor finding an account is the ordinary case — somebody connected, so there is a grant to
  // withdraw. The one test about the answer itself says otherwise for itself.
  vendorFinds = () => true;
  // And answering at all is the ordinary case too. A vendor that will not answer is the subject of
  // its own two tests and of nothing else.
  vendorRefuses = () => false;
  // The vendor holding nothing is where every test starts, so an account in the list below is one
  // the test under way either made or seeded on purpose.
  vendorHolds = [];
  // And taking an account back when asked is the ordinary case, for {@link vendorRefuses}' reason:
  // the refusal is the subject of exactly one test.
  vendorKeepsAccount = false;
});

afterEach(() => useComposioClient(null));

afterAll(async () => {
  await clean();
  await cleanForeign();
});

/**
 * OFFBOARDING. The act an administrator is told removes somebody's access.
 *
 * The call is made first, so what follows is an assertion about the retirement rather than about the
 * fixture. Reaching the vendor a second time would be the person's mailbox being opened after they
 * were removed.
 */
test("offboarding somebody retires the app they connected, and the next call is refused", async () => {
  await seedApp();
  useAnsweringClient();

  await store.callTool({ ref, args: {}, botId, actorId: askerId });
  expect(reached).toEqual([actionName]);

  const { retired } = await store.retireConnectionsFor(askerId, admin);

  // Counted, because the number is what "we removed their access" claims. Reporting the vault's
  // tally alone would say nothing was retired for somebody whose only connector was brokered.
  expect(retired).toBe(1);
  expect(await connectedToolkitsFor(askerId)).toEqual([]);

  /*
   * THE ACCOUNT ENDED AT THE VENDOR, not merely forgotten here, which is the half an administrator
   * was actually promised. Deleting the row shuts the gate this deployment owns and does nothing to
   * the grant: the person's mailbox stays attached at Composio and the offboarding was a lie about
   * the only thing that matters. So the ask is asserted, and asserted WHILE THE ROW STILL STOOD —
   * the row is the only thing naming which app to revoke, so the other order leaves a failed revoke
   * with nothing to revoke under.
   */
  expect(asksMade()).toEqual([`revoke:${toolkit}/${askerId}`]);
  expect(asks[0].held).toEqual([`${toolkit}/${askerId}`]);

  await expect(
    store.callTool({ ref, args: {}, botId, actorId: askerId }),
  ).rejects.toThrow(/have not connected/i);
  expect(reached).toEqual([actionName]);

  const disconnected = recordedOfType("mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0].payload).toMatchObject({
    actor: admin,
    server: toolkit,
    owner: askerId,
    // An administrator removing somebody, never somebody changing their own mind. And true because
    // the broker answered that it had found this person's account and asked for its withdrawal:
    // the field is the vendor's own answer passed through, not that a call was made.
    reason: "person_removed",
    vendorRevocationRequested: true,
  });
});

/**
 * THE GATE, AFTER THE PERSON IS GONE.
 *
 * `composio_connections.user_id` carries no foreign key by design, so deleting somebody's `users`
 * row leaves their connection standing — and the gate reads nothing but `(toolkit, user_id)`, so it
 * goes on passing for an id no person answers to. That is the state offboarding exists to end, and
 * it is the one the vault-based retirement cannot reach: there is no secret here to scan for,
 * because Composio holds the account.
 */
test("a connection whose person is already deleted is retired, and stops passing the gate", async () => {
  await seedApp({ connect: false });
  useAnsweringClient();

  await database
    .insert(users)
    .values({ id: leaverId, email: `${leaverId}@example.com`, name: "Leaver" });
  await database
    .insert(composioConnections)
    .values({ toolkit, userId: leaverId });
  await database.delete(users).where(eq(users.id, leaverId));

  // The design fact this rests on: the row outlives the person, which is what leaves anything to
  // find. Asserted rather than assumed, because the retirement below is pointless without it.
  expect(await connectedToolkitsFor(leaverId)).toEqual([toolkit]);

  const { retired } = await store.retireConnectionsFor(leaverId, admin);
  expect(retired).toBe(1);
  expect(await connectedToolkitsFor(leaverId)).toEqual([]);
  // The grant is withdrawn for somebody who no longer exists here, which is the point of the row
  // outliving the person: nothing else in this deployment still names the app they connected.
  expect(asksMade()).toEqual([`revoke:${toolkit}/${leaverId}`]);
  expect(asks[0].held).toEqual([`${toolkit}/${leaverId}`]);

  await expect(
    store.callTool({ ref, args: {}, botId, actorId: leaverId }),
  ).rejects.toThrow(/have not connected/i);
  expect(reached).toEqual([]);
});

/** Retiring twice is something an administrator may legitimately do, and the second time is quiet. */
test("retiring the same person twice retires nothing the second time", async () => {
  await seedApp();
  useAnsweringClient();

  expect((await store.retireConnectionsFor(askerId, admin)).retired).toBe(1);
  expect(asksMade()).toEqual([`revoke:${toolkit}/${askerId}`]);

  expect((await store.retireConnectionsFor(askerId, admin)).retired).toBe(0);
  // Quiet at the vendor too, and not only in the count. The rows are gone, so there is no app left
  // to name — a second pass that asked Composio again would be this deployment guessing.
  expect(asksMade()).toEqual([`revoke:${toolkit}/${askerId}`]);
});

/**
 * A REFUSAL AT THE VENDOR MUST NOT BECOME A RETIREMENT HERE.
 *
 * CRITERION. When the broker will not withdraw the grant, `retireConnectionsFor` fails, the row
 * stands, the gate still passes, and nothing is written to the trail.
 *
 * REASON. The row is the only thing in this deployment naming which app this person connected. A
 * retirement that swallowed the refusal would delete it and report success, and what is left is the
 * worst state the design admits: a live grant on a departed person's mailbox that no operation here
 * can reach any more, under an administrator who has been told their access was removed. Dead and
 * reachable beats live and unreachable, so the failure has to be loud and the row has to survive it.
 * Repeating the act is the recovery, and repeating it is only possible while the row is there.
 *
 * THE GATE IS ASKED AFTERWARDS, not merely the table. "The row exists" and "the row still works"
 * come apart if a retirement ever clears part of the state before failing, and it is the second
 * that describes the person's access.
 */
test("an offboarding the vendor refuses leaves the connection standing", async () => {
  await seedApp();
  vendorRefuses = () => true;

  await expect(store.retireConnectionsFor(askerId, admin)).rejects.toThrow(
    /would not withdraw/i,
  );

  // The ask was made and the answer never came, which is the state the row has to survive.
  expect(asksMade()).toEqual([`revoke:${toolkit}/${askerId}`]);
  expect(await connectedToolkitsFor(askerId)).toEqual([toolkit]);
  // No trail row either: `mcp.account_disconnected` says an account ended, and none did.
  expect(recordedOfType("mcp.account_disconnected")).toHaveLength(0);

  useAnsweringClient();
  await store.callTool({ ref, args: {}, botId, actorId: askerId });
  expect(reached).toEqual([actionName]);
});

/**
 * THE OFFBOARDING TRAIL CARRIES THE VENDOR'S ANSWER PER APP, AND IN A FIXED ORDER.
 *
 * CRITERION. One act, two of this person's apps, the vendor finding an account for one and none for
 * the other: each row's `vendorRevocationRequested` is the answer about ITS app, and both the asks
 * and the rows come out in `toolkit` order.
 *
 * REASON. This is the same criterion `removeServer` already has a two-person fixture for, on the
 * other act that ends a brokered connection — and the two paths are separate code with separate
 * maps, so a fixture on one says nothing about the other. Until now this one was only ever run with
 * a single connection, which a hardcoded `true` satisfies exactly as well as a passed-through
 * answer; the field then reads as evidence about every row while describing none of them, which is
 * what it was renamed away from.
 *
 * TWO APPS RATHER THAN TWO PEOPLE, because an offboarding is one person by definition. The map this
 * path keeps is keyed on the app for the same reason, so the app is where a constant would show.
 *
 * INSERTED IN THE WRONG ORDER DELIBERATELY. The expected order is the sorted one, and a read with no
 * `order by` most often hands back what was inserted — so a fixture inserted in sorted order agrees
 * with an unordered read by accident and the ordering assertion proves nothing. Inserting the later
 * name first is what makes the sort the only thing that could have produced the expected answer.
 */
test("an offboarding carries the vendor's answer per app, in a fixed order", async () => {
  await seedApp({ connect: false });
  await database
    .insert(composioConnections)
    .values({ toolkit: secondToolkit, userId: askerId });
  await database
    .insert(composioConnections)
    .values({ toolkit, userId: askerId });
  vendorFinds = ({ toolkit: asked }) => asked === toolkit;

  expect((await store.retireConnectionsFor(askerId, admin)).retired).toBe(2);

  expect(asksMade()).toEqual([
    `revoke:${toolkit}/${askerId}`,
    `revoke:${secondToolkit}/${askerId}`,
  ]);
  // Both asks made while both rows still stood: the apps are read off the rows, so a delete between
  // the two would leave the second revoke with nothing to name.
  const bothHeld = [`${toolkit}/${askerId}`, `${secondToolkit}/${askerId}`];
  expect(asks[0].held).toEqual(bothHeld);
  expect(asks[1].held).toEqual(bothHeld);
  expect(await connectedToolkitsFor(askerId)).toEqual([]);

  const disconnected = recordedOfType("mcp.account_disconnected");
  expect(disconnected).toHaveLength(2);
  // Compared in order rather than as a set, because the order is half the criterion. Not sorted
  // here either: sorting the answer before comparing it is how an ordering assertion stops being one.
  expect(
    disconnected
      .map(
        (event) =>
          event.payload as {
            server: string;
            vendorRevocationRequested: boolean;
          },
      )
      .map(({ server, vendorRevocationRequested }) => ({
        server,
        vendorRevocationRequested,
      })),
  ).toEqual([
    { server: toolkit, vendorRevocationRequested: true },
    { server: secondToolkit, vendorRevocationRequested: false },
  ]);
});

/**
 * THE ANONYMOUS ACTOR OWNS NOTHING, and `notNull` does not exclude the empty string, so a row at
 * `(toolkit, "")` is legal. Retiring "nobody" must not be what deletes it — that would be an
 * unattributed offboarding reaching a row it cannot possibly own.
 *
 * WHOSE ROW THIS IS, since the actor half of the key names nobody. The app half does: {@link
 * toolkit} carries this run's suffix, so the sweep in `clean` takes this row by the same clause it
 * takes the asker's by, and no other file can arrive at the pair by guessing. That is the whole of
 * the ownership — a delete keyed on `user_id = ''` alone would reach every app's anonymous row at
 * once, which is how this fixture came to be removed mid-run by another file, and how a run of
 * this file that died before its cleanup came to refuse every test in that one.
 */
test("retiring nobody retires nothing and leaves the anonymous row alone", async () => {
  await seedApp({ connect: false });
  await database.insert(composioConnections).values({ toolkit, userId: "" });

  expect((await store.retireConnectionsFor("", admin)).retired).toBe(0);
  expect(await connectedToolkitsFor("")).toEqual([toolkit]);
  // And nothing reached Composio either. An unattributed offboarding has no account to name, so a
  // revoke sent under an empty user id would be this deployment asking the vendor about nobody.
  expect(asksMade()).toEqual([]);
});

/**
 * The fixture above is taken back by the same sweep every other row here is, and by nothing wider.
 *
 * CRITERION. Two halves, and the second is the one that has teeth. After the sweep this run holds
 * no `composio_connections` row at all — the one at the anonymous actor included, which none of the
 * person ids that sweep names would reach — AND an anonymous row belonging to somebody else is
 * still standing.
 *
 * REASON. Brokered connections are removed here by toolkit, so the anonymous row is already
 * covered and needs no second, broader delete to reach it. Asserted rather than read off the code,
 * because the tempting spelling for "take the anonymous row too" is `user_id = ''`, which is every
 * app at once: the sweep that lands on another file's fixture.
 *
 * WHY THE SECOND HALF IS NOT OPTIONAL. "This run's rows are gone" is satisfied just as well by the
 * wider delete as by the narrow one — a `user_id = ''` sweep takes this run's anonymous row too,
 * and every assertion about absence goes on passing while the defect it forbids is present. Only a
 * row the correct sweep must LEAVE BEHIND can tell the two deletes apart, so {@link foreignToolkit}
 * stands in for one: a row this file inserted, deliberately outside {@link ownedToolkits}, at the
 * pair another run legitimately holds. It is cleaned up by {@link cleanForeign} rather than by the
 * sweep under test, for the reason given there.
 */
test("the sweep takes this run's anonymous row without reaching by actor", async () => {
  await seedApp({ connect: false });
  await database.insert(composioConnections).values({ toolkit, userId: "" });
  // Somebody else's anonymous row, at an app this file's sweep does not name.
  await database
    .insert(composioConnections)
    .values({ toolkit: foreignToolkit, userId: "" });
  expect(await connectedToolkitsFor("")).toEqual([toolkit]);

  await clean();

  expect(await connectionsHeld()).toEqual([]);
  // And the row that was never this sweep's to take is exactly where it was. This is the assertion
  // a delete keyed on `user_id = ''` fails, and the only one here that it fails.
  expect(await connectedToolkitsFor("", [foreignToolkit])).toEqual([
    foreignToolkit,
  ]);
});

/**
 * REMOVING THE APP. The second act that has to end a brokered connection.
 *
 * Nothing else can: the table references `mcp_servers` no more than it references `users`, so the
 * rows simply stand there once the app's row is gone.
 */
test("removing the app takes every brokered connection to it", async () => {
  await seedApp();
  useAnsweringClient();

  await store.callTool({ ref, args: {}, botId, actorId: askerId });

  await store.removeServer(toolkit, admin);

  expect(await connectedToolkitsFor(askerId)).toEqual([]);

  /*
   * THE THREE ASKS THIS ACT OWES THE VENDOR, IN THIS ORDER.
   *
   * Every connected person revoked first, while the rows naming the app still stand, for the reason
   * offboarding revokes first. Then the auth config, LAST OF ALL: an orphaned config grants nobody
   * anything, while a live account whose config has already been deleted is access nothing left
   * here can end. And the config is dropped for the APP, which the `deleteAuthConfig:` half of the
   * entry carries.
   */
  expect(asksMade()).toEqual([
    `revoke:${toolkit}/${askerId}`,
    `deleteAuthConfig:${toolkit}`,
  ]);
  expect(asks[0].held).toEqual([`${toolkit}/${askerId}`]);
  expect(asks[1].held).toEqual([]);

  const disconnected = recordedOfType("mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0].payload).toMatchObject({
    actor: admin,
    server: toolkit,
    owner: askerId,
    // An administrator took the whole app away and the person did nothing. Distinct from both
    // "they disconnected" and "they were removed", which is what an auditor is trying to tell apart.
    reason: "mcp_server_removed",
    // And the vendor's own answer about this person's account, passed through.
    vendorRevocationRequested: true,
  });
});

/**
 * THE SAME REFUSAL, ON THE OTHER ACT, WHERE MORE IS AT STAKE.
 *
 * CRITERION. When the broker will not withdraw a grant, `removeServer` fails, the connection rows
 * stand, the auth config is not dropped, and the app's own row is still there.
 *
 * REASON. The app row is the load-bearing extra. The toolkit is readable in exactly one place — the
 * slug in `mcp_servers.url` — so an app deleted with its connections still standing is a set of live
 * grants that nothing in this deployment can name, let alone end. A removal that swallowed the
 * refusal would do precisely that and report the connector gone. Failing with everything in place
 * costs a repeat of an administrative act nobody minds repeating.
 *
 * AND THE CONFIG STAYS, which is the ordering argument from the other side. The auth config is
 * dropped last because a live account whose config has already been deleted is access nothing left
 * here can end; a refusal partway through must not reach that step either.
 */
test("an app removal the vendor refuses leaves the app and its connections standing", async () => {
  await seedApp();
  vendorRefuses = () => true;

  await expect(store.removeServer(toolkit, admin)).rejects.toThrow(
    /would not withdraw/i,
  );

  // The revoke was attempted; nothing after it ran. Asserted as the whole list, because what makes
  // this pass is as much the `deleteAuthConfig:` that is absent as the `revoke:` that is present.
  expect(asksMade()).toEqual([`revoke:${toolkit}/${askerId}`]);
  expect(await connectedToolkitsFor(askerId)).toEqual([toolkit]);
  expect(recordedOfType("mcp.account_disconnected")).toHaveLength(0);
  expect(await appsHeld()).toEqual([toolkit]);
});

/**
 * REMOVING AN APP NOBODY EVER CONNECTED.
 *
 * CRITERION. No revoke reaches the vendor, and the auth config is dropped all the same.
 *
 * REASON. The two halves fail in opposite directions and neither had a test. A revoke sent with
 * nobody to name would be this deployment asking Composio about a person who never connected — the
 * same defect the anonymous-actor tests forbid on the other act, reached from the other end. And
 * skipping the vendor entirely because the connection table happened to be empty would strand the
 * auth config: it is a shape this deployment created at Composio when the app was added, it belongs
 * to the app and not to anybody's account, and this is the only act that takes it. An app added and
 * removed without a single person connecting is an ordinary sequence — a trial, a mistake, a
 * rename — so the config it leaves behind is the ordinary case and not the rare one.
 */
test("removing an app nobody connected asks about nobody and still drops the config", async () => {
  await seedApp({ connect: false });

  await store.removeServer(toolkit, admin);

  expect(asksMade()).toEqual([`deleteAuthConfig:${toolkit}`]);
  // Nobody's account ended, so nothing claims one did.
  expect(recordedOfType("mcp.account_disconnected")).toHaveLength(0);
  expect(await appsHeld()).toEqual([]);
});

/**
 * WHAT WAS ASKED OF THE VENDOR, NOT THAT A CALL WAS MADE.
 *
 * CRITERION. `vendorRevocationRequested` on each row is the broker's own answer about THAT person.
 *
 * REASON. The field exists so a reader can tell an account this deployment ended at Composio from
 * one that outlives it somewhere else — a gate cleared here with no grant left at the vendor, and a
 * grant the vendor really held and was asked to withdraw. A constant is worse than no field at all,
 * because it reads as evidence about every row while describing none of them; it is how the field
 * came to be renamed from `vendorRevoked`, when every row saying a grant had been withdrawn was
 * describing one still live at Google.
 *
 * TWO PEOPLE IN ONE ACT, the vendor finding an account for one and none for the other, is the
 * smallest shape that tells a passed-through answer from a constant of EITHER polarity: one row
 * alone is satisfied by a hardcoded `true` just as the brokerless store satisfied a hardcoded
 * `false`.
 */
test("the trail carries the vendor's answer per person, not one answer for the act", async () => {
  await seedApp();
  await database
    .insert(composioConnections)
    .values({ toolkit, userId: leaverId });
  vendorFinds = ({ userId }) => userId === askerId;

  await store.removeServer(toolkit, admin);

  expect(asksMade()).toEqual([
    `revoke:${toolkit}/${askerId}`,
    `revoke:${toolkit}/${leaverId}`,
    `deleteAuthConfig:${toolkit}`,
  ]);

  const disconnected = recordedOfType("mcp.account_disconnected");
  expect(disconnected).toHaveLength(2);
  expect(
    disconnected
      .map(
        (event) =>
          event.payload as {
            owner: string;
            vendorRevocationRequested: boolean;
          },
      )
      .map(({ owner, vendorRevocationRequested }) => ({
        owner,
        vendorRevocationRequested,
      }))
      .sort((left, right) => left.owner.localeCompare(right.owner)),
  ).toEqual([
    { owner: askerId, vendorRevocationRequested: true },
    { owner: leaverId, vendorRevocationRequested: false },
  ]);
});

/**
 * ONE KEY FOR "WHAT HAPPENED TO THIS PERSON'S ACCESS", across both acts that can end it.
 *
 * CRITERION. Every `mcp.account_disconnected` row a brokered connection produces names the APP at
 * the broker — in `targetId` and in `payload.server` — whichever act produced it.
 *
 * REASON. The two acts were written in different waves and keyed differently. Offboarding files
 * under `connection.toolkit`, which is all a connection row records and all that is left once the
 * server row is gone. Removing the app filed under the `mcp_servers` id. Where the two spellings
 * agree — which they do in every other fixture in this file, and in the product whenever nobody
 * renamed anything — the disagreement is invisible; where they differ, no single query answers
 * what happened to one person's access, because half the rows are filed under a name the other
 * half never mentions.
 *
 * THE APP IS THE RIGHT KEY, not the row id. A brokered connection is consent to an app: the gate
 * is `(toolkit, user_id)`, `removeServer` clears it by toolkit, and the row outlives the
 * `mcp_servers` row entirely — so the id is not always available and is never what was consented
 * to. Which server row was removed is not lost either: the `configuration.changed` row written in
 * the same call names it.
 */
test("both acts that end a brokered connection file it under the app", async () => {
  await database.insert(agents).values({
    id: botId,
    name: "Helper",
    type: "built_in",
    configuration: {},
  });
  // The row id and the app slug deliberately different, which is the only shape that can tell the
  // two keys apart.
  await database.insert(mcpServers).values({
    id: renamedId,
    title: "Revocable App",
    vendor: "Composio",
    url: `composio://${toolkit}`,
    provenance: "composio",
  });
  await database.insert(composioConnections).values([
    { toolkit, userId: askerId },
    { toolkit, userId: leaverId },
  ]);

  // Offboarding one person, then removing the app out from under the other.
  expect((await store.retireConnectionsFor(leaverId, admin)).retired).toBe(1);
  await store.removeServer(renamedId, admin);

  // The broker is asked about the APP in both acts, and the auth config dropped for the app too —
  // never for the row id, which is a display key the vendor has never heard of. This is the one
  // fixture where the two spellings differ, so it is the only one that can tell them apart.
  expect(asksMade()).toEqual([
    `revoke:${toolkit}/${leaverId}`,
    `revoke:${toolkit}/${askerId}`,
    `deleteAuthConfig:${toolkit}`,
  ]);

  const disconnected = recordedOfType("mcp.account_disconnected");
  expect(disconnected).toHaveLength(2);
  // Both rows, under one key. Asked as the set of keys rather than row by row, because what the
  // criterion is about is a query finding all of them at once.
  expect(new Set(disconnected.map((event) => event.targetId))).toEqual(
    new Set([toolkit]),
  );
  expect(
    new Set(
      disconnected.map((event) => (event.payload as { server: string }).server),
    ),
  ).toEqual(new Set([toolkit]));

  // And each still says which person and which of the three things happened to them, which is the
  // other half of the question and was never the part that was wrong.
  expect(
    disconnected
      .map((event) => event.payload as { owner: string; reason: string })
      .map(({ owner, reason }) => ({ owner, reason }))
      .sort((left, right) => left.owner.localeCompare(right.owner)),
  ).toEqual([
    { owner: askerId, reason: "mcp_server_removed" },
    { owner: leaverId, reason: "person_removed" },
  ]);
});

/**
 * CONSENT MUST NOT REATTACH.
 *
 * Removing an app and adding it back is two ordinary administrative acts. If the connection rows
 * survive them, the second act silently restores everybody's brokered access without anybody being
 * asked again — and the only visible difference between an app nobody has connected and an app
 * everybody is still connected to is whether a call goes out.
 */
test("adding the app back does not restore a connection nobody re-granted", async () => {
  await seedApp();
  useAnsweringClient();

  await store.callTool({ ref, args: {}, botId, actorId: askerId });
  expect(reached).toEqual([actionName]);

  await store.removeServer(toolkit, admin);
  expect(asksMade()).toEqual([
    `revoke:${toolkit}/${askerId}`,
    `deleteAuthConfig:${toolkit}`,
  ]);
  // The same app at the same id, added again. Only the server and its action: the Bot's grant
  // survived the removal on its own, which is a separate defect about `plugin_grants` and not this
  // one. Added by insert rather than through `addBrokeredApp`, so nothing asks the broker again —
  // the refusal below is the consent being gone and not an auth config that was never remade.
  await addApp();

  await expect(
    store.callTool({ ref, args: {}, botId, actorId: askerId }),
  ).rejects.toThrow(/have not connected/i);
  expect(reached).toEqual([actionName]);
});

/**
 * THE TRAIL, WHERE NOBODY WAS ASKING.
 *
 * An empty string in a field whose purpose is to name who did something is worse than an absent
 * field: it reads as a value, and a reader counting rows by actor gets a person called "".
 *
 * `reachedAs` and `actor` are the two on this row, and both are the run's actor verbatim. A brokered
 * app is reached AS THE PERSON, so a run nobody could be attributed to has no name to put in either
 * — and the refusal is recorded, which is exactly when the trail matters.
 */
test("an unattributed run is recorded as unattributed rather than as a blank", async () => {
  await seedApp();
  useAnsweringClient();

  await expect(
    store.callTool({ ref, args: {}, botId, actorId: "" }),
  ).rejects.toThrow(/not attributed to anybody/i);
  expect(reached).toEqual([]);

  const failed = recordedOfType("mcp.call_failed");
  expect(failed).toHaveLength(1);
  // Both fields, exactly. `reachedAs` is "unattributed" and so by that very assertion is not
  // "deployment": this call did not go out on a shared credential, it did not go out at all, and
  // saying the deployment reached the app would assert an attribution that never happened. A
  // separate `not.toBe("deployment")` below this would be that same claim restated more weakly,
  // green for every wrong value but one.
  expect(failed[0].payload).toMatchObject({
    actor: "unattributed",
    reachedAs: "unattributed",
  });
});

/**
 * THE TRAIL, WHERE THE DEPLOYMENT WAS THE ONE ACTING.
 *
 * `refreshTools` defaults its actor to the empty string, and `addServer` and `addCustomServer` both
 * take that default — deliberately, because that argument doubles as the credential to list with and
 * nobody can have connected an app in the moment it is added. So the absence is real and permanent,
 * and what the trail owes a reader is the distinction: not a person, and not nobody either, but the
 * deployment refreshing on its own behalf. `reachedAs` already spells that "deployment".
 */
test("the refresh that follows an add is attributed to the deployment", async () => {
  await seedApp();
  // A different action, so the granted one is left held and not advertised — which is the audit row
  // under test.
  useAnsweringClient({
    listActions: async () => [
      {
        slug: "APP_SOMETHING_ELSE",
        description: "Not the one anybody holds.",
        version: "20260903_00",
      },
    ],
  });

  // No actor, which is exactly what the add path passes.
  await store.refreshTools(toolkit);

  const stranded = events.filter(
    (event) =>
      (event.payload as { change?: string }).change === "grants_not_advertised",
  );
  expect(stranded).toHaveLength(1);
  expect(stranded[0].payload).toMatchObject({
    actor: "deployment",
    refs: [ref],
  });
});

/**
 * ENABLING AN APP THAT IS ALREADY HERE, which is what pressing Add a second time is.
 *
 * `addBrokeredApp` is idempotent by design — two administrators can press Add together, and an app
 * can be removed and added again — so the second press takes the upsert's update branch. Everything
 * on that branch is a display fact the vendor is allowed to restate: the title, the url, who added
 * it. `auth_scheme` is not. It is what this deployment's authorization config was created AS, and
 * every connection anybody has made against that config depends on it, so re-enabling has to leave
 * it standing: a vendor that starts publishing managed OAuth for an app somebody connected by key
 * would otherwise, one press of Add later, have this deployment minting consent links against a
 * config full of keys.
 */
test("re-enabling never moves a connected app onto a different flow", async () => {
  useAnsweringClient();
  await store.addBrokeredApp({
    slug: enabledToolkit,
    title: "Enablable App",
    by: admin,
    connection: { kind: "fields", authScheme: "API_KEY" },
  });
  await database
    .insert(composioConnections)
    .values({ toolkit: enabledToolkit, userId: askerId });

  await store.addBrokeredApp({
    slug: enabledToolkit,
    title: "Enablable App",
    by: admin,
    connection: { kind: "consent" },
  });

  const [row] = await database
    .select({ authScheme: mcpServers.authScheme })
    .from(mcpServers)
    .where(eq(mcpServers.id, enabledId));
  expect(row.authScheme).toBe("API_KEY");
});

/**
 * AND THE ONE CASE WHERE THE REWRITE IS BOTH SAFE AND THE POINT.
 *
 * The rule above is about not stranding connections, so where there are none there is nothing to
 * strand. Re-enabling is then how an operator picks up a vendor's change — without it the only way
 * to record a new scheme would be removing the app and adding it back, which takes its grants with
 * it. So the column is write-once EXCEPT here, and this test is the half of that sentence the test
 * above cannot state.
 */
test("re-enabling an app nobody has connected picks up the vendor's change", async () => {
  useAnsweringClient();
  await store.addBrokeredApp({
    slug: enabledToolkit,
    title: "Enablable App",
    by: admin,
    connection: { kind: "fields", authScheme: "API_KEY" },
  });

  await store.addBrokeredApp({
    slug: enabledToolkit,
    title: "Enablable App",
    by: admin,
    connection: { kind: "consent" },
  });

  const [row] = await database
    .select({ authScheme: mcpServers.authScheme })
    .from(mcpServers)
    .where(eq(mcpServers.id, enabledId));
  expect(row.authScheme).toBe("OAUTH2");
});

/**
 * CONFIRMING A CONNECTION RECORDS IT VERIFIED, BECAUSE A CONSENT SCREEN IS A VERIFICATION.
 *
 * CRITERION. After a confirm the vendor answers yes to, the row reads `verified` true and carries a
 * `verified_at` no earlier than the moment the confirm was made.
 *
 * REASON. `verified` is what the settings page dates its sentence from — "connected, last checked
 * 13 Sep" rather than a present tense this deployment has not earned — and the pair separates a
 * connection whose liveness somebody established from one nobody ever checked. A consent connection
 * belongs on the checked side by construction: it exists at all only because the person
 * authenticated at the vendor's own screen and Composio then answered that the account is attached,
 * which is the same evidence a probe goes and asks for. Writing it on the defaults instead left
 * every consent connection made since migration 0030 reading `false` with a null `verified_at` —
 * byte-identical to a key somebody typed in and nobody has tested — so the page had to describe the
 * two the same way, and the backfilled rows were the only ones in the table telling the truth.
 *
 * THE TIMESTAMP IS HALF THE CRITERION AND NOT A DETAIL. `verified` true beside a null `verified_at`
 * is a claim with no date on it, and the page has nothing to print; the two are written together by
 * one writer or the row is a shape no reader here has reasoned about.
 */
test("a confirmed connection is recorded verified, at the moment it was earned", async () => {
  await seedApp({ connect: false });
  // Taken before the call, so the comparison below is against a moment that cannot postdate the
  // write. Both this and the column are written in this process, so no clock but one is involved.
  const before = new Date();

  expect(
    await store.confirmBrokeredConnection({ toolkit, userId: askerId }),
  ).toEqual({ connected: true });
  // And the vendor was asked, which is what makes the row a record of Composio's answer rather than
  // of a browser arriving back on a page.
  expect(asksMade()).toEqual([`isConnected:${toolkit}/${askerId}`]);

  const [row] = await database
    .select({
      verified: composioConnections.verified,
      verifiedAt: composioConnections.verifiedAt,
    })
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, toolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(row.verified).toBe(true);
  expect(row.verifiedAt).not.toBeNull();
  expect(row.verifiedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
});

/**
 * CHOOSING THE PROBE: READ EFFECT AND ZERO REQUIRED INPUTS, AND NEITHER ALONE WILL DO.
 *
 * CRITERION. Given an app whose alphabetically first argument-less action is a WRITE, the chosen
 * probe is the argument-less READ that sorts after it, and never the write.
 *
 * REASON. The action this picks is the one that will be called with somebody's just-typed API key
 * to find out whether the key works, so a wrong pick is an unrequested write on a stranger's
 * account. The fixture is Stripe's own list and not an invention: the first action Composio
 * publishes for Stripe that requires no arguments is `STRIPE_CREATE_BILLING_METER_EVENT_SESSION`,
 * so a chooser written on "takes no arguments" — the condition that looks sufficient, because it is
 * the one that makes a call possible at all — would open a billing meter event session on the
 * account of every person who typed a key into this deployment. Read effect is what stands between
 * those two names, and it is a fact the vendor asserted rather than a guess: `effectOf` answers
 * `read` only where Composio sent `readOnlyHint`, so everything unlabelled is already recorded here
 * as a write.
 */
test("the probe skips an argument-less write for the read that sorts after it", async () => {
  await database.insert(mcpServers).values({
    id: probeAppId,
    title: "Stripe",
    vendor: "Composio",
    url: `composio://${probeAppId}`,
    provenance: "composio",
  });
  await database.insert(mcpTools).values([
    {
      serverId: probeAppId,
      // Sorts first, asks for nothing, and charges somebody money. The whole test.
      name: "STRIPE_CREATE_BILLING_METER_EVENT_SESSION",
      description: "Creates a billing meter event session.",
      effect: "write",
      version: "20260903_00",
    },
    {
      serverId: probeAppId,
      name: "STRIPE_RETRIEVE_BALANCE",
      description: "Retrieves the balance.",
      effect: "read",
      version: "20260903_00",
    },
  ]);

  expect(await store.probeActionFor(probeAppId)).toBe(
    "STRIPE_RETRIEVE_BALANCE",
  );
});

/**
 * AND AN APP WHOSE ONLY SAFE ACTION WANTS AN ARGUMENT HAS NO PROBE AT ALL.
 *
 * CRITERION. Where every read this deployment recorded for an app declares a required input, the
 * answer is null rather than that action.
 *
 * REASON. There is nothing to invent an argument from. A probe is made before anybody has told this
 * deployment anything about the account beyond the key itself, so a required customer id, project
 * id or query has no honest value to carry — and a guessed one turns "is this key good" into a
 * question about whether some made-up identifier exists, which fails for a perfectly good key.
 * NULL IS A REAL ANSWER AND NOT AN ERROR: sampling the key-based apps in the live catalogue, most
 * publish some argument-less read and PostHog publishes none, so every caller of this has to have
 * an answer for an app that cannot be probed.
 */
test("an app whose only read takes an argument has no probe", async () => {
  await database.insert(mcpServers).values({
    id: probeAppId,
    title: "Needs An Argument",
    vendor: "Composio",
    url: `composio://${probeAppId}`,
    provenance: "composio",
  });
  await database.insert(mcpTools).values({
    serverId: probeAppId,
    name: "APP_GET_PROJECT",
    description: "Reads one project, by id.",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
    version: "20260903_00",
  });

  expect(await store.probeActionFor(probeAppId)).toBeNull();
});

/**
 * CONNECTING WITH A KEY SOMEBODY TYPED: THE VALUES REACH COMPOSIO AND NOTHING ELSE.
 *
 * CRITERION. After a connection made from typed values, the secret is in the vendor's hands and in
 * no row this deployment wrote — not in the `mcp.account_connected` payload, not in
 * `composio_connections` — and what the trail carries instead is the NAMES of the fields that were
 * filled in.
 *
 * REASON. This is the only flow in the product where a person hands this deployment a credential of
 * their own, and the whole design of it is that the credential travels in one direction: off the
 * request, into `connectWithFields`, out to Composio. Every other participant here is a long-lived,
 * widely-readable record. `composio_connections` is read by offboarding, by disconnect and by the
 * gate on every brokered call; `audit_events` is append-only by trigger, exported, and kept for as
 * long as a deployment's retention window says — so a key that lands in either is not a leak
 * somebody can clean up afterwards, it is a leak with a schedule.
 *
 * WHICH IS WHY THIS ASSERTS ABSENCE OUT OF THE TABLES RATHER THAN OFF THE RETURN VALUE. A method
 * can be read for what it puts in a payload; what a reviewer cannot read is what some later writer
 * on the same path adds. Stringifying the rows themselves is the assertion that survives that, and
 * it is not saved by the redactor: neither `values` nor `generic_api_key` is on `sensitiveKeys`, so
 * a payload carrying what somebody typed would carry it through verbatim. See {@link typedKey}.
 *
 * AND IT ASSERTS THE ARRIVAL TOO. "The secret is nowhere" is true of a method that sends Composio
 * nothing at all, so {@link valuesSent} is checked in the same breath: the values went to the one
 * place they are for.
 *
 * `verified: false` HERE IS "NOTHING TO TRY", WHICH `probe: null` IS WHAT SAYS. This app publishes
 * no actions at all, so the chooser has nothing safe to spend the key on and the connection is
 * honestly unchecked — the pair `composio_connections.verified` documents for exactly this row. The
 * same `false` beside a NAMED probe would mean the opposite thing about the key, which is why the
 * two travel together; see {@link connectBrokeredWithFields} and the test at the foot of this file.
 */
test("the values reach Composio and nothing else", async () => {
  useAnsweringClient();
  await store.addBrokeredApp({
    slug: enabledToolkit,
    title: "Enablable App",
    by: admin,
    connection: { kind: "fields", authScheme: "API_KEY" },
  });

  expect(
    await store.connectBrokeredWithFields({
      toolkit: enabledToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).toEqual({ connected: true, verified: false, probe: null });

  // The vendor was asked, and asked with what the person typed. Without this the absences below
  // would be satisfied by a method that connected nobody.
  expect(asksMade()).toEqual([
    `ensureAuthConfig:${enabledToolkit}/fields`,
    `connectWithFields:${enabledToolkit}/${askerId}`,
  ]);
  expect(valuesSent).toEqual([{ generic_api_key: typedKey }]);

  /*
   * THE TRAIL, READ OUT OF THE TABLE RATHER THAN OFF THE RECORDING STORE. The rows are what a
   * reader of the trail will actually see — after the redactor, after the insert — and this file's
   * `auditStore` keeps a copy of the input beside it, not instead of it. Narrowed to this app
   * because `audit_events` is append-only: no cleanup here can reach it, so the other tests in this
   * run have already written `mcp.account_connected` rows under {@link toolkit}.
   */
  const trail = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_connected"),
        eq(auditEvents.targetId, enabledToolkit),
      ),
    );
  expect(trail).toHaveLength(1);
  expect(trail[0].payload).toMatchObject({
    actor: askerId,
    server: enabledToolkit,
    reconnected: false,
    // The names, sorted, because a reader needs to know what the app asked this person for — and
    // that is the whole of what a credential may contribute to a record like this one.
    fields: ["generic_api_key"],
  });
  expect(JSON.stringify(trail)).not.toContain(typedKey);

  const rows = await database
    .select()
    .from(composioConnections)
    .where(inArray(composioConnections.toolkit, ownedToolkits));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    toolkit: enabledToolkit,
    userId: askerId,
    verified: false,
  });
  expect(rows[0].verifiedAt).toBeNull();
  expect(JSON.stringify(rows)).not.toContain(typedKey);
});

/**
 * CONNECTING A SECOND TIME: THE TRAIL SAYS A GRANT WAS REPLACED.
 *
 * CRITERION. Somebody who types a key for an app they had already connected leaves a second
 * `mcp.account_connected` row saying `reconnected: true`, while the first one they left says
 * `false` — and there is still ONE connection row, because the second key replaced the first.
 *
 * REASON. `recordBrokeredConnection` is an upsert, so the row it leaves behind is byte-identical
 * whether it was the first grant or the fourth; `reconnected` is the only thing in the record that
 * tells those apart, and a reader chasing "whose key is on this account" has nothing else to go on.
 * A constant `false` there does not merely omit the fact — it asserts the opposite of it, about a
 * row that really did replace one.
 *
 * AND THE ROUTE'S GUARD IS NOT A SUBSTITUTE, which is why this asks the store directly. The one
 * caller today refuses a second account for the same app, so in production the constant happened to
 * be true; but the guard lives in another file, nothing in this method points at it, and a method
 * that is honest only because of a check somewhere else is one refactor away from filing a false
 * record. What is asserted here is that the store looks.
 */
test("a second key for the same app is recorded as a reconnection", async () => {
  useAnsweringClient();
  await store.addBrokeredApp({
    slug: rekeyedToolkit,
    title: "Rekeyable App",
    by: admin,
    connection: { kind: "fields", authScheme: "API_KEY" },
  });

  await store.connectBrokeredWithFields({
    toolkit: rekeyedToolkit,
    userId: askerId,
    values: { generic_api_key: typedKey },
  });
  await store.connectBrokeredWithFields({
    toolkit: rekeyedToolkit,
    userId: askerId,
    values: { generic_api_key: rotatedKey },
  });

  // Both keys reached the vendor, in order. Without this the trail assertion below would be
  // satisfied by a second call that refused before it connected anybody.
  expect(valuesSent).toEqual([
    { generic_api_key: typedKey },
    { generic_api_key: rotatedKey },
  ]);

  // ONE ROW FOR TWO CONNECTS, which is the whole of why the flag cannot be inferred later: the
  // upsert left nothing behind saying there had been two.
  expect(await connectedToolkitsFor(askerId)).toEqual([rekeyedToolkit]);

  // Read in the order the acts happened, which the recorder keeps and `created_at` does not
  // promise to: two inserts a millisecond apart are two rows an ordered read may return either way
  // round, and the whole assertion is about which of them said what.
  const connected = recordedOfType("mcp.account_connected").filter(
    (event) => event.targetId === rekeyedToolkit,
  );
  expect(
    connected.map(
      (event) => (event.payload as { reconnected: boolean }).reconnected,
    ),
  ).toEqual([false, true]);
});

/**
 * A KEY THAT DOES NOT WORK LEAVES NOTHING BEHIND, NOT EVEN THE ACCOUNT THE CHECK ITSELF MADE.
 *
 * CRITERION. When the probe comes back an error, the call refuses with the vendor's own sentence,
 * the account Composio just made is withdrawn by id, and this deployment holds no connection row.
 *
 * REASON. Composio accepts a key without ever trying it, so "connected" at the vendor says nothing
 * about whether the credential works — and a row written on that acceptance is a gate every later
 * brokered call passes for a key that cannot answer. The first anybody would hear of it is the
 * vendor's own error in the middle of a Bot doing something. So the verification is the whole point
 * of this path, and a failure that left the account standing would be worse than no check at all:
 * the live-but-useless connection would have been created BY the check.
 *
 * AND THE PROBE HAD TO REALLY RUN, which is what {@link reached} asserts beside it. Every absence
 * below is also true of a method that refused before it dialled — for want of a version, say — so
 * without it this test would pass against a deployment that never spent the key at all.
 */
test("a key that does not work leaves nothing behind", async () => {
  useAnsweringClient({
    execute: async ({ slug }) => {
      reached.push(slug);
      // The vendor reporting a failure in a 200, which is how Composio says a credential is wrong.
      return {
        data: {},
        error: "Invalid API key provided.",
        successful: false,
      };
    },
  });
  await addProbedApp();

  await expect(
    store.connectBrokeredWithFields({
      toolkit: probedToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).rejects.toThrow(/Invalid API key provided\./);

  // The key was spent on the action the chooser picked, and on nothing else.
  expect(reached).toEqual([probeAction]);
  // Nothing was saved, which is the sentence the refusal ends on.
  expect(await connectedToolkitsFor(askerId)).toEqual([]);
  // And the account the check created is gone from the vendor, by the id it was made under.
  expect(vendorHolds).toEqual([]);
  expect(asksMade()).toEqual([
    `ensureAuthConfig:${probedToolkit}/fields`,
    `connectWithFields:${probedToolkit}/${askerId}`,
    `revokeAccount:${madeAccountId}`,
  ]);
});

/**
 * AN UNDO THAT FAILS LEAVES THE ACCOUNT REACHABLE RATHER THAN INVISIBLE.
 *
 * CRITERION. When the probe fails AND Composio will not take the account back, the row is written
 * unverified, the refusal says all three things — the key did not work, the account could not be
 * withdrawn, it is recorded here unchecked — and the account is still the vendor's to see.
 *
 * REASON. This is the worst state the feature admits, and the rule that governs every other failure
 * here is not available in it. "Leave nothing behind" assumes the account can be ended; when it
 * cannot, leaving no row does not mean nothing was left behind — it means a LIVE account that
 * nothing in this deployment names, that no screen draws and that the person cannot disconnect,
 * because disconnect works off the row. A row saying "unchecked" is worse than a clean failure and
 * far better than an invisible account. What makes the row honest is that the refusal carries what
 * happened: the person is not told their key is fine, and they are given the one step that helps.
 */
test("an undo that fails leaves the account reachable rather than invisible", async () => {
  useAnsweringClient({
    execute: async ({ slug }) => {
      reached.push(slug);
      return {
        data: {},
        error: "Invalid API key provided.",
        successful: false,
      };
    },
  });
  vendorKeepsAccount = true;
  await addProbedApp();

  await expect(
    store.connectBrokeredWithFields({
      toolkit: probedToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).rejects.toThrow(/would not take the account back/);

  // The undo was attempted and refused, rather than skipped: the row below is the consequence of a
  // vendor that would not act, and an implementation that never asked would leave the same row.
  expect(asksMade()).toEqual([
    `ensureAuthConfig:${probedToolkit}/fields`,
    `connectWithFields:${probedToolkit}/${askerId}`,
    `revokeAccount:${madeAccountId}`,
  ]);
  expect(vendorHolds).toEqual([madeAccountId]);

  const [row] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(row).toMatchObject({
    toolkit: probedToolkit,
    userId: askerId,
    verified: false,
  });
  // No date on a claim nobody made, which is the pair `recordBrokeredConnection` writes together.
  expect(row.verifiedAt).toBeNull();

  // AND THE TRAIL CARRIES THE STATE, not just the person who happened to be at the screen. This is
  // the one outcome here that leaves a live account nobody can reach through this deployment, and
  // an operator reading the trail later is exactly who needs to find it — so the refusal being
  // thorough is not a substitute for a row.
  const checked = recordedOfType("mcp.connection_verified");
  expect(checked).toHaveLength(1);
  expect(checked[0].payload).toMatchObject({
    actor: askerId,
    // The action that was TRIED, which is the whole of what separates this row from the unchecked
    // one: both say `verified: false`, and only the name says the vendor was asked and said no.
    action: probeAction,
    verified: false,
  });
  // And the key is in none of it, on the path that fails as much as on the one that works.
  expect(JSON.stringify(checked)).not.toContain(typedKey);
});

/**
 * A FAILED KEY TAKES DOWN THE ACCOUNT IT MADE AND NOTHING BESIDE IT.
 *
 * CRITERION. With the vendor holding a second account this deployment has no row for, the undo
 * names the id it was just handed, and the other account is still there afterwards.
 *
 * REASON. The drift case, and it is ordinary rather than exotic: an account made in Composio's own
 * dashboard, or one whose row this deployment lost, is a WORKING connection the vendor holds and
 * nothing here names. `revoke` sweeps every account a person holds for an app, so an undo written
 * that way ends somebody's working connection because somebody mistyped a key — a second person's
 * access destroyed by the first one's typo, by a call made to clean up after a check. The id is the
 * whole of what makes the narrow call narrow, and it is the only thing a test can hold it to.
 */
test("a failed key takes down the account it made and nothing beside it", async () => {
  useAnsweringClient({
    execute: async ({ slug }) => {
      reached.push(slug);
      return {
        data: {},
        error: "Invalid API key provided.",
        successful: false,
      };
    },
  });
  await addProbedApp();
  // Seeded before the connect, so it is an account that predates this act rather than one of its
  // making — which is the whole of what a sweep cannot tell apart.
  vendorHolds.push(strandedAccountId);

  await expect(
    store.connectBrokeredWithFields({
      toolkit: probedToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).rejects.toThrow();

  // The working account survived the failure of somebody else's key.
  expect(vendorHolds).toEqual([strandedAccountId]);
  // And the sweep was never asked for, which is the other half of the same statement: a `revoke`
  // here would have emptied the list above.
  expect(asksMade()).toEqual([
    `ensureAuthConfig:${probedToolkit}/fields`,
    `connectWithFields:${probedToolkit}/${askerId}`,
    `revokeAccount:${madeAccountId}`,
  ]);
});

/**
 * AN APP WITH NO PROBE CONNECTS UNVERIFIED RATHER THAN NOT AT ALL.
 *
 * CRITERION. Where the app publishes nothing safe to call, the connection is made, the row says
 * unverified with no date, `probe` comes back null, and no action ran at the vendor.
 *
 * REASON. Null from the chooser is an answer and not a failure — most key-based apps publish some
 * argument-less read and PostHog publishes none — so a verification that refused what it could not
 * check would make this deployment's ability to connect an app depend on that app's action list.
 *
 * AND `probe: null` IS WHAT KEEPS THAT ROW'S SENTENCE TRUE. `verified: false` now has three
 * possible meanings, and only one of them is this one: nothing was tried. Where a probe ran and
 * failed the same flag means the key is bad, and a browser inferring a sentence from the flag alone
 * would tell one of those two people the opposite of what happened. The audit row carries the same
 * distinction under `action`.
 */
test("an app with no probe connects unverified rather than not at all", async () => {
  useAnsweringClient();
  await addProbedApp({ withProbe: false });

  expect(
    await store.connectBrokeredWithFields({
      toolkit: probedToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).toEqual({ connected: true, verified: false, probe: null });

  // Nothing was called, which is what "nothing to try" means at the vendor.
  expect(reached).toEqual([]);
  // And nothing was taken back either: there was no failure to undo.
  expect(vendorHolds).toEqual([madeAccountId]);

  const [row] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(row.verified).toBe(false);
  expect(row.verifiedAt).toBeNull();

  const checked = recordedOfType("mcp.connection_verified");
  expect(checked).toHaveLength(1);
  expect(checked[0].payload).toMatchObject({
    actor: askerId,
    // Null rather than a name, for the same reason the response field is: the trail must be able to
    // say that no action ran, which "verified: false" alone cannot.
    action: null,
    verified: false,
  });
});

/**
 * A KEY THAT WORKS IS RECORDED VERIFIED, WITH THE ACTION IT WAS CHECKED WITH.
 *
 * CRITERION. When the probe answers, the row is verified with a date, the response names the action
 * that was called, the trail carries the same name, and what reached the vendor was that action, in
 * the asking person's account, at the version the listing recorded, WITH NO ARGUMENTS.
 *
 * REASON. The three failure tests above all end in a refusal, so every one of them would pass
 * against a probe that could never succeed — and the transport refuses before dialling unless the
 * call carries the version its listing recorded, which is exactly the shape a probe sent with a
 * bare `{}` would have. Without this test "the key was checked and it passed" is a state the suite
 * never reaches, and a verification that fails for this deployment's own reason would look from
 * every other test here exactly like a vendor saying the key is bad — while withdrawing the account
 * of every person who typed a good one.
 *
 * THE ARGUMENTS ARE ASSERTED EMPTY, because that is half of what makes this the one vendor call in
 * the deployment that runs outside `callTool`'s grant, policy and content checks. The version
 * travels under the transport's reserved key and is stripped before anything reaches Composio, so
 * what the vendor is handed is an action chosen from recorded metadata and nothing else.
 */
test("a key that works is recorded verified, with the action it was checked with", async () => {
  const sent: {
    slug: string;
    userId: string;
    version: string;
    args: unknown;
  }[] = [];
  useAnsweringClient({
    execute: async (call, args) => {
      reached.push(call.slug);
      sent.push({
        slug: call.slug,
        userId: call.userId,
        version: call.version,
        args,
      });
      return answered;
    },
  });
  await addProbedApp();
  // Taken before the call, so the comparison below is against a moment that cannot postdate the
  // write. Both this and the column are written in this process, so no clock but one is involved.
  const before = new Date();

  expect(
    await store.connectBrokeredWithFields({
      toolkit: probedToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).toEqual({ connected: true, verified: true, probe: probeAction });

  expect(sent).toEqual([
    {
      slug: probeAction,
      // The person's own account, which is the only account a probe could be a check on.
      userId: askerId,
      version: probeVersion,
      args: {},
    },
  ]);
  // The account stands, because there was nothing to undo.
  expect(vendorHolds).toEqual([madeAccountId]);
  expect(asksMade()).toEqual([
    `ensureAuthConfig:${probedToolkit}/fields`,
    `connectWithFields:${probedToolkit}/${askerId}`,
  ]);

  const [row] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(row.verified).toBe(true);
  expect(row.verifiedAt).not.toBeNull();
  expect(row.verifiedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());

  const checked = recordedOfType("mcp.connection_verified");
  expect(checked).toHaveLength(1);
  expect(checked[0].payload).toMatchObject({
    actor: askerId,
    action: probeAction,
    verified: true,
  });
  // The row names the person and no Bot, which is what `mcp.connection_verified` documents: nothing
  // ran on a Bot's behalf here, and borrowing one to make the row look uniform would be a lie.
  expect(JSON.stringify(checked[0].payload)).not.toContain(botId);
  /*
   * BOTH ROWS THIS METHOD WRITES COME BACK UNDER ONE ID, which is the question anybody asks this
   * trail: what happened to this person's access to this app. The two used to be filed under
   * different keys — the connection under the app slug, the verification under the server row id —
   * so a reader got half the story depending on which one they asked with, and neither half said
   * it was a half. {@link probedId} is named first because it is the id that was used and the one
   * a regression puts back; the set is asked after it, because the criterion is a single query
   * finding all of these rows and that is true of no other id either.
   */
  const forApp = events.filter(
    (event) =>
      event.eventType === "mcp.connection_verified" ||
      event.eventType === "mcp.account_connected",
  );
  expect(forApp).toHaveLength(2);
  expect(forApp.map((event) => event.targetId)).not.toContain(probedId);
  expect(new Set(forApp.map((event) => event.targetId))).toEqual(
    new Set([probedToolkit]),
  );
  // And the key itself is in none of it, the promise every write on this path keeps.
  expect(JSON.stringify(checked)).not.toContain(typedKey);
});

/**
 * The account a re-check runs against, which is one that ALREADY EXISTS.
 *
 * Inserted by hand rather than made through `connectBrokeredWithFields`, and that is the whole
 * point of the fixture: a re-check is not a connect. It is pressed days later, by somebody who has
 * just fixed a key at the vendor, against a row and an account that were already here — so a test
 * that reached this state by connecting would be asserting about a row this run had just written
 * with a probe of its own, and could not tell a method that re-checks from one that reconnects.
 *
 * `verifiedAt` IS A DATE FROM THE PAST WHERE ONE IS ASKED FOR, so "the timestamp was left alone" is
 * an assertion about a value rather than about whether a column is null.
 */
async function holdProbedApp(verifiedAt: Date | null = null) {
  await database.insert(composioConnections).values({
    toolkit: probedToolkit,
    userId: askerId,
    verified: verifiedAt !== null,
    verifiedAt,
  });
  // The vendor's side of that row: an account it is holding before this run's act, which is what
  // makes "nothing was withdrawn" an assertion about what Composio still has afterwards.
  vendorHolds.push(madeAccountId);
}

/**
 * A RE-CHECK THAT ANSWERS RECORDS THE CONNECTION VERIFIED, WITH THE ACTION IT WAS CHECKED WITH.
 *
 * CRITERION. Against a connection that already exists, the probe runs in the asking person's
 * account, the row is written verified with a fresh date, the answer carries that date and the name
 * of the action, and the trail records the same check.
 *
 * REASON. This is the button somebody presses having just rotated a key that had stopped working.
 * Nothing else in the product will ever re-check it: Composio accepts a key once and never tests it
 * again, and every other path that writes `verified` is a connect or a consent — so without this
 * the row's sentence is frozen at whatever was true the day the key was typed, and a person who has
 * fixed their key has no way to make this deployment agree.
 *
 * AND IT IS A BUTTON AND NEVER A PAGE-LOAD EFFECT, which is why nothing here calls it twice. The
 * call is spent against the VENDOR'S rate limit on the person's own account, so verifying on every
 * render would burn somebody's quota at Linear to redraw one word on a settings page.
 */
test("a re-check that answers records the connection verified, with the action it was checked with", async () => {
  const sent: {
    slug: string;
    userId: string;
    version: string;
    args: unknown;
  }[] = [];
  useAnsweringClient({
    execute: async (call, args) => {
      reached.push(call.slug);
      sent.push({
        slug: call.slug,
        userId: call.userId,
        version: call.version,
        args,
      });
      return answered;
    },
  });
  await addProbedApp();
  await holdProbedApp();
  // Taken before the call, so the comparison below is against a moment that cannot postdate the
  // write. Both this and the column are written in this process, so no clock but one is involved.
  const before = new Date();

  const answer = await store.recheckBrokeredConnection({
    toolkit: probedToolkit,
    userId: askerId,
  });

  expect(answer.verified).toBe(true);
  expect(answer.probe).toBe(probeAction);
  expect(new Date(answer.verifiedAt ?? "").getTime()).toBeGreaterThanOrEqual(
    before.getTime(),
  );

  // The same call the connect path makes, in the same shape: the person's own account, the version
  // the listing recorded, and no arguments at all.
  expect(sent).toEqual([
    { slug: probeAction, userId: askerId, version: probeVersion, args: {} },
  ]);

  const [row] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(row.verified).toBe(true);
  expect(row.verifiedAt?.toISOString()).toBe(answer.verifiedAt);

  // NOTHING WAS CONNECTED AND NOTHING WAS WITHDRAWN. The only ask in this run is the one the app's
  // own enablement made; a re-check that reached `connectWithFields` would be making a second
  // account for somebody who has one, and one that reached either revoke would be ending the
  // account it was asked to check.
  expect(asksMade()).toEqual([`ensureAuthConfig:${probedToolkit}/fields`]);
  expect(vendorHolds).toEqual([madeAccountId]);

  const checked = recordedOfType("mcp.connection_verified");
  expect(checked).toHaveLength(1);
  expect(checked[0].targetId).toBe(probedToolkit);
  expect(checked[0].payload).toMatchObject({
    actor: askerId,
    action: probeAction,
    verified: true,
  });
});

/**
 * A PROBE THAT RAN AND FAILED IS A FAILURE, AND NOT AN ANSWER SAYING "NOT VERIFIED".
 *
 * CRITERION. When the vendor rejects the key, the call raises with Composio's own sentence in it,
 * the row is left standing and written unverified, the account at the vendor is untouched, and the
 * trail carries the action that was tried.
 *
 * REASON. `verified: false` is the same flag an app that publishes nothing safe to call produces,
 * so a re-check that RETURNED it would hand the row two states it cannot tell apart — and the one
 * it would get wrong is the person who has just fixed their key and pressed the button. The row
 * would drop the Re-check button in exactly the state somebody needs it, while telling them nothing
 * was ever checked. A raise carries the vendor's sentence, which is the whole of what they can act
 * on.
 *
 * AND THE ACCOUNT STAYS, which is the line between this and a connect. `connectBrokeredWithFields`
 * withdraws the account it just made, because it made it and the key is bad — the undo is of its own
 * act. Here the account predates the press by days and the person did not ask to disconnect
 * anything; their key is wrong, and taking their account away to tell them so would destroy the
 * thing they are trying to repair.
 */
test("a re-check whose probe fails raises rather than answering unverified", async () => {
  useAnsweringClient({
    execute: async ({ slug }) => {
      reached.push(slug);
      // The vendor reporting a failure in a 200, which is how Composio says a credential is wrong.
      return {
        data: {},
        error: "Invalid API key provided.",
        successful: false,
      };
    },
  });
  await addProbedApp();
  await holdProbedApp();

  await expect(
    store.recheckBrokeredConnection({
      toolkit: probedToolkit,
      userId: askerId,
    }),
  ).rejects.toThrow(/Invalid API key provided\./);

  // The key was spent on the action the chooser picked, and on nothing else.
  expect(reached).toEqual([probeAction]);
  // The account is still the vendor's to see, and nothing here asked it to be otherwise.
  expect(vendorHolds).toEqual([madeAccountId]);
  expect(asksMade()).toEqual([`ensureAuthConfig:${probedToolkit}/fields`]);

  // The row SURVIVES the failure — it is their key that is wrong, not their account — and it stops
  // claiming a verification, with no date left standing on a claim nobody is making.
  const [row] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(row).toMatchObject({ toolkit: probedToolkit, verified: false });
  expect(row.verifiedAt).toBeNull();

  // AND THE TRAIL SAYS WHICH ACTION WAS TRIED, which is what separates this row from an app that
  // had nothing to try: both say `verified: false`, and only the name says the vendor was asked.
  const checked = recordedOfType("mcp.connection_verified");
  expect(checked).toHaveLength(1);
  expect(checked[0].payload).toMatchObject({
    actor: askerId,
    action: probeAction,
    verified: false,
  });
});

/**
 * AN APP WITH NOTHING TO PROBE COMES BACK SAYING SO, AND THE ROW IS LEFT EXACTLY AS IT WAS.
 *
 * CRITERION. Where the app publishes no action a probe may use, no call is made, the answer carries
 * `probe: null`, the row's `verified` and `verified_at` are the values they already held, and
 * nothing reaches the trail.
 *
 * REASON. Null from the chooser is an ordinary answer — most key-based apps publish some
 * argument-less read and PostHog publishes none — and `probe: null` is what tells the row that
 * nothing was tried, which `verified: false` alone cannot.
 *
 * THE UNTOUCHED ROW IS THE HALF THAT WOULD BE EASY TO GET WRONG. Writing `false` here because the
 * check produced no evidence would take the date off a connection that was verified at a consent
 * screen — a press of a button erasing a fact nothing else in this deployment records, and telling
 * the person their working connection is now unchecked. A check that could try nothing has learned
 * nothing, and the honest write is no write at all.
 */
test("an app with nothing to probe leaves the verification exactly as it was", async () => {
  useAnsweringClient();
  await addProbedApp({ withProbe: false });
  // Verified a fortnight ago, at a consent screen or by a probe this app has since stopped
  // publishing. Either way it is a fact, and this press must not be what takes it off the row.
  const earned = new Date("2026-08-30T09:00:00.000Z");
  await holdProbedApp(earned);

  expect(
    await store.recheckBrokeredConnection({
      toolkit: probedToolkit,
      userId: askerId,
    }),
  ).toEqual({
    verified: true,
    verifiedAt: earned.toISOString(),
    probe: null,
  });

  // Nothing was called, which is what "nothing to try" means at the vendor.
  expect(reached).toEqual([]);
  const [row] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(row.verified).toBe(true);
  expect(row.verifiedAt?.toISOString()).toBe(earned.toISOString());
  // And nothing is on the trail: `mcp.connection_verified` records an account exercised with a real
  // call, and no call was made. A row filed for a press that changed nothing would make the one
  // event that means "a key was tried" also mean "somebody looked at a page".
  expect(recordedOfType("mcp.connection_verified")).toEqual([]);
});

/**
 * A RE-CHECK WITH NO CONNECTION TO CHECK REFUSES, AND MAKES NEITHER A ROW NOR A CALL.
 *
 * CRITERION. Where this person holds no account for the app, the call raises, no row is written,
 * and nothing is spent at the vendor.
 *
 * REASON. The single writer this path records through is an UPSERT, so a re-check that probed
 * first and wrote the answer would INSERT a connection for somebody who has none — a row that is
 * the whole of the gate every later brokered call passes through, created by a button that claims
 * to check one. And the probe itself would be spent on an account the vendor does not have, coming
 * back as "no connected account found": a sentence about this deployment's own state, shown to
 * somebody as though their key had been rejected.
 */
test("a re-check with no connection refuses rather than making one", async () => {
  useAnsweringClient();
  await addProbedApp();

  await expect(
    store.recheckBrokeredConnection({
      toolkit: probedToolkit,
      userId: askerId,
    }),
  ).rejects.toThrow();

  expect(await connectedToolkitsFor(askerId)).toEqual([]);
  expect(reached).toEqual([]);
  expect(recordedOfType("mcp.connection_verified")).toEqual([]);
});
