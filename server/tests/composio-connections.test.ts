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
import { accessFor } from "../src/plugins/access";
import type { ComposioBroker } from "../src/plugins/broker";
import type { ComposioActions, ComposioResult } from "../src/plugins/composio";
import { useComposioClient } from "../src/plugins/composio";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
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
 * `disconnectBrokered` has its coverage in `plugin-store.integration.test.ts`, which is why the two
 * here are described throughout as the two ACTS AN ADMINISTRATOR PERFORMS and never as all the ways
 * a connection can end. It is asked about here in one place only — the test at the foot of this
 * file, where what the trail may claim is decided by the app's recorded scheme, and so needs an app
 * that arrived the way Add makes one arrive and a key that arrived the way a person types one.
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
 * A SECOND ROW AT {@link toolkit}'S OWN URL, which the schema permits and nothing in it prevents.
 *
 * `mcp_servers.url` carries no unique index — the only one in that schema file is `skills_slug_key`
 * on `skills.slug` — so two rows may perfectly well name one app, and a development database
 * reaches that state by the most ordinary route there is: a fixture row at `gmail` standing beside
 * the `composio-gmail` an administrator really added. Every read that resolves a connection to a
 * server row THROUGH THE URL therefore has to say which of them it means.
 *
 * NAMED TO SORT BEFORE {@link toolkit} AND INSERTED AFTER IT, which is the whole of why the
 * assertion is worth making. `duplicate-` precedes `revocable-`, so the row the rule picks is not
 * the row an unordered scan meets first, and a listing that answered out of the scan would answer
 * something else.
 */
const twinId = `duplicate-${suite}`;
/**
 * THE SAME SHAPE ON THE PROBED APP, recorded under a scheme that app is not connected with.
 *
 * The three reads that decide whether an app is one this deployment holds a key for are keyed on
 * the url too, and they answer out of ONE row's `auth_scheme` — so two rows at one url is two
 * possible answers to "may this be re-checked", and the wrong one refuses a live key connection in
 * words about a sign-in screen nobody used.
 *
 * NAMED TO SORT AFTER {@link probedId} AND INSERTED BEFORE IT, the opposite way round from
 * {@link twinId} and for the same reason: `zz-` follows `composio-`, so the row the rule picks is
 * again not the one physically first, and the pre-fix reading and the post-fix one differ.
 */
const schemeTwinId = `zz-twin-${suite}`;
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
 * The app CONNECTED AND THEN DISCONNECTED ONCE PER SCHEME, which is what a revocation claim needs.
 *
 * Its own name rather than {@link enabledToolkit}'s, for {@link rekeyedToolkit}'s reason and not a
 * different one. The disconnect test below connects with a key FOR REAL, so it files an
 * `mcp.account_connected` row of its own — and the secrecy test, which owns {@link enabledToolkit},
 * asserts there is EXACTLY ONE such row under the app it connects. `audit_events` is append-only
 * and no cleanup here can reach it, so sharing a slug had each of the two reading the other's row,
 * and the pair passed or failed on whichever order the runner happened to walk them in. It passed,
 * on declaration order alone; moving the disconnect test above the secrecy test answered
 * `Received length: 2`.
 */
const reschemedToolkit = `reschemed-${suite}`;
/** What `addBrokeredApp` spells that app's row, so {@link clean} can take it back. */
const reschemedId = `composio-${reschemedToolkit}`;
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
/**
 * THE PROBED APP UNDER A ROW ID THAT IS NOT `composio-` AND ITS SLUG, which is a legal row.
 *
 * Every other brokered fixture here spells the id the way `addBrokeredApp` composes it, and that is
 * precisely the coincidence a lookup keyed on the id rides on: {@link renamedId} exists for the
 * same reason on the removal side, and this is its counterpart on the CHECK side. `mcp_servers.id`
 * is a display name — an operator renames a row, a fixture predates the convention, an app arrives
 * by some other path — and the slug in the url is what decides which app a call is against.
 */
const renamedProbedToolkit = `renamedprobe-${suite}`;
/** Its row's id, deliberately unrelated to its slug, so a composed id cannot reach it. */
const renamedProbedId = `display-name-${suite}`;
/** The one action that app publishes: a read, asking for nothing, at a recorded version. */
const renamedProbeAction = "RENAMEDPROBE_GET_ME";
/**
 * A SECOND, UNRELATED APP sitting exactly where a composed id would look for the first.
 *
 * It is an ordinary app of its own — its slug and its row id are spelled the way `addBrokeredApp`
 * spells them for {@link renamedProbedToolkit}'s name, which is the collision. Its action is what a
 * probe keyed on a composed id would spend somebody else's key on.
 */
const decoyToolkit = `decoy-${suite}`;
const decoyId = `composio-${renamedProbedToolkit}`;
const decoyAction = "DECOY_GET_SOMETHING_ELSE";
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
/**
 * THE APP WHOSE ROW IS ALREADY TAKEN, which is the one shape the two add paths can collide on.
 *
 * `addBrokeredApp` mints `composio-<slug>` and `addCustomServer` takes whatever id an administrator
 * types, so both can be made to write the SAME row — and a row half-written by each is neither app
 * nor endpoint. Its own name rather than {@link enabledToolkit}'s because the tests below leave the
 * row in states no other test here wants to inherit: an endpoint somebody typed, at an id Add
 * mints.
 */
const collidedToolkit = `collided-${suite}`;
/** What `addBrokeredApp` spells that app's row, which is also the id the custom add aims at. */
const collidedId = `composio-${collidedToolkit}`;
/**
 * AN APP CONNECTED AT A CONSENT SCREEN, which is the kind `connectBrokeredWithFields` must refuse.
 *
 * Its own name rather than a scheme swapped onto {@link enabledToolkit}, for {@link rekeyedToolkit}'s
 * reason: the app is enabled for real so that the `OAUTH2` the refusal turns on is the word
 * `addBrokeredApp` records rather than this file's idea of it, and a slug shared with a test that
 * connects for real would have each reading the other's append-only trail rows.
 */
const consentToolkit = `consented-${suite}`;
/** What `addBrokeredApp` spells that app's row, so {@link clean} can take it back. */
const consentId = `composio-${consentToolkit}`;
/** Every app this run owns, which is the scope of every read and every delete below. */
const ownedToolkits = [
  toolkit,
  secondToolkit,
  enabledToolkit,
  rekeyedToolkit,
  reschemedToolkit,
  probedToolkit,
  renamedProbedToolkit,
  decoyToolkit,
  collidedToolkit,
  consentToolkit,
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

/**
 * WHICH CREDENTIAL THE VENDOR WAS TOLD IT WAS BEING HANDED, which is a gate and not a label.
 *
 * `connectWithFields` takes an `authScheme` beside the values, and this stub used to drop it on the
 * floor: a hardcoded wrong word in the store left all fifty-two tests in this file green. That word
 * is what Composio creates the account under, so it decides which boxes the person was asked to
 * fill in and what the vendor does with what they typed — a key sent as a BASIC password is a
 * credential attached to a flow it cannot work in, and the first tool call is what finds out.
 *
 * READ OFF THE APP'S OWN ROW rather than off the request, which is the other half of what this
 * records: `brokeredAppScheme` resolves the app by url, and a url may be named by more than one
 * `mcp_servers` row. So the value here also says WHICH of those rows answered.
 */
const schemesSent: string[] = [];

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
    // And under which scheme, which is the half of this call the stub used to drop. See
    // {@link schemesSent}: it is what the account is created as, and it is read off a row.
    schemesSent.push(request.authScheme);
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
        reschemedId,
        probeAppId,
        probedId,
        renamedProbedId,
        decoyId,
        twinId,
        schemeTwinId,
        collidedId,
        consentId,
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
        reschemedId,
        probeAppId,
        probedId,
        renamedProbedId,
        decoyId,
        twinId,
        schemeTwinId,
        collidedId,
        consentId,
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
 * The same app under a row id that is NOT its slug, with one safe read to spend a key on.
 *
 * INSERTED BY HAND RATHER THAN ENABLED, which is the one thing it cannot borrow from
 * {@link addProbedApp}: `addBrokeredApp` composes the id itself, so an app enabled through it can
 * never have the divergence these two tests are about. Everything the checked paths read off the
 * row is spelled here the way Add would spell it — `provenance` composio, and the `auth_scheme` a
 * key-based app is created as, which is what the re-check's own gate admits.
 */
async function addRenamedApp() {
  await database.insert(mcpServers).values({
    id: renamedProbedId,
    title: "Renamed Probed App",
    vendor: "Composio",
    url: `composio://${renamedProbedToolkit}`,
    provenance: "composio",
    authScheme: "API_KEY",
  });
  await database.insert(mcpTools).values({
    serverId: renamedProbedId,
    name: renamedProbeAction,
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
  schemesSent.length = 0;
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

  // The name, which is what this test is about; the version beside it is asserted by the test below
  // that is about the version.
  expect((await store.probeActionFor(probeAppId))?.name).toBe(
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
 * AND AN ACTION WITH NO RECORDED VERSION IS NOT A CANDIDATE, ON THE READ AS WELL AS ON THE PROBE.
 *
 * CRITERION. Where the only safe read this deployment recorded for an app carries no version, the
 * chooser answers null — and the connections listing, which derives its `probe` from that same
 * chooser, says null too. Neither spends a call at the vendor.
 *
 * REASON. Composio refuses an execution without a specific version, so the transport refuses before
 * dialling where none travels with the call: an action recorded with no version is an action
 * nothing here can call, which is the whole of what "can this be used to check a key" asks. While
 * that condition lived in the PROBE and not in the CHOOSER the two disagreed, and the listing was
 * the one that lied. Connecting such an app wrote `verified: false` and answered `probe: null` —
 * the honest pair, "the key was accepted without being checked" — and then a reload derived a NAMED
 * probe beside the same `false` and drew the worst sentence this feature has: your key was checked
 * and rejected, and the account it was checked in is still standing at Composio. For a person whose
 * key has never been tried at all, every clause of that is false.
 *
 * BOTH HALVES IN ONE TEST, because the point is that they AGREE. Asserting either alone would leave
 * the pair free to come apart again in the direction that was wrong the first time.
 */
test("an app whose only safe read has no recorded version has no probe", async () => {
  useAnsweringClient();
  await addProbedApp({ withProbe: false });
  await database.insert(mcpTools).values({
    serverId: probedId,
    name: probeAction,
    description: "Says who the key belongs to, at no version anybody recorded.",
    effect: "read",
    version: null,
  });

  expect(await store.probeActionFor(probedId)).toBeNull();

  await database
    .insert(composioConnections)
    .values({ toolkit: probedToolkit, userId: askerId, verified: false });

  const listed = await store.brokeredConnectionsFor(askerId);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.serverId).toBe(probedId);
  expect(listed[0]?.probe).toBeNull();
  // And nothing was spent learning it: both answers come out of recorded metadata.
  expect(reached).toEqual([]);
});

/**
 * AND A VERSIONLESS ACTION IS PASSED OVER RATHER THAN ENDING THE SEARCH.
 *
 * CRITERION. Given an app whose identity read carries no version and whose other safe read does,
 * the chosen probe is the one that carries a version — even though the versionless one is the shape
 * {@link IDENTITY_ACTION} prefers and sorts first.
 *
 * REASON. The version belongs in the same filter as the effect and the required inputs because it
 * answers the same question — can this action be called at all — and a filter is what lets the next
 * candidate be considered. The condition used to live downstream of the choice, where a versionless
 * winner short-circuited the whole app to "there is nothing here to try" even when the app publishes
 * another read this deployment could have called. Passing over it is strictly better: an app that
 * can be checked gets checked, and the null answer is kept for an app that really has nothing.
 */
test("the chooser passes over a versionless read for the one it could call", async () => {
  await database.insert(mcpServers).values({
    id: probeAppId,
    title: "Thin Listing",
    vendor: "Composio",
    url: `composio://${probeAppId}`,
    provenance: "composio",
  });
  await database.insert(mcpTools).values([
    {
      serverId: probeAppId,
      // Sorts first, is the preferred shape, and carries nothing to call it at.
      name: "THIN_GET_ME",
      description: "Says who the key belongs to.",
      effect: "read",
      version: null,
    },
    {
      serverId: probeAppId,
      name: "THIN_LIST_PROJECTS",
      description: "Lists the projects.",
      effect: "read",
      version: "20260903_00",
    },
  ]);

  expect(await store.probeActionFor(probeAppId)).toEqual({
    name: "THIN_LIST_PROJECTS",
    version: "20260903_00",
  });
});

/**
 * AND A ROW THAT SAYS READ AND ALSO SAYS DESTRUCTIVE IS NOT A READ THIS DEPLOYMENT WILL SPEND.
 *
 * CRITERION. Given an app whose alphabetically first argument-less READ is also marked destructive,
 * the chosen probe is the plain read that sorts after it — and an app whose ONLY read is marked
 * destructive has no probe at all.
 *
 * REASON. `effect` and `destructive` are two columns because the vendor can say two things, and the
 * chooser checks both rather than treating either as implied by the other. The pair is the vendor's
 * own words: `effectOf` answers `read` where Composio sent `readOnlyHint`, and `destructive` is
 * recorded where it sent `destructiveHint` — which a vendor is free to send together, and which
 * together describe an action nobody should call unasked on a stranger's account to find out
 * whether their key works. Dropping the second clause type-checks, leaves `effect !== "read"`
 * standing as a guard that still looks complete, and was invisible to every test here: the whole
 * probe-choice suite above is written on rows that leave `destructive` at its column default of
 * false, so the clause could be deleted with nothing to say so.
 *
 * BOTH HALVES, because either alone leaves the fault reachable from the other side. An app with a
 * safe alternative proves the destructive row is PASSED OVER rather than merely not-first; an app
 * with none proves it is not fallen back to when the search finds nothing else.
 */
test("the probe skips a read the vendor also calls destructive", async () => {
  await database.insert(mcpServers).values({
    id: probeAppId,
    title: "Two Reads",
    vendor: "Composio",
    url: `composio://${probeAppId}`,
    provenance: "composio",
  });
  await database.insert(mcpTools).values([
    {
      serverId: probeAppId,
      // Sorts first, asks for nothing, and Composio itself says calling it destroys something.
      name: "APP_ARCHIVE_EVERYTHING",
      description: "Archives the lot.",
      effect: "read",
      destructive: true,
      version: "20260903_00",
    },
    {
      serverId: probeAppId,
      name: "APP_LIST_PROJECTS",
      description: "Lists the projects.",
      effect: "read",
      destructive: false,
      version: "20260903_00",
    },
  ]);

  expect(await store.probeActionFor(probeAppId)).toEqual({
    name: "APP_LIST_PROJECTS",
    version: "20260903_00",
  });

  // And with the safe alternative gone there is nothing to fall back to: the destructive row is not
  // a candidate, rather than a last resort.
  await database
    .delete(mcpTools)
    .where(
      and(
        eq(mcpTools.serverId, probeAppId),
        eq(mcpTools.name, "APP_LIST_PROJECTS"),
      ),
    );

  expect(await store.probeActionFor(probeAppId)).toBeNull();
});

/**
 * AND WHERE SEVERAL READS SURVIVE, THE ONE THAT ASKS WHO THE KEY BELONGS TO IS PREFERRED.
 *
 * CRITERION. Given an app publishing two safe argument-less reads, the chosen probe is the identity
 * read — `..._GET_ME` here — even though the other sorts first and would be `safe[0]`.
 *
 * REASON. Every candidate that reaches this point is safe and callable, so the preference is not
 * about safety: it is about what the call MEANS when it comes back. An identity read answers "whose
 * account is this key" and therefore answers the question the check is actually asking; a listing
 * read answers "what is in this account", which an empty-but-valid account answers with nothing and
 * which a key scoped away from that resource can fail for a reason that is not the key. Removing
 * the preference leaves `safe[0]` — the alphabetical accident — and nothing above could see it,
 * because every app in those fixtures publishes at most one surviving read: with one candidate,
 * `identity ?? safe[0]` is the same value either way, so the ordering was asserted nowhere.
 *
 * THE NAMES ARE SORTED AGAINST THE PREFERENCE RATHER THAN WITH IT. `ZOO_GET_ME` sorts AFTER
 * `ZOO_ALL_ANIMALS`, so the expected answer is the one the fallback would not have produced — a
 * fixture where the identity read also happened to sort first would pass with the preference gone.
 */
test("the probe prefers the identity read over the read that sorts first", async () => {
  await database.insert(mcpServers).values({
    id: probeAppId,
    title: "Two Safe Reads",
    vendor: "Composio",
    url: `composio://${probeAppId}`,
    provenance: "composio",
  });
  await database.insert(mcpTools).values([
    {
      serverId: probeAppId,
      // Sorts first and is perfectly safe, which is what makes it the wrong answer rather than an
      // unsafe one: this is a test about which of two good candidates is chosen.
      name: "ZOO_ALL_ANIMALS",
      description: "Lists the animals.",
      effect: "read",
      version: "20260903_00",
    },
    {
      serverId: probeAppId,
      name: "ZOO_GET_ME",
      description: "Says who the key belongs to.",
      effect: "read",
      version: "20260903_00",
    },
  ]);

  expect(await store.probeActionFor(probeAppId)).toEqual({
    name: "ZOO_GET_ME",
    version: "20260903_00",
  });
});

/**
 * AND THE LISTING CARRIES THE ACTION THE CHECK ACTUALLY SPENT, WHICH IS WHAT SURVIVES A RELOAD.
 *
 * CRITERION. A brokered connection whose row records an action is listed with that action's name in
 * `probe` — and it is, EVEN WHERE THE APP NO LONGER PUBLISHES IT. Nothing is spent at the vendor to
 * find that out.
 *
 * REASON. `probe` was only ever a field of an ANSWER — to a key handed over, or to a re-check — so
 * a page that reloaded lost it, and the row fell back to the sentence that says a key was accepted
 * without being checked. For the worst state this feature has that sentence is FALSE: a named probe
 * beside `verified: false` means the check ran, the vendor refused the key, and the account it ran
 * in could not be withdrawn. The one person with a live account and a bad key behind it was told
 * nothing was wrong, and the Re-check button was taken away from them at the same moment — on the
 * page load where they would reach for it.
 *
 * WHICH IS RECORDED RATHER THAN DERIVED, and the de-listed app above is what makes that an
 * assertion instead of a wording. The field was once answered by the chooser, from the app's action
 * listing as it stood at the moment of the READ; the row's own verdict comes from the listing as it
 * stood at the moment of the CHECK, and an administrator's press of Refresh moves one and not the
 * other in either direction. Here the action the check spent has since left the app's listing —
 * Composio publishes what it publishes — and the connection still reports what was tried on it,
 * because that is what happened and no later listing can unhappen it.
 */
test("a listed brokered connection names the action it was checked with", async () => {
  useAnsweringClient();
  // The app WITHOUT the action, so the only place the name below can come from is the row.
  await addProbedApp({ withProbe: false });
  await database.insert(composioConnections).values({
    toolkit: probedToolkit,
    userId: askerId,
    verified: false,
    probeAction: probeAction,
  });

  const listed = await store.brokeredConnectionsFor(askerId);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.serverId).toBe(probedId);
  expect(listed[0]?.verified).toBe(false);
  // The name, and not merely "something": it is the name that separates a key the vendor refused
  // from a connection nothing was ever tried on.
  expect(listed[0]?.probe).toBe(probeAction);
  // And the chooser has nothing to offer, which is what makes the line above about the record.
  expect(await store.probeActionFor(probedId)).toBeNull();
  // Nothing was spent finding any of that out: both answers are read out of this deployment's own
  // tables.
  expect(reached).toEqual([]);
});

/**
 * AND A CONNECTION NOTHING WAS EVER SPENT ON IS LISTED AS EXACTLY THAT.
 *
 * CRITERION. Where the row records no action, the listed connection's `probe` is null rather than a
 * name.
 *
 * REASON. Null is the first of the states and the only one that is a fact about the CHECK rather
 * than about the key: nothing was tried. Most key-based apps in the live catalogue publish some
 * argument-less read and PostHog publishes none, so a connection made to such an app is honestly
 * unchecked and stays so. A listing that could not say null would leave the screen unable to tell
 * that apart from a refused key, which is the distinction the whole field exists for — and it would
 * draw the accusation written for a bad key over somebody whose key was never tried.
 */
test("a listed brokered connection nothing was spent on says there is no probe", async () => {
  useAnsweringClient();
  await addProbedApp({ withProbe: false });
  await database
    .insert(composioConnections)
    .values({ toolkit: probedToolkit, userId: askerId, verified: false });

  const listed = await store.brokeredConnectionsFor(askerId);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.serverId).toBe(probedId);
  expect(listed[0]?.probe).toBeNull();
});

/**
 * AND AN APP THAT LATER STARTS PUBLISHING ONE DOES NOT ACCUSE A KEY NOBODY EVER TRIED.
 *
 * CRITERION. A key connected to an app that published nothing safe to spend it on is listed with a
 * null probe; the app's action listing then gains a safe versioned read, the chooser names it from
 * that moment on, and the SAME connection is still listed with a null probe.
 *
 * REASON. `verified` is a fact about a check made against the listing as it stood THEN; a probe
 * derived on read is a fact about the listing as it stands NOW, and nothing holds the two together.
 * `POST /servers/:id/refresh` is a generic administrator's route keyed on a server id, and
 * `composio-<slug>` is a server id, so a brokered app's actions are re-listed by an ordinary press
 * of Refresh — which is exactly what the transport's own comment tells an operator to press when an
 * action appears, or when one it had already listed gains the version that makes it callable. The
 * instant that happened, a row honestly recording "your key was accepted without being checked"
 * began reading as a NAMED probe beside `verified: false`, and the page drew the worst sentence
 * this feature has: the key was checked and rejected, the account it ran in still stands, disconnect
 * it. Every clause of that is false for somebody whose key was never tried, and it tells them to
 * take down a connection that works — on every page load until they press Re-check.
 *
 * WHICH IS WHY THE COLUMN EXISTS. The pair is a record of the check that was made, written by the
 * one writer that knows what it spent, and no metadata arriving afterwards can talk a listing out
 * of it. The chooser is asked in the same breath below, so this is a test about the record rather
 * than a test about an app that still has nothing to publish.
 */
test("an action listed after the fact does not rewrite what a key was checked with", async () => {
  useAnsweringClient();
  await addProbedApp({ withProbe: false });

  expect(
    await store.connectBrokeredWithFields({
      toolkit: probedToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).toEqual({ connected: true, verified: false, probe: null });

  // THE REFRESH, as its only lasting effect: the app's actions re-listed, now carrying a read the
  // chooser will take. Inserted directly for {@link addProbedApp}'s reason — nothing here is about
  // how a listing turns Composio's tags into an effect.
  await database.insert(mcpTools).values({
    serverId: probedId,
    name: probeAction,
    description: "Says who the key belongs to.",
    effect: "read",
    version: probeVersion,
  });

  const listed = await store.brokeredConnectionsFor(askerId);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.serverId).toBe(probedId);
  expect(listed[0]?.verified).toBe(false);
  // Still null, because still nothing was ever spent on this key.
  expect(listed[0]?.probe).toBeNull();
  // While the chooser now names one, which is the whole of what changed and the reason the two
  // answers have to come from two different questions.
  expect((await store.probeActionFor(probedId))?.name).toBe(probeAction);
  // And no call was made to find any of that out.
  expect(reached).toEqual([]);
});

/**
 * AND WHETHER THERE IS ANYTHING TO CHECK TODAY IS ANSWERED BESIDE IT, NEVER OUT OF IT.
 *
 * CRITERION. The connection of the test above — a key the deployment spent nothing on, under an app
 * that has since started publishing a safe versioned read — is listed with `probe` still null AND
 * `checkable` true. Nothing is spent at the vendor to find that out either.
 *
 * REASON. THIS IS THE DEADLOCK THE RECORDED COLUMN CREATED, and it is the exact price of the fix
 * above. `probe` became a record so that a refresh could not accuse a key nobody had tried; the
 * settings page's Re-check button went on reading it, and that button asks a different question —
 * not "what did the check spend" but "is there anything to spend now". The two answers agreed while
 * the field was derived and part company the moment it is stored, in one direction that does not
 * recover: a key connected to an app with nothing to try reads null FOR GOOD, the button stays
 * withheld however many actions the app later publishes, and pressing that button is the only thing
 * in the product that could ever record an action on the row. The state is stable, wrong, and
 * unreachable from inside itself.
 *
 * SO THE LISTING ANSWERS BOTH QUESTIONS AND COLLAPSES NEITHER. `probe` is the past — read off the
 * row, unmoved by anything the catalogue does afterwards — and `checkable` is the present, asked of
 * {@link createPluginStore.probeActionFor} about the app. The pair below is what a single field can
 * never be: the check spent nothing AND there is something to spend now.
 */
test("a key nothing was spent on becomes checkable when the app publishes something", async () => {
  useAnsweringClient();
  await addProbedApp({ withProbe: false });
  await database
    .insert(composioConnections)
    .values({ toolkit: probedToolkit, userId: askerId, verified: false });

  const before = await store.brokeredConnectionsFor(askerId);
  expect(before).toHaveLength(1);
  // Nothing was tried, and there is nothing to try: the two agree here, which is why one field
  // could ever pass for both.
  expect(before[0]?.probe).toBeNull();
  expect(before[0]?.checkable).toBe(false);

  // THE REFRESH. An administrator's press re-lists the app's actions and one of them is a safe
  // versioned read — the very press the transport tells an operator to make when an action appears.
  await database.insert(mcpTools).values({
    serverId: probedId,
    name: probeAction,
    description: "Says who the key belongs to.",
    effect: "read",
    version: probeVersion,
  });

  const after = await store.brokeredConnectionsFor(askerId);
  expect(after).toHaveLength(1);
  // The record does not move, because nothing happened to the key: this is the guard on the fix
  // that stands above, and a listing that let the catalogue write here would re-open it.
  expect(after[0]?.probe).toBeNull();
  expect(after[0]?.verified).toBe(false);
  // And the present-tense answer does move, which is what puts the button back within reach.
  expect(after[0]?.checkable).toBe(true);
  // Both answers are read out of this deployment's own tables.
  expect(reached).toEqual([]);
});

/**
 * AND THE PROBE FINDS THE APP THE SAME WAY THE LISTING DOES, OR THE PAIR IS BACK WHERE IT STARTED.
 *
 * CRITERION. An app whose `mcp_servers.id` is not `composio-` and its slug — a legal row and an
 * ordinary one — is listed `checkable: true` off the read it publishes, and a press of Re-check
 * actually spends that read and records it.
 *
 * REASON. `checkable` and `probe` were split so a settings page could offer the button exactly
 * where there is something to spend a key on, and the split is worth nothing unless both halves
 * name the same app. The listing joins `mcp_servers` ON THE URL, because the url is where a
 * brokered row records which app it is; a probe that composed `composio-${toolkit}` instead
 * re-derived that id from a convention nothing holds a row to — so on any divergence the listing
 * answered off the app's real row and the probe answered off an id addressing nothing at all. That
 * is the Re-check deadlock in its original shape, reached from the other end: the button is
 * offered, the press finds nothing to try, no action is ever recorded, and that press is the only
 * thing in the product that could record one.
 *
 * THE DIVERGENCE IS THE FIXTURE AND IT IS NOT AN EXOTIC ONE. `mcp_servers.id` is a display name an
 * operator sees and a grant is written against; the slug in the url is what the broker is asked
 * about. Nothing holds the two equal — which is why every other brokered lookup in the store, the
 * connect, this re-check's own scheme gate and the disconnect alike, is keyed on the url.
 */
test("a re-check of an app whose row id is not its slug spends the key it was offered for", async () => {
  useAnsweringClient();
  await addRenamedApp();
  await database.insert(composioConnections).values({
    toolkit: renamedProbedToolkit,
    userId: askerId,
    verified: false,
  });

  // THE BUTTON IS OFFERED, which is the listing's half of the pair and the half that was right.
  const listed = await store.brokeredConnectionsFor(askerId);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.serverId).toBe(renamedProbedId);
  expect(listed[0]?.probe).toBeNull();
  expect(listed[0]?.checkable).toBe(true);

  // AND THE PRESS SPENDS IT. `probe: null` here is the deadlock itself: a button offered over an
  // app the check cannot find, on every page load, for good.
  const answer = await store.recheckBrokeredConnection({
    toolkit: renamedProbedToolkit,
    userId: askerId,
  });
  expect(answer.probe).toBe(renamedProbeAction);
  expect(answer.verified).toBe(true);
  expect(answer.verifiedAt).not.toBeNull();
  // And the call really went out, against the action the app's own row publishes.
  expect(reached).toEqual([renamedProbeAction]);
});

/**
 * AND IT NEVER SPENDS A KEY ON WHATEVER ROW A COMPOSED ID HAPPENS TO HIT.
 *
 * CRITERION. With a SECOND app sitting at the id `composio-${toolkit}` would have composed, the
 * probe for the first app still calls the FIRST app's own action, and the second app's action is
 * never reached.
 *
 * REASON. The same defect with the null turned into something worse. A composed id does not merely
 * fail to find the right row — it finds whichever row is called that, and a row called
 * `composio-gmail` at `composio://slack` is the exact shape every other lookup here is keyed on the
 * url to refuse. It would put somebody's key against an action chosen from a DIFFERENT app's
 * listing: the one call this deployment ever makes with a stranger's credential, unrequested, and
 * decided by a name collision. Nothing downstream would notice, either, because the read-effect and
 * no-arguments conditions still hold of the action picked — they are the chooser's, and the chooser
 * was asked about the wrong app.
 */
test("a probe never spends a key on the action of a row the composed id would hit", async () => {
  useAnsweringClient();
  await addRenamedApp();
  // The decoy: an app of its own, whose only crime is being called what the first app's id would
  // have been composed as.
  await database.insert(mcpServers).values({
    id: decoyId,
    title: "Decoy App",
    vendor: "Composio",
    url: `composio://${decoyToolkit}`,
    provenance: "composio",
    authScheme: "API_KEY",
  });
  await database.insert(mcpTools).values({
    serverId: decoyId,
    name: decoyAction,
    description: "Reads something belonging to another app entirely.",
    effect: "read",
    version: probeVersion,
  });

  expect(
    await store.probeBrokeredConnection({
      toolkit: renamedProbedToolkit,
      userId: askerId,
    }),
  ).toEqual({ probe: renamedProbeAction, failure: null });
  expect(reached).toEqual([renamedProbeAction]);
});

/**
 * A CONSENT CONNECTION RECORDS NO ACTION, BECAUSE NONE WAS SPENT.
 *
 * CRITERION. A connection confirmed at the vendor is written verified with no action beside it, and
 * listed that way, even where the app publishes one the chooser would happily take.
 *
 * REASON. Null in this column is not "unchecked" — `verified` is what says that — it is "this
 * deployment spent no action of the app's to know what it knows". For a consent row that is
 * permanently and exactly true: the evidence is the vendor's own yes at the end of its own screen,
 * which {@link confirmBrokeredConnection} goes and asks for, and no call is ever made against the
 * account. The derived field could not say so. It answered with whatever the app happened to
 * publish, so a consent connection was listed as checked with an action nothing had ever called,
 * and the rows whose date is the moment of consent read exactly like the rows that had answered a
 * call.
 */
test("a consent connection records no action, because none was spent", async () => {
  useAnsweringClient();
  await store.addBrokeredApp({
    slug: probedToolkit,
    title: "Probed App",
    by: admin,
    connection: { kind: "consent" },
  });
  // The action a derived field would have named, so the null below is this path's doing and not the
  // app having nothing to offer.
  await database.insert(mcpTools).values({
    serverId: probedId,
    name: probeAction,
    description: "Says who the account belongs to.",
    effect: "read",
    version: probeVersion,
  });

  expect(
    await store.confirmBrokeredConnection({
      toolkit: probedToolkit,
      userId: askerId,
    }),
  ).toEqual({ connected: true });

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
  expect(row.probeAction).toBeNull();
  // Nothing was called to earn that flag, which is the fact the null records.
  expect(reached).toEqual([]);

  const listed = await store.brokeredConnectionsFor(askerId);
  expect(listed[0]?.probe).toBeNull();
});

/**
 * A CONFIRM DOES NOT ERASE WHAT A CHECK SPENT ON A KEY CONNECTION.
 *
 * CRITERION. A key connection sitting in the worst of the four states — a NAMED probe beside
 * `verified: false`, which is "it ran, the vendor refused the key, and the account is still
 * standing" — is confirmed, the vendor answers yes, and the row afterwards still names the action
 * that was spent, still says the check did not pass, and still carries no date.
 *
 * REASON. The confirm runs from an EFFECT ON MOUNT: both brokered account screens fire it on every
 * page load, so whatever it writes is written again every time somebody opens the page. It wrote
 * `verified: true, probeAction: null` for any app — and that pair is not a neutral heal, it is
 * literally one of the four states {@link composioConnections.probeAction} enumerates: the CONSENT
 * state, "the vendor's own yes is the evidence and no call was ever made against the account". So a
 * page load turned a key whose vendor had just refused it into a connection that reads as verified
 * today with nothing spent — the accusation reversed into a reassurance, and the one row an
 * operator has to act on made unfindable. It also moved `verified_at` to the moment of the page
 * load, so the row's own sentence, "last checked 13 Sep", named a day on which nothing was checked.
 *
 * WHAT THE CONFIRM ACTUALLY LEARNED IS THAT AN ACCOUNT IS ATTACHED, and for a key app that is not
 * the same question as whether the key works. Composio takes a key when it is typed and never tests
 * it again — which is the whole reason the probe exists — so `isConnected` saying yes about a key
 * connection is exactly what the row's existence already said. It is evidence for `verified` only
 * where consent IS the check, and the scheme recorded on the app's row is what tells the two apart,
 * asked through {@link isFieldScheme} the way {@link connectBrokeredWithFields} and {@link
 * recheckBrokeredConnection} both ask it.
 *
 * AND THE NEGATIVE HEAL IS UNTOUCHED, which is why the confirm still runs for a key app at all: a
 * vendor answering NO still deletes the row, here as everywhere. What this asserts is only that a
 * YES writes no verdict it did not earn.
 */
test("a confirm does not erase what a check spent on a key connection", async () => {
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
  // The vendor will not take the account back, which is what leaves the row standing in the state
  // this test is about rather than cleaning it away.
  vendorKeepsAccount = true;
  await addProbedApp();

  await expect(
    store.connectBrokeredWithFields({
      toolkit: probedToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).rejects.toThrow(/would not take the account back/);

  // THE STATE BEFORE THE PAGE LOAD, asserted in full rather than assumed from the throw: a named
  // probe, no flag, no date. This is also the only assertion in the file that holds the failed-undo
  // branch to the action it recorded — without it that writer could pass `null` and nothing would
  // notice, which is the same hole in the same column this whole test is about.
  const [before] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(before.probeAction).toBe(probeAction);
  expect(before.verified).toBe(false);
  expect(before.verifiedAt).toBeNull();

  // THE PAGE LOAD. Nothing a person did — an effect on mount, on whichever of the two screens draws
  // this row, as many times as they open it.
  expect(
    await store.confirmBrokeredConnection({
      toolkit: probedToolkit,
      userId: askerId,
    }),
  ).toEqual({ connected: true });

  const [after] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  // The record of the check survives the mount, whole: the action it spent, the verdict it reached,
  // and the absence of a date for a claim nobody is making.
  expect(after.probeAction).toBe(probeAction);
  expect(after.verified).toBe(false);
  expect(after.verifiedAt).toBeNull();

  // And the settings page goes on drawing the sentence that state is for, which is the sentence the
  // person has to act on: the key was checked and refused, and the account still stands.
  const listed = await store.brokeredConnectionsFor(askerId);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.probe).toBe(probeAction);
  expect(listed[0]?.verified).toBe(false);
  expect(listed[0]?.verifiedAt).toBeNull();

  // The confirm asked the vendor and spent nothing on the person's account: the only action ever
  // called here is the probe the connect made, before the confirm ran at all.
  expect(reached).toEqual([probeAction]);
  expect(asksMade()).toEqual([
    `ensureAuthConfig:${probedToolkit}/fields`,
    `connectWithFields:${probedToolkit}/${askerId}`,
    `revokeAccount:${madeAccountId}`,
    `isConnected:${probedToolkit}/${askerId}`,
  ]);
});

/**
 * AND IT DOES NOT REDATE A KEY THE LAST CHECK PASSED, EITHER.
 *
 * CRITERION. A key connection a probe verified at a known moment is confirmed, and afterwards its
 * `verified_at` is still that moment and its `probe_action` is still that action — while a CONSENT
 * connection, confirmed the same way against the same vendor answer, IS written and IS redated.
 *
 * REASON. The clobber has a quiet half as well as a loud one. On the refused-key row above the
 * damage is a false sentence; here both rows say "verified", and what a mount-time write destroys
 * is the DATE — the page prints "last checked" off `verified_at`, so a confirm stamping today would
 * have every key connection in the deployment claim it was checked on whatever day its owner last
 * opened the page, forever, without a single call being made. A row that has not been checked since
 * August must go on saying August; that is the whole value of the column.
 *
 * WHY BOTH SCHEMES IN ONE TEST. The consent half is what separates a confirm that learned to tell
 * the two kinds apart from one that simply stopped writing. Consent IS the check — the vendor's own
 * yes at the end of its own screen is the evidence, and it is fresh evidence on every confirm — so
 * that row is written, dated now, and keeps the null that says no action was ever spent on it. One
 * app under each scheme, the same act against the same stub, so the only thing that differs between
 * the two outcomes is the scheme recorded on the app's row.
 */
test("a confirm does not redate a key the last check verified", async () => {
  useAnsweringClient();
  await addProbedApp();
  await store.connectBrokeredWithFields({
    toolkit: probedToolkit,
    userId: askerId,
    values: { generic_api_key: typedKey },
  });

  const [checked] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(checked.verified).toBe(true);
  expect(checked.probeAction).toBe(probeAction);
  const earned = checked.verifiedAt;
  expect(earned).not.toBeNull();

  expect(
    await store.confirmBrokeredConnection({
      toolkit: probedToolkit,
      userId: askerId,
    }),
  ).toEqual({ connected: true });

  const [after] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  // The moment the probe earned, unmoved: the date on the row is the date of a check, and a page
  // load is not one.
  expect(after.verifiedAt?.toISOString()).toBe(earned?.toISOString());
  expect(after.probeAction).toBe(probeAction);
  expect(after.verified).toBe(true);

  // THE OTHER KIND, against the same stub and the same act. A consent connection's evidence IS the
  // vendor's yes, so this one is written and dated by the confirm — and keeps the null that says
  // nothing of the app's was ever called against it.
  const consentSeeded = new Date("2026-08-30T09:00:00.000Z");
  await store.addBrokeredApp({
    slug: enabledToolkit,
    title: "Enablable App",
    by: admin,
    connection: { kind: "consent" },
  });
  await database.insert(composioConnections).values({
    toolkit: enabledToolkit,
    userId: askerId,
    verified: true,
    verifiedAt: consentSeeded,
  });

  expect(
    await store.confirmBrokeredConnection({
      toolkit: enabledToolkit,
      userId: askerId,
    }),
  ).toEqual({ connected: true });

  const [consent] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, enabledToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(consent.verified).toBe(true);
  expect(consent.probeAction).toBeNull();
  expect(consent.verifiedAt?.toISOString()).not.toBe(
    consentSeeded.toISOString(),
  );
  expect(consent.verifiedAt?.getTime()).toBeGreaterThan(
    consentSeeded.getTime(),
  );

  // One probe, spent by the connect, and nothing since.
  expect(reached).toEqual([probeAction]);
});

/**
 * ONE CONNECTION IS ONE LISTED ROW, EVEN WHERE TWO SERVER ROWS NAME THE APP.
 *
 * CRITERION. With two `mcp_servers` rows at one app's url and one person connected to that app,
 * the listing answers exactly once, under the lower of the two ids — and under it whichever order
 * the rows were written in.
 *
 * REASON. The listing resolves a connection to a server row by matching `mcp_servers.url` against
 * `composio://` and the toolkit, and `url` has no unique index behind it. So the match is one row
 * per PAIR rather than one per connection, and a second row at the same url puts the same account
 * on the settings page twice: two rows saying the same app, with two different server ids on them,
 * both offering to disconnect the single connection that stands behind both. That is not a state
 * somebody has to arrange, either — it is what a development database looks like the moment a
 * fixture sits beside a real brokered row for the same app.
 *
 * AND THE ID DECIDES, SO THAT TWO READS AGREE. Something has to answer for the app, and the choice
 * has to be a rule rather than whatever the scan met first: a page that redrew with a different
 * `serverId` each load would offer buttons keyed on a value that moved underneath it. The lower id
 * is that rule, and the fixtures here are named and ordered to tell it from an accident — see
 * {@link twinId}.
 */
test("a connection is listed once where two server rows name its app", async () => {
  await seedApp();
  await database.insert(mcpServers).values({
    id: twinId,
    title: "Revocable App, added a second time",
    vendor: "Composio",
    url: `composio://${toolkit}`,
    provenance: "composio",
  });

  const listed = await store.brokeredConnectionsFor(askerId);
  expect(listed.map((row) => row.serverId)).toEqual([twinId]);
});

/**
 * AND THE SAME ROW ANSWERS WHAT THE APP IS CONNECTED WITH.
 *
 * CRITERION. With two `mcp_servers` rows at the probed app's url — the one Add wrote, recorded
 * `API_KEY`, and an older one recorded `OAUTH2` — a re-check reads the key scheme and runs.
 *
 * REASON. `recheckBrokeredConnection`, `connectBrokeredWithFields` and `disconnectBrokered` all
 * find the app by its url and then read `auth_scheme` off the single row they took, and none of
 * them said which row that was. Two rows at one url therefore left the answer to the planner: this
 * person holds a key at the vendor, and the reading that lands on the other row refuses the button
 * in a sentence about a sign-in screen they never saw, telling them to disconnect and reconnect an
 * account that is working. The same lower-id rule the listing uses is what makes the three of them
 * agree with it and with each other.
 *
 * AND THE PROBE IS THE SAME READ, WHICH IS WHY THE ACTION IS ASSERTED BESIDE THE FLAG.
 * `probeBrokeredConnection` resolves the app by its url too — to an ID rather than to a scheme, so
 * that a probe cannot be chosen off another app's action list and spent on this key. Unordered, that
 * read answered the row physically first, which here publishes no action at all: the re-check then
 * reported `probe: null`, wrote nothing, and left the untouched `verified: false` standing — the
 * `checkable`/`probe` deadlock, reached through a duplicate row instead of a composed id. So
 * `probe` naming the action is what says the scheme and the action came off ONE row.
 */
test("a re-check reads the app's scheme off the same row the listing names it by", async () => {
  useAnsweringClient();
  // Before the app's own row, and named to sort after it. See {@link schemeTwinId}: the pre-fix
  // reading is the row physically first, and the rule's is the row that sorts first.
  await database.insert(mcpServers).values({
    id: schemeTwinId,
    title: "Probed App, as it was recorded before",
    vendor: "Composio",
    url: `composio://${probedToolkit}`,
    provenance: "composio",
    authScheme: "OAUTH2",
  });
  await addProbedApp();
  await holdProbedApp();

  const answer = await store.recheckBrokeredConnection({
    toolkit: probedToolkit,
    userId: askerId,
  });

  expect(answer.verified).toBe(true);
  expect(answer.probe).toBe(probeAction);
});

/**
 * AND SO DOES THE CONFIRM, WHERE THE SCHEME DECIDES WHETHER IT MAY WRITE AT ALL.
 *
 * CRITERION. With the same two rows at the probed app's url, a confirm against a key connection
 * checked in August leaves that August date standing.
 *
 * REASON. `confirmBrokeredConnection` branches on the app's scheme for a reason no other caller
 * shares: on a KEY connection the vendor's yes is not a check — Composio accepts a key without ever
 * trying it — so the confirm writes nothing and the date a real probe earned survives, while on a
 * CONSENT connection that yes IS the check and is written and dated. Read off the wrong row the
 * branch inverts: this key connection is taken for a consent one, and a page load stamps today over
 * the date of the last call anybody actually made. Every key connection in the deployment would then
 * claim it was last checked on whatever day its owner last opened the page. The date is asserted
 * rather than the flag because both readings leave the row saying `verified: true` — the damage here
 * is quiet, and only `verified_at` records it.
 */
test("a confirm reads the app's scheme off the same row the listing names it by", async () => {
  useAnsweringClient();
  // The same pair, ordered the same way. See {@link schemeTwinId}.
  await database.insert(mcpServers).values({
    id: schemeTwinId,
    title: "Probed App, as it was recorded before",
    vendor: "Composio",
    url: `composio://${probedToolkit}`,
    provenance: "composio",
    authScheme: "OAUTH2",
  });
  await addProbedApp();
  const checked = new Date("2026-08-30T09:00:00.000Z");
  await holdProbedApp(checked);

  expect(
    await store.confirmBrokeredConnection({
      toolkit: probedToolkit,
      userId: askerId,
    }),
  ).toEqual({ connected: true });

  const [after] = await database
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, probedToolkit),
        eq(composioConnections.userId, askerId),
      ),
    );
  expect(after.verified).toBe(true);
  expect(after.verifiedAt?.toISOString()).toBe(checked.toISOString());
  // And nothing of the app's was called to arrive at that: a confirm asks the vendor, it does not
  // spend the key.
  expect(reached).toEqual([]);
});

/**
 * AND SO DOES THE CONNECT, WHICH IS THE THIRD OF THE THREE READS AND THE ONE THAT SPENDS A SECRET.
 *
 * CRITERION. With the same two `mcp_servers` rows at the probed app's url — the one Add wrote,
 * recorded `API_KEY`, and an older one recorded `OAUTH2` — a connect made from typed values reaches
 * Composio under `API_KEY`.
 *
 * REASON. The pair above covers the re-check and the confirm and stops there, and the connect is the
 * one of the three where the scheme is not merely read but SENT: `connectWithFields` creates the
 * account under it, so it decides what the vendor believes it has been handed. Read off the other
 * row this press is refused outright — in a sentence about a sign-in screen, at somebody standing in
 * front of a form this deployment drew for them — and a reading that refused nothing but got the
 * word wrong would attach a key to a flow it cannot work in, which nothing discovers until the first
 * tool call.
 *
 * THE SCHEME IS ASSERTED AS WELL AS THE OUTCOME, because the two say different things. A `connected`
 * answer says the gate admitted this app; {@link schemesSent} says which row the word came off, and
 * it is the only assertion in this file that can tell one from the other.
 */
test("a connect reads the app's scheme off the same row the listing names it by", async () => {
  useAnsweringClient();
  // The same pair as the two tests above, ordered the same way. See {@link schemeTwinId}.
  await database.insert(mcpServers).values({
    id: schemeTwinId,
    title: "Probed App, as it was recorded before",
    vendor: "Composio",
    url: `composio://${probedToolkit}`,
    provenance: "composio",
    authScheme: "OAUTH2",
  });
  await addProbedApp();

  expect(
    await store.connectBrokeredWithFields({
      toolkit: probedToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
  ).toEqual({ connected: true, verified: true, probe: probeAction });

  expect(valuesSent).toEqual([{ generic_api_key: typedKey }]);
  expect(schemesSent).toEqual(["API_KEY"]);
});

/**
 * TYPING A KEY AT AN APP NOBODY TYPES A KEY AT, WHICH IS THE GATE ON WHAT REACHES THE VENDOR.
 *
 * CRITERION. `connectBrokeredWithFields` against an app recorded `OAUTH2` refuses, names the app,
 * and hands Composio nothing at all.
 *
 * REASON. Every connect in this file is against an app enabled as a key app, so the `isFieldScheme`
 * guard at the head of the method was a branch no test ever took. It is what stands between a
 * request naming any app at all and an account created at the vendor under a scheme that is not the
 * one the config was made as — and the caller is a route serving one URL for all three kinds, so
 * "this app is a consent app" is a fact only this read holds. The refusal is asserted with the
 * vendor's silence beside it: a guard that raised the right sentence AFTER handing the values over
 * would satisfy the first half and have already leaked the secret.
 */
test("a key typed at a consent app is refused before the vendor is handed anything", async () => {
  useAnsweringClient();
  await store.addBrokeredApp({
    slug: consentToolkit,
    title: "Consented App",
    by: admin,
    connection: { kind: "consent" },
  });

  await expect(
    store.connectBrokeredWithFields({
      toolkit: consentToolkit,
      userId: askerId,
      values: { generic_api_key: typedKey },
    }),
    // The app by name, and the one act that is open to somebody standing in front of this: the
    // Plugins page, where it is connected the way it asks for.
  ).rejects.toThrow(
    new RegExp(
      `${consentToolkit} is not an app this deployment connects with values somebody types`,
    ),
  );

  // NOTHING WAS SENT, which is the half the sentence cannot say. The enable above is the only ask
  // this test makes, and the values never left.
  expect(asksMade()).toEqual([`ensureAuthConfig:${consentToolkit}/consent`]);
  expect(valuesSent).toEqual([]);
  expect(schemesSent).toEqual([]);
  // And no row was written, so nothing on any screen claims this person has an account here.
  expect(await connectedToolkitsFor(askerId)).toEqual([]);
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
  // And told what it was being handed, which decides what Composio does with it. See
  // {@link schemesSent}: this is the scheme `addBrokeredApp` recorded on the app's row above.
  expect(schemesSent).toEqual(["API_KEY"]);

  /*
   * THE TRAIL, READ OUT OF THE TABLE RATHER THAN OFF THE RECORDING STORE. The rows are what a
   * reader of the trail will actually see — after the redactor, after the insert — and this file's
   * `auditStore` keeps a copy of the input beside it, not instead of it. Narrowed to this app
   * because `audit_events` is append-only: no cleanup here can reach it, so the other tests in this
   * run have already written `mcp.account_connected` rows under {@link toolkit}.
   *
   * AND THE ONE IS AN ASSERTION RATHER THAN AN ACCIDENT OF ORDER, which it has to be said out loud
   * to stay: `enabledToolkit` is connected for real by THIS TEST AND NO OTHER in the file, so the
   * count is this test's own act and nobody else's. Any test that needs a second real connect takes
   * a slug of its own — {@link rekeyedToolkit} and {@link reschemedToolkit} both exist for this and
   * nothing else. Sharing one here does not redden anything on the spot; it makes this number the
   * runner's answer rather than the implementation's, and it reads as passing until somebody moves
   * a test.
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
  // Null in the column too, and it is the row's own sentence rather than the listing's: NOTHING WAS
  // SPENT on this key. What the app publishes today, or comes to publish tomorrow, cannot move it.
  expect(row.probeAction).toBeNull();

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
  // AND THE ROW RECORDS WHICH ACTION EARNED THE FLAG, which is the half `verified` cannot hold.
  // The listing reads this column rather than asking today's metadata what it WOULD spend, so what
  // a page says about this connection stays what happened to it.
  expect(row.probeAction).toBe(probeAction);

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
  // And the action this press spent, written down beside the flag it earned. A re-check is the
  // second of the two writers that can put a name here, and a row must not be able to tell which of
  // them wrote it apart from by its date.
  expect(row.probeAction).toBe(probeAction);

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

/**
 * AND A RE-CHECK AGAINST A CONSENT CONNECTION IS REFUSED IN THE STORE, NOT MERELY IN THE BROWSER.
 *
 * CRITERION. Where the app's recorded scheme is a consent scheme, the call raises, no action is
 * called at the vendor, nothing reaches the trail, and the row keeps the `verified` and
 * `verified_at` it already held — with an app that HAS a probe, so the refusal is the scheme's doing
 * and not the nothing-to-try branch's.
 *
 * REASON. A consent connection has no key here to re-check: what it has is a date earned at the
 * vendor's own screen, which is a fact nothing else in this deployment records. Without this gate a
 * direct POST — the browser's own button is not the only caller a route has — would spend a call on
 * somebody's account and, on the failure that call is likely to be, write `verified: false` with a
 * null timestamp: a button that claims to check a connection, destroying the only evidence that one
 * was ever checked. {@link connectBrokeredWithFields} sets the precedent it is read off — the scheme
 * on the app's row decides, in the store, rather than the caller being trusted to have looked.
 */
test("a re-check against a consent connection refuses rather than spending its date", async () => {
  useAnsweringClient();
  // Added on the consent flow, and then given an action a probe could otherwise have used: without
  // that action this test would pass on the nothing-to-probe branch and assert nothing about the
  // scheme.
  await store.addBrokeredApp({
    slug: probedToolkit,
    title: "Probed App",
    by: admin,
    connection: { kind: "consent" },
  });
  await database.insert(mcpTools).values({
    serverId: probedId,
    name: probeAction,
    description: "Says who the account belongs to.",
    effect: "read",
    version: probeVersion,
  });
  // The date the consent screen earned, which is the thing this refusal protects.
  const earned = new Date("2026-08-30T09:00:00.000Z");
  await holdProbedApp(earned);

  await expect(
    store.recheckBrokeredConnection({
      toolkit: probedToolkit,
      userId: askerId,
    }),
  ).rejects.toThrow();

  expect(reached).toEqual([]);
  expect(recordedOfType("mcp.connection_verified")).toEqual([]);
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
});

/**
 * DISCONNECTING A KEY CLAIMS NO REVOCATION, BECAUSE A KEY HAS NO GRANT BEHIND IT TO WITHDRAW.
 *
 * CRITERION. Ending a connection somebody typed a key into answers `vendorRevocationRequested:
 * false` and files a trail row saying false — while the vendor is still asked, still finds the
 * account, and still ends it; and while the SAME app under a consent scheme, disconnected the same
 * way against the same vendor answer, says true.
 *
 * REASON. `revoke_on_delete` asks the PROVIDER to end a grant. For a consent connection that is a
 * real request Google or Slack acts on, and the field says a withdrawal was asked for. For a key
 * there is no grant: the value is still valid at the app and still works for anyone holding it, so
 * the account ends at Composio and nothing was asked of anybody else. `ComposioBroker.revoke`'s own
 * doc argues that "requested" is as far as any implementation can honestly go and that the whole
 * worth of the boolean is letting a reader tell an account this deployment acted on from one that
 * outlives it somewhere else — a key reporting true would be the one row in that trail nobody could
 * rely on, a withdrawal recorded for something nobody ever granted. The person is already told the
 * other half of this fact in their own words on the disconnect row: their key still works at the
 * app, and rotating it there is what ends it.
 *
 * WHY BOTH SCHEMES IN ONE TEST. The vendor here answers `true` to every revoke, so the false above
 * is the implementation's doing and not the stub's — and the second half is what separates a field
 * this deployment computes from a constant of either polarity. One app rather than two, re-enabled
 * onto the other flow with nobody connected, so the ONLY thing that differs between the two acts is
 * the scheme recorded on the row.
 */
test("disconnecting a key claims no revocation", async () => {
  useAnsweringClient();
  await store.addBrokeredApp({
    slug: reschemedToolkit,
    title: "Enablable App",
    by: admin,
    connection: { kind: "fields", authScheme: "API_KEY" },
  });
  await store.connectBrokeredWithFields({
    toolkit: reschemedToolkit,
    userId: askerId,
    values: { generic_api_key: typedKey },
  });

  expect(
    await store.disconnectBrokered({
      toolkit: reschemedToolkit,
      userId: askerId,
      by: askerId,
      reason: "self",
    }),
  ).toEqual({ vendorRevocationRequested: false });

  /*
   * AND THE ACCOUNT DID END AT COMPOSIO, which is the half of the sentence the false must not be
   * allowed to swallow. The broker was asked, it answered that it found an account — {@link
   * vendorFinds} is true for everybody here — and it is holding nothing afterwards. Without these
   * the assertion above would be satisfied just as well by a disconnect that skipped the revoke
   * and left somebody's key attached at the vendor with no row here pointing at it.
   */
  expect(asksMade()).toEqual([
    `ensureAuthConfig:${reschemedToolkit}/fields`,
    `connectWithFields:${reschemedToolkit}/${askerId}`,
    `revoke:${reschemedToolkit}/${askerId}`,
  ]);
  expect(vendorHolds).toEqual([]);
  expect(await connectedToolkitsFor(askerId)).toEqual([]);

  // THE SAME APP AND THE SAME ACT, with the scheme moved underneath it. Re-enabling may rewrite the
  // column because the disconnect above left nobody connected to be stranded by it.
  await store.addBrokeredApp({
    slug: reschemedToolkit,
    title: "Enablable App",
    by: admin,
    connection: { kind: "consent" },
  });
  await database
    .insert(composioConnections)
    .values({ toolkit: reschemedToolkit, userId: askerId });

  expect(
    await store.disconnectBrokered({
      toolkit: reschemedToolkit,
      userId: askerId,
      by: askerId,
      reason: "self",
    }),
  ).toEqual({ vendorRevocationRequested: true });

  // Read in the order the two acts happened, which is what makes the pair an assertion about the
  // scheme rather than two separate assertions about a boolean.
  expect(
    recordedOfType("mcp.account_disconnected").map(
      (event) =>
        (event.payload as { vendorRevocationRequested: boolean })
          .vendorRevocationRequested,
    ),
  ).toEqual([false, true]);
});

/**
 * THE TWO ADD PATHS WRITING ONE ROW, which is the only way a row can stop saying what it is.
 *
 * `mcp_servers.provenance` and `mcp_servers.url` are one fact in two columns: `accessFor` reads the
 * first to decide whether a call is brokered at all, and `toolkitOf` reads the app slug out of the
 * second. Every gate that keeps one person's Composio account out of another's is keyed on the pair
 * — `connectionTokenFor` refuses a call whose asker has no `composio_connections` row for that app,
 * and `removeServer` finds the accounts to end at the vendor by the same reading — so a row where
 * one column has moved and the other has not is not a misfiled display fact. It is a row that is
 * dialled one way and governed another.
 *
 * BOTH DIRECTIONS OF THE COLLISION ARE HERE, and they are not fixed the same way, because what they
 * destroy is not the same thing.
 */

/**
 * ENABLING AN APP OVER A ROW SOMEBODY TYPED, which must leave a row that says it is brokered.
 *
 * CRITERION. After `addBrokeredApp` has written `composio://<slug>` into a row, that row's
 * provenance says `composio` and its vendor says Composio, whatever the row said a moment before —
 * and it resolves as the brokered app its url names, so removing it ends the accounts behind it.
 *
 * REASON. The upsert's update branch rewrote the url and left `provenance` alone, so an app enabled
 * over a row an administrator had added by URL came out `custom` at a `composio://` address: the
 * transport dialled it as MCP on the deployment's own token while the connect screen went on
 * attaching people's real accounts to it. The per-person gate was not weakened, it was BYPASSED —
 * `accessFor` never answered `brokered` for that row, so nothing ever asked whether the person
 * asking had connected. And the same silence made the app unremovable in the only sense that
 * matters: `removeServer` reads the app to revoke out of `accessFor`, so it found none and left
 * every account live at Composio while reporting the connector gone.
 *
 * THE ROW THIS STARTS FROM IS INSERTED BY HAND, because the id it sits at is one `addCustomServer`
 * now refuses outright — see the test below. That refusal is the forward half; this is the half
 * that has to hold for a row already in a deployment's database when the refusal arrives.
 */
test("enabling an app over a row somebody typed leaves a row that says it is brokered", async () => {
  useAnsweringClient();
  await database.insert(mcpServers).values({
    id: collidedId,
    title: "Typed By Hand",
    vendor: "collector.attacker.example",
    url: "https://collector.attacker.example/mcp",
    provenance: "custom",
  });

  await store.addBrokeredApp({
    slug: collidedToolkit,
    title: "Collided App",
    by: admin,
    connection: { kind: "consent" },
  });

  const [row] = await database
    .select({
      url: mcpServers.url,
      provenance: mcpServers.provenance,
      vendor: mcpServers.vendor,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, collidedId));
  expect(row).toEqual({
    url: `composio://${collidedToolkit}`,
    provenance: "composio",
    // The broker, because that is who this deployment is now talking to for this row, and the
    // column is what the first-party rule is checked against.
    vendor: "Composio",
  });

  // Asked through the same function every gate asks, rather than by comparing the columns again:
  // what the row must be is not "these two strings" but the answer those two strings produce.
  expect(accessFor(row, null)).toMatchObject({
    credential: "brokered",
    toolkit: collidedToolkit,
  });

  /*
   * AND THE CONSEQUENCE, which is the whole reason the column matters. Somebody connects, an
   * administrator removes the app, and the account ends at Composio. On the row the upsert used to
   * leave, `removeServer` read no app off `accessFor` at all: it deleted the row, asked the vendor
   * nothing, and left the mailbox attached with nothing here left naming it.
   */
  await database
    .insert(composioConnections)
    .values({ toolkit: collidedToolkit, userId: askerId });

  await store.removeServer(collidedId, admin);

  expect(asksMade()).toEqual([
    `ensureAuthConfig:${collidedToolkit}/consent`,
    `revoke:${collidedToolkit}/${askerId}`,
    `deleteAuthConfig:${collidedToolkit}`,
  ]);
  expect(await connectionsHeld()).toEqual([]);
});

/**
 * ADDING A SERVER BY URL OVER A BROKERED ROW, which is refused rather than repaired.
 *
 * CRITERION. `addCustomServer` refuses an id whose row is a Composio app this deployment has
 * enabled, with a {@link CustomServerRefusedError} — the class both add routes turn into a 400 an
 * administrator can act on — and the row is left exactly as it stood, so the accounts behind it are
 * still revocable.
 *
 * REASON. This is the direction that CANNOT be repaired by writing the missing column, and that is
 * the asymmetry with the test above. The url is the only place the app slug is written down: a
 * custom add rewrites it to the address somebody typed, and from that moment nothing in this
 * deployment can name the app those `composio_connections` rows stand for. `removeServer` revokes
 * nothing, offboarding revokes nothing, and every call the row still serves throws
 * `PluginInvariantError` because `accessFor` answers `brokered` with a null toolkit. Writing
 * `provenance = custom` alongside would make the row self-consistent and lose the accounts just the
 * same — consistent and orphaned is not better than contradictory and orphaned.
 *
 * So the add is refused, and the honest act is left to the administrator: remove the app, which
 * ends every account at Composio on the way out, and then add the endpoint at that name.
 */
test("a server added by URL may not take a brokered row, and its accounts stay revocable", async () => {
  useAnsweringClient();
  await store.addBrokeredApp({
    slug: collidedToolkit,
    title: "Collided App",
    by: admin,
    connection: { kind: "consent" },
  });
  await database
    .insert(composioConnections)
    .values({ toolkit: collidedToolkit, userId: askerId });

  await expect(
    store.addCustomServer({
      id: collidedId,
      title: "Collector",
      url: "https://collector.attacker.example/mcp",
      by: admin,
    }),
  ).rejects.toThrow(CustomServerRefusedError);

  const [row] = await database
    .select({ url: mcpServers.url, provenance: mcpServers.provenance })
    .from(mcpServers)
    .where(eq(mcpServers.id, collidedId));
  expect(row).toEqual({
    url: `composio://${collidedToolkit}`,
    provenance: "composio",
  });

  // The property the refusal exists for: the app is still an app, so taking it away still ends the
  // account at the vendor rather than merely forgetting it here.
  await store.removeServer(collidedId, admin);
  expect(asksMade()).toEqual([
    `ensureAuthConfig:${collidedToolkit}/consent`,
    `revoke:${collidedToolkit}/${askerId}`,
    `deleteAuthConfig:${collidedToolkit}`,
  ]);
  expect(await connectionsHeld()).toEqual([]);
});

/**
 * AND THE NAMESPACE ITSELF, reserved before there is any row to collide with.
 *
 * CRITERION. `addCustomServer` refuses every id beginning `composio-`, whether or not a row is
 * there today.
 *
 * REASON. The two tests above are about a row that already exists; this is what stops the pair from
 * ever existing again. `addBrokeredApp` mints `composio-<slug>` and nothing else may mint into that
 * space, so the first press of Add for an app can never find somebody's typed endpoint sitting at
 * its id — and a custom server can never be the thing an enable is about to convert. It is the same
 * reservation the curated slugs already have one line above, for the same reason: the id prefixes
 * every tool name and is what a grant and a policy rule are written against, so a row that shadows
 * another path's namespace inherits rules that were written about something else.
 */
test("a server added by URL may not take the namespace brokered rows are minted in", async () => {
  await expect(
    store.addCustomServer({
      id: collidedId,
      title: "Collector",
      url: "https://collector.attacker.example/mcp",
      by: admin,
    }),
  ).rejects.toThrow(CustomServerRefusedError);

  expect(
    await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, collidedId)),
  ).toEqual([]);
});
