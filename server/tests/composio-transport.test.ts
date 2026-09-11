import { afterEach, describe, expect, test } from "bun:test";
import { BrokerRefusalError } from "../src/plugins/broker";
import {
  type ComposioAction,
  type ComposioActions,
  type ComposioResult,
  callTool,
  effectOf,
  LISTING_LIMIT,
  listNeedsCredential,
  listTools,
  toolkitOf,
  useComposioClient,
  vendorSentence,
} from "../src/plugins/composio";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";

/**
 * The Composio transport's boundary, asserted with no network and no database.
 *
 * What is under test is the boundary rather than the SDK: which app a connection names, whose id a
 * call is attributed to, what a label means, which version is sent, and what a refusal reads as. The
 * client arrives through {@link useComposioClient}, which is the only seam the module has —
 * `transportFor` resolves a kind to a MODULE, so there is no constructor to pass one to. Same shape
 * as `builtin-routines`.
 *
 * The security property this file exists for is the attribution one: the user id comes off the
 * connection and never out of the arguments a model produced. A model that could name a user id
 * could open somebody else's mailbox.
 */

afterEach(() => useComposioClient(null));

/**
 * One call as the vendor received it: the four fields that decide what it MEANS, and the arguments.
 *
 * THE ARGUMENTS ARE HERE BECAUSE THE ATTRIBUTION PROPERTY IS ABOUT BOTH HALVES. The recorder used to
 * take the call record and drop `args` on the floor, so the one test this file exists for — a user
 * id that comes off the connection and never out of a model's arguments — could only ever see the
 * half that was already right. `@composio/client` resolves the connected account from the execute
 * body's `user_id` and carries the model's own arguments beside it in `arguments`
 * (0.1.0-alpha.76, `resources/tools.d.ts:480-493`), so what a transport sends into the second of
 * those is as much of the call as what it sends into the first.
 */
type Recorded = {
  toolkit: string;
  slug: string;
  userId: string;
  version: string;
  args: Record<string, unknown>;
};

/**
 * An answer in the shape `ToolExecuteResponseSchema` actually permits.
 *
 * Every stub here goes through this rather than returning a shape of its own, because the SDK's
 * schema makes `data`, `error` and `successful` all REQUIRED — so a stub that resolves `null`, or a
 * bare string, is testing a case the library cannot produce, and a test built on an impossible input
 * proves nothing about the code that reads a real one.
 */
function answered(
  data: Record<string, unknown>,
  outcome: { error?: string | null; successful?: boolean } = {},
) {
  return {
    data,
    error: outcome.error ?? null,
    successful: outcome.successful ?? true,
  };
}

/**
 * The two numbers this file reasons about, WRITTEN OUT rather than imported.
 *
 * AN ASSERTION THAT IMPORTS THE CONSTANT IT IS ABOUT CANNOT FAIL WHEN THAT CONSTANT MOVES, because
 * both sides move together. The previous version of this file replaced a loose bound with an
 * equality against `MAX_RESULT_CHARS` itself and called the number pinned; it was not. Applied to
 * the modules, `MAX_RESULT_CHARS` 20,000 → 40,000 and `LISTING_LIMIT` 1000 → 20 both left all 44
 * tests passing: the cap tests measured the answer against whatever the cap had just become, and
 * the listing test asked for whatever page the module had just decided to ask for.
 *
 * So the literals live here, and one test below is the only place the imported constants are read.
 * Changing either constant now reddens exactly that test, which is where the argument for the
 * number belongs: 20,000 is how much of a model's context one tool result may spend, and 1000 is
 * the vendor's stated page ceiling and therefore the whole listing.
 */
const RESULT_CAP = 20_000;
const WHOLE_LISTING = 1000;
const TRUNCATION_MARKER = "\n\n[truncated]";
const CAPPED_LENGTH = RESULT_CAP + TRUNCATION_MARKER.length;

/** The nesting `vendorSentence` reaches through, with whatever the vendor left at the bottom of it. */
function nested(message: unknown): unknown {
  return { cause: { error: { error: { message } } } };
}

/**
 * The SAME failure with nothing wrapped around it, which is how several of these calls arrive.
 *
 * `@composio/client`'s `APIError` hangs the response body on `.error` and sets no `cause` at all,
 * and builds its own `message` as the status code followed by that body JSON-stringified whole
 * where the body has no top-level `message` — `${"${status}"} ${"${JSON.stringify(error)}"}`
 * (`@composio/client` 0.1.0-alpha.76, `src/core/error.ts:9-45`). Composio's body puts its sentence
 * at `error.message`, so that fallback is what every one of these throws carries in `.message`.
 *
 * It reaches this transport unwrapped from five calls: `@composio/core` 0.18.1 awaits
 * `this.client.authConfigs.list`, `this.client.connectedAccounts.list` and `this.client.tools.list`
 * with no try around them (`src/models/AuthConfigs.ts`, `src/models/ConnectedAccounts.ts`,
 * `src/models/Tools.ts:552-555`), and `./composio-adapter` calls both raw deletes on the client
 * itself. So the sentence sits one level shallower here than in {@link nested}, and the dump is
 * what escaped in its place.
 */
function unwrapped(message: unknown): Error {
  const body = { error: { message } };
  return Object.assign(new Error(`404 ${JSON.stringify(body)}`), {
    status: 404,
    headers: { "x-request-id": "must-not-appear" },
    error: body,
  });
}

/** The same client error for a body with no sentence anywhere in it: status code, then the lot. */
function dumped(body: Record<string, unknown>): Error {
  return Object.assign(new Error(`502 ${JSON.stringify(body)}`), {
    status: 502,
    headers: { "x-request-id": "must-not-appear" },
    error: body,
  });
}

function recording(answers: Partial<ComposioActions> = {}): {
  client: ComposioActions;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    client: {
      listActions: answers.listActions ?? (async () => []),
      execute:
        answers.execute ??
        (async (call, args) => {
          // SNAPSHOTTED RATHER THAN HELD BY REFERENCE, for the reason the schema test snapshots:
          // `toEqual` against a live reference holds whatever happened to the object afterwards, so
          // a transport that handed its arguments over and then edited them would be recorded as
          // having sent whatever it edited them into.
          calls.push({ ...call, args: structuredClone(args) });
          return answered({ ok: true });
        }),
    },
  };
}

const GMAIL_READ = {
  slug: "GMAIL_FETCH_EMAILS",
  description: "Fetch emails.",
  inputParameters: {
    type: "object",
    properties: { query: { type: "string" } },
  },
  tags: ["readOnlyHint", "important"],
  version: "20260903_00",
};

/** A parameter that stages a file, in the shape `JSONSchemaPropertySchema` keeps it. */
const FILE_PROPERTY = { type: "string", file_uploadable: true };

/**
 * One subschema keyword carrying `sub`, hung off a property so the root stays a `ParametersSchema`.
 *
 * A COMPUTED KEY, for `then` and for nothing else: biome refuses a literal `then` key on an object
 * literal, and the conditional trio has to be reachable here or the branch that walks it is being
 * asserted by nothing. `if`, `then`, `else`, `items` and `$ref` live on `JSONSchemaPropertySchema`
 * and not on the parameters root (`@composio/core` 0.18.1, `src/types/tool.types.ts:77-131` against
 * `:134-175`), so a case for one of them has to nest to be a shape the vendor could send.
 */
function underProperty(keyword: string, sub: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: { field: { type: "object", [keyword]: sub } },
  };
}

/** One action whose whole schema is the case under test, listed beside a plain one. */
function listing(inputParameters: Record<string, unknown>) {
  return recording({
    listActions: async () => [
      GMAIL_READ,
      { slug: "GMAIL_STAGES_A_FILE", version: "20260903_00", inputParameters },
    ],
  }).client;
}

describe("the numbers these assertions are about", () => {
  test("the modules hold the numbers this file has written out", () => {
    // The only reads of the imported constants in this file. Every other assertion measures
    // against the literals above, so a constant that moves reddens this one test — which states
    // the number — instead of quietly redefining what all the others are checking.
    expect(MAX_RESULT_CHARS).toBe(RESULT_CAP);
    expect(LISTING_LIMIT).toBe(WHOLE_LISTING);
  });
});

describe("which app a connection names", () => {
  test("the app slug comes off the url", () => {
    expect(toolkitOf("composio://gmail")).toBe("gmail");
    expect(toolkitOf("composio://gmail/")).toBe("gmail");
  });

  test("anything that is not a composio url names no app", () => {
    expect(toolkitOf("https://mcp.notion.com/mcp")).toBeNull();
    expect(toolkitOf("composio://")).toBeNull();
    expect(toolkitOf("")).toBeNull();
  });

  test("anything past the app slug means the url does not name one app", () => {
    // This answer is the app a person's connection is checked against — `accessFor` puts it on
    // `ServerAccess.toolkit` (`access.ts:133`) and the brokered gate looks `composio_connections`
    // up by it. A url this function reads loosely is a check performed against the wrong app, so
    // anything it cannot read as exactly one slug has to be no app rather than a best guess.
    expect(toolkitOf("composio://gmail/messages")).toBeNull();
    expect(toolkitOf("composio://gmail?scope=read")).toBeNull();
    expect(toolkitOf("composio://gmail#inbox")).toBeNull();
    expect(toolkitOf("composio://gmail slack")).toBeNull();
  });

  test("surrounding space is taken off before the trailing slash, not after", () => {
    // The strip ran first and the trim second, so a slash that was not the last character survived
    // it: `composio://gmail/ ` answered `"gmail/"`, which matches no row in `composio_connections`
    // and is not the app anybody meant.
    expect(toolkitOf("composio://gmail/ ")).toBe("gmail");
    expect(toolkitOf("composio://gmail  ")).toBe("gmail");
    expect(toolkitOf("composio://google_drive//")).toBe("google_drive");
  });
});

describe("what a label means", () => {
  test("read-only is a read", () => {
    expect(effectOf(["readOnlyHint", "openWorldHint", "gmail"])).toEqual({
      effect: "read",
      destructive: false,
    });
  });

  test("destructive is a destructive write", () => {
    expect(effectOf(["destructiveHint", "important"])).toEqual({
      effect: "write",
      destructive: true,
    });
  });

  test("create and update are writes that are not destructive", () => {
    expect(effectOf(["createHint", "openWorldHint"])).toEqual({
      effect: "write",
      destructive: false,
    });
    expect(effectOf(["updateHint", "labels", "inbox"])).toEqual({
      effect: "write",
      destructive: false,
    });
  });

  test("idempotent is not a read, because deleting is idempotent", () => {
    expect(effectOf(["idempotentHint", "openWorldHint"])).toEqual({
      effect: "write",
      destructive: false,
    });
  });

  test("no label at all is a write", () => {
    // Measured across five apps and never seen, so this branch guards the future rather than the
    // present: an app that labels nothing, or a label added later, must land on write.
    expect(effectOf([])).toEqual({ effect: "write", destructive: false });
    expect(effectOf(undefined)).toEqual({
      effect: "write",
      destructive: false,
    });
    expect(effectOf(["gmail", "inbox"])).toEqual({
      effect: "write",
      destructive: false,
    });
  });

  test("destructive wins over read-only when both are present", () => {
    // Contradictory labels are somebody else's bug, and the safe reading is the strict one.
    expect(effectOf(["readOnlyHint", "destructiveHint"])).toEqual({
      effect: "write",
      destructive: true,
    });
  });
});

describe("finding the vendor's own sentence", () => {
  test("the sentence nested inside the cause is what comes out", () => {
    // The real shape, copied from a live failure. The top-level message is useless.
    const error = Object.assign(new Error("Error executing the tool X"), {
      cause: {
        status: 404,
        headers: { "x-request-id": "must-not-appear" },
        error: {
          error: {
            message:
              "No connected account found for user ID u1 for toolkit gmail",
            code: 1810,
          },
        },
      },
    });

    expect(vendorSentence(error)).toBe(
      "No connected account found for user ID u1 for toolkit gmail",
    );
  });

  test("an error with no such sentence yields nothing rather than a guess", () => {
    expect(vendorSentence(new Error("boom"))).toBeNull();
    expect(vendorSentence({ cause: { error: {} } })).toBeNull();
    expect(vendorSentence(undefined)).toBeNull();
  });

  test("a sentence made only of whitespace is not a sentence", () => {
    // The `.trim()` on the return had nothing asserting it. A blank message that counted as a
    // sentence is worse than none: `callTool` and `listingSentence` both prefer it over their
    // fallbacks, so the reader gets an empty refusal instead of the one line naming what to do.
    expect(vendorSentence(nested(""))).toBeNull();
    expect(vendorSentence(nested("   "))).toBeNull();
    expect(vendorSentence(nested("\n\t "))).toBeNull();
  });

  test("the sentence comes back as it was measured, without its padding", () => {
    // The guard trimmed and the return did not, so the one thing the function had already decided
    // about the string was thrown away again. What comes out is a refusal in a model's context and
    // a sentence in an audit row; leading newlines in both are this module's own untidiness, and
    // the cap that measures the string measures the padding with it.
    expect(vendorSentence(nested("  Gmail rejected the query.\n"))).toBe(
      "Gmail rejected the query.",
    );
  });

  test("a message that is not a string is not read as one", () => {
    // Nothing asserted the type guard either. Composio's payloads are somebody else's JSON, so the
    // field can be a number, an object or null; handed on unchecked, each of those reaches a model's
    // context and an audit row as `[object Object]` or `1810`.
    expect(vendorSentence(nested(1810))).toBeNull();
    expect(vendorSentence(nested(null))).toBeNull();
    expect(vendorSentence(nested({ text: "a nested sentence" }))).toBeNull();
    expect(vendorSentence(nested(["a sentence in a list"]))).toBeNull();
  });

  test("the vendor's placeholder is not a sentence, however deep it arrives", () => {
    /*
     * THE GUARD COVERED THE BRANCH THAT THROWS AND NOT THE ONE THIS FUNCTION READS, which is the
     * half that matters: `listingSentence` and `callTool` both prefer this answer over their own
     * fallbacks, so "Error executing the tool X" found nested inside `cause` walked straight past a
     * check written for exactly that string. This module's own comment calls it the one sentence
     * never worth passing on; a reader who asked for that tool learns from it only that they asked.
     */
    expect(
      vendorSentence(nested("Error executing the tool GMAIL_FETCH_EMAILS")),
    ).toBeNull();
    expect(vendorSentence(nested("  error executing the tool X\n"))).toBeNull();

    // Matched on its opening and not looked for anywhere in the string, because a real sentence
    // that goes on to mention the phrase is still a real sentence.
    expect(
      vendorSentence(
        nested("No connected account found; error executing the tool X."),
      ),
    ).toBe("No connected account found; error executing the tool X.");
  });

  test("the sentence is found where a client error with no wrapper puts it", () => {
    /*
     * ONE DEPTH WAS READ AND TWO ARE THROWN. See {@link unwrapped}: five of this transport's calls
     * surface `@composio/client`'s own `APIError`, which carries the body on `.error` and no
     * `cause`, so `cause.error.error.message` found nothing on any of them and the vendor's
     * readable sentence was skipped in favour of a status code and the whole response body.
     */
    expect(
      vendorSentence(
        unwrapped(
          "No connected account found for user ID u1 for toolkit gmail",
        ),
      ),
    ).toBe("No connected account found for user ID u1 for toolkit gmail");
  });

  test("every judgement this function makes applies at the shallower depth too", () => {
    /*
     * THE POINT OF THE JUDGEMENT LIVING HERE. It was moved into this function so that no caller
     * could reach a sentence without it; a second depth read without it would be that bypass
     * rebuilt. Each of these is the assertion its {@link nested} sibling above makes, asked of the
     * place a client error actually puts the field.
     */
    expect(
      vendorSentence(unwrapped("Error executing the tool GMAIL_FETCH_EMAILS")),
    ).toBeNull();
    expect(
      vendorSentence(unwrapped("  error executing the tool X\n")),
    ).toBeNull();
    expect(vendorSentence(unwrapped(""))).toBeNull();
    expect(vendorSentence(unwrapped("   "))).toBeNull();
    expect(vendorSentence(unwrapped(1810))).toBeNull();
    expect(vendorSentence(unwrapped(null))).toBeNull();
    expect(vendorSentence(unwrapped({ text: "a nested sentence" }))).toBeNull();
    expect(vendorSentence(unwrapped(["a sentence in a list"]))).toBeNull();
    expect(vendorSentence(unwrapped("  Gmail rejected the query.\n"))).toBe(
      "Gmail rejected the query.",
    );
  });

  test("a body with no sentence in it yields nothing rather than the body", () => {
    // The shape `dumped` is named for: nothing at `error.message`, so there is no sentence to find
    // and the function must say so rather than reaching for whatever else the body holds.
    expect(
      vendorSentence(dumped({ detail: "something went wrong" })),
    ).toBeNull();
    expect(vendorSentence(dumped({}))).toBeNull();
  });
});

describe("listing an app's actions", () => {
  test("listing needs no credential", () => {
    expect(listNeedsCredential).toBe(false);
  });

  test("the listing asks for a page, and for one big enough to be the whole list", async () => {
    const asked: unknown[] = [];
    useComposioClient(
      recording({
        listActions: async (toolkit, page) => {
          asked.push({ toolkit, page });
          return [GMAIL_READ];
        },
      }).client,
    );

    await listTools({ url: "composio://gmail" });

    // Composio's default page is 20 and Gmail publishes 63 actions, so an omitted limit truncates.
    // It also NARROWS: `getRawComposioTools` auto-applies `important=true` when no limit, no tags
    // and no search were given (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), and
    // nothing in the short answer says a filter was applied. Asking for a page is therefore not an
    // optimisation, and the seam must not let a caller forget to.
    expect(asked).toEqual([
      { toolkit: "gmail", page: { limit: WHOLE_LISTING } },
    ]);
  });

  test("a listing that filled the biggest page the SDK can ask for is not called complete", async () => {
    useComposioClient(
      recording({
        listActions: async () =>
          Array.from({ length: WHOLE_LISTING }, (_unused, index) => ({
            ...GMAIL_READ,
            slug: `GMAIL_ACTION_${index}`,
          })),
      }).client,
    );

    // `ToolListParamsSchema` accepts no cursor and `getRawComposioTools` drops the response's
    // `next_cursor`, so one page at the API's stated maximum is the largest listing expressible
    // through this SDK. A page that came back full is therefore indistinguishable from a truncated
    // one, and committing it would delete every action past the cut while reporting a success.
    await expect(listTools({ url: "composio://gmail" })).rejects.toThrow(
      /there may be more/i,
    );
  });

  test("an action arrives with its schema, its effect and its version", async () => {
    // RECORDED AND ASSERTED AFTERWARDS, NOT CHECKED INSIDE THE STUB. `listTools` wraps this call in
    // the try that turns a throw into `listingSentence`'s sentence, so a failed `expect` in there
    // is not a failed test: it is swallowed and re-emerges as a refusal about Composio, which this
    // test would then report as a listing failure rather than as the wrong app being asked for.
    const asked: string[] = [];
    const { client } = recording({
      listActions: async (toolkit) => {
        asked.push(toolkit);
        return [GMAIL_READ];
      },
    });
    useComposioClient(client);

    expect(await listTools({ url: "composio://gmail" })).toEqual([
      {
        name: "GMAIL_FETCH_EMAILS",
        description: "Fetch emails.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        effect: "read",
        destructive: false,
        version: "20260903_00",
      },
    ]);
    expect(asked).toEqual(["gmail"]);
  });

  test("an action that stages a file is not offered at all", async () => {
    useComposioClient(
      recording({
        listActions: async () => [
          GMAIL_READ,
          {
            slug: "GMAIL_SEND_EMAIL",
            description: "Send an email.",
            tags: ["createHint"],
            version: "20260903_00",
            inputParameters: {
              type: "object",
              properties: {
                recipient: { type: "string" },
                // What the SDK hands on under its default file handling: the vendor's own staging
                // descriptor, untouched. `dangerouslyAllowAutoUploadDownloadFiles` is off unless a
                // client asks for it (`src/models/Tools.ts:136`, `:242-248`), and only that flag
                // collapses the shape. An `s3key` is issued by an upload nothing here performs.
                attachment: {
                  type: "object",
                  file_uploadable: true,
                  properties: {
                    name: { type: "string" },
                    mimetype: { type: "string" },
                    s3key: { type: "string" },
                  },
                },
              },
              required: ["recipient", "attachment"],
            },
          },
        ],
      }).client,
    );

    const listed = await listTools({ url: "composio://gmail" });

    // Dropped rather than offered with a field the model can only invent. Offering it guarantees a
    // hallucinated key and a rejection at the vendor's staging lookup, and a grant recorded against
    // a name that can never work.
    expect(listed.map((tool) => tool.name)).toEqual(["GMAIL_FETCH_EMAILS"]);
  });

  test("a file parameter reached through $defs and a variant is found too", async () => {
    useComposioClient(
      recording({
        listActions: async () => [
          GMAIL_READ,
          {
            slug: "GMAIL_GET_ATTACHMENT",
            version: "20260903_00",
            inputParameters: {
              type: "object",
              properties: { body: { $ref: "#/$defs/upload" } },
              $defs: {
                upload: {
                  anyOf: [
                    { type: "null" },
                    { type: "string", file_uploadable: true },
                  ],
                },
              },
            },
          },
        ],
      }).client,
    );

    // Composio toolkits routinely express the flag through a `$ref`/`$defs` indirection, which is
    // why the SDK's own predicate walks `$defs` and every composed variant
    // (`src/utils/modifiers/FileToolModifier.utils.neutral.ts:77-134`). A walk that stopped at
    // `properties` would answer false for every ref-based schema and offer it anyway.
    const listed = await listTools({ url: "composio://gmail" });
    expect(listed.map((tool) => tool.name)).toEqual(["GMAIL_FETCH_EMAILS"]);
  });

  test("a file parameter is found down every subschema keyword the SDK keeps", async () => {
    /*
     * ONE CASE PER KEYWORD, because a keyword the walk does not descend is an action offered to a
     * model under BOTH auto-upload settings — the parameter is either a bucket key nobody here can
     * issue or a server-side path nobody should promise — so every call against it fails.
     *
     * `additionalProperties` is the one that was missing, and it is not exotic: both
     * `ParametersSchema` and `JSONSchemaPropertySchema` keep it as a full subschema
     * (`@composio/core` 0.18.1, `src/types/tool.types.ts:154` and `:111`), which is precisely how a
     * toolkit spells "a bag of attachments". The rest were already walked and asserted by nothing.
     */
    const hidden: { where: string; schema: Record<string, unknown> }[] = [
      {
        where: "additionalProperties at the root",
        schema: { type: "object", additionalProperties: FILE_PROPERTY },
      },
      {
        where: "additionalProperties under a property",
        schema: underProperty("additionalProperties", FILE_PROPERTY),
      },
      {
        where: "patternProperties at the root",
        schema: {
          type: "object",
          patternProperties: { "^attachment_": FILE_PROPERTY },
        },
      },
      {
        where: "patternProperties under a property",
        schema: underProperty("patternProperties", { any: FILE_PROPERTY }),
      },
      {
        where: "not at the root",
        schema: { type: "object", not: FILE_PROPERTY },
      },
      { where: "not", schema: underProperty("not", FILE_PROPERTY) },
      { where: "if", schema: underProperty("if", FILE_PROPERTY) },
      { where: "then", schema: underProperty("then", FILE_PROPERTY) },
      { where: "else", schema: underProperty("else", FILE_PROPERTY) },
      { where: "items", schema: underProperty("items", FILE_PROPERTY) },
      {
        where: "items as a tuple",
        schema: underProperty("items", [{ type: "string" }, FILE_PROPERTY]),
      },
      { where: "oneOf", schema: underProperty("oneOf", [FILE_PROPERTY]) },
      { where: "allOf", schema: underProperty("allOf", [FILE_PROPERTY]) },
      {
        where: "definitions at the root",
        schema: {
          type: "object",
          properties: { body: { $ref: "#/definitions/upload" } },
          definitions: { upload: FILE_PROPERTY },
        },
      },
    ];

    for (const { where, schema } of hidden) {
      useComposioClient(listing(schema));
      const listed = await listTools({ url: "composio://gmail" });
      // The keyword is carried into the comparison so a failure names which one escaped.
      expect({ where, offered: listed.map((tool) => tool.name) }).toEqual({
        where,
        offered: ["GMAIL_FETCH_EMAILS"],
      });
    }
  });

  test("an action is dropped only where the flag is actually set", async () => {
    /*
     * THE OTHER HALF OF THE WALK, which decides what stays offered. `file_uploadable` is
     * `z.boolean().optional()` (`src/types/tool.types.ts:89`), so `false` is a value the vendor
     * really sends and the comparison against `true` rather than against truthiness is what keeps
     * it from dropping an action nobody has to stage anything for. `additionalProperties` is a
     * union with `boolean` (`:111`, `:154`), so `true` and `false` arrive there as values and the
     * walk has to read them as "not a subschema" instead of tripping over them.
     */
    const offered: { where: string; schema: Record<string, unknown> }[] = [
      {
        where: "the flag is explicitly false",
        schema: {
          type: "object",
          properties: { note: { type: "string", file_uploadable: false } },
        },
      },
      {
        where: "additionalProperties is open",
        schema: { type: "object", additionalProperties: true },
      },
      {
        where: "additionalProperties is closed",
        schema: { type: "object", additionalProperties: false },
      },
    ];

    for (const { where, schema } of offered) {
      useComposioClient(listing(schema));
      const listed = await listTools({ url: "composio://gmail" });
      expect({ where, offered: listed.map((tool) => tool.name) }).toEqual({
        where,
        offered: ["GMAIL_FETCH_EMAILS", "GMAIL_STAGES_A_FILE"],
      });
    }
  });

  test("the schema a model is shown is the one the SDK handed over, unaltered", async () => {
    /*
     * A CHARACTERIZATION TEST, and it passed before the claim beside `inputParameters` was
     * corrected — the correction is to a comment, because the loss it describes happens inside
     * `ToolSchema.parse` and there is no key left here to restore.
     *
     * What it pins is the narrower promise that replaced the false one: this module adds nothing to
     * the schema and removes nothing from it. The keys below are ones `ParametersSchema` and
     * `JSONSchemaPropertySchema` would have stripped, so a real client never delivers them — which
     * is exactly why they are the right probe for whether anything HERE also strips. `listTools`
     * now walks the schema looking for a file parameter, and a walk that rebuilt what it read
     * would silently narrow every schema in the listing.
     */
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", deprecated: true, contentEncoding: "utf-8" },
      },
      if: { required: ["query"] },
      // No `then` beside it: biome bans a `then` key on an object literal, and the point of these
      // is only that they are root keywords `ParametersSchema` does not name.
      else: { required: [] },
      examples: [{ query: "is:unread" }],
      "x-openbot-probe": "kept",
    };
    /*
     * SNAPSHOTTED BEFORE THE CALL, because comparing the answer to `schema` compares it to the very
     * object the stub handed over. `toEqual` between two references to one object holds whatever
     * happened in between, so an in-place `delete` inside `listTools` — a walk that pruned what it
     * read — passed this test unchanged. Proven: one added `delete` of a root keyword in the map
     * left all 44 tests green.
     *
     * The snapshot is what the SDK handed over. The first assertion is that a model is shown that;
     * the second is that the vendor's own object still IS that, because a module returning a
     * faithful copy while wrecking the original would corrupt every later reader of one listing.
     */
    const asHandedOver = structuredClone(schema);
    useComposioClient(
      recording({
        listActions: async () => [{ ...GMAIL_READ, inputParameters: schema }],
      }).client,
    );

    const [tool] = await listTools({ url: "composio://gmail" });
    expect(tool?.inputSchema).toEqual(asHandedOver);
    expect(schema).toEqual(asHandedOver);
  });

  test("an action with no schema is still listed, with an open one", async () => {
    useComposioClient(
      recording({
        listActions: async () => [
          { slug: "GMAIL_ODD", tags: ["updateHint"], version: "20260903_00" },
        ],
      }).client,
    );

    const [tool] = await listTools({ url: "composio://gmail" });

    // Offered rather than dropped: the vendor is the right party to reject a bad argument, and a
    // silently missing action reads to an administrator as an app that does not have it.
    expect(tool?.name).toBe("GMAIL_ODD");
    expect(tool?.inputSchema).toEqual({});
    expect(tool?.effect).toBe("write");
  });

  test("an action Composio published no version for is listed with no version key", async () => {
    useComposioClient(
      recording({
        listActions: async () => [
          { slug: "GMAIL_UNVERSIONED", tags: ["readOnlyHint"] },
        ],
      }).client,
    );

    const [tool] = await listTools({ url: "composio://gmail" });

    // The branch that spreads the key only when the vendor sent one had nothing exercising it:
    // every listing stub above carries a version. What it guards is not cosmetic. `store.ts`
    // writes `tool.version ?? null`, so a key present and empty would be recorded as a version this
    // deployment believes it has, and `callTool` would send `""` to a vendor that rejects it —
    // instead of the refusal that names what the reader can and cannot do about it.
    expect(Object.keys(tool ?? {})).not.toContain("version");
    expect(tool?.name).toBe("GMAIL_UNVERSIONED");
    expect(tool?.effect).toBe("read");
  });

  test("a listing nobody was asked for throws rather than answering empty", async () => {
    // `[]` means "the vendor was asked and advertises none" everywhere else in this codebase, and
    // `refreshTools` commits it as a healthy refresh. No client installed is the SHIPPED state —
    // nothing under `server/src` calls `useComposioClient` — so `[]` here was the only answer a
    // real Composio refresh could produce, and committing it deleted every recorded action.
    const refused = listTools({ url: "composio://gmail" });

    await expect(refused).rejects.toThrow(
      /not configured for this deployment/i,
    );

    const thrown = (await refused.catch((error: unknown) => error)) as Error;
    expect(thrown.message).toContain("gmail");
    // Not a crash report. No deployment installs a client yet, so an operator reading this has to
    // recognise a state rather than go hunting for a fault.
    expect(thrown.message).toMatch(/expected/i);
  });

  test("a url that names no app throws about the url, and asks nobody", async () => {
    /*
     * THE REFUSAL IS ONLY HALF THE CLAIM, and this test used to make only that half.
     *
     * With the default stub answering `[]`, nothing here noticed whether Composio had been asked
     * at all — so the guard could be moved to after the dial and every assertion below still
     * passed, while the transport handed `https://example.com` to the vendor as an app slug. That
     * is the failure the guard exists to prevent: `toolkitOf` is what keeps a url this deployment
     * cannot read from becoming a request, and a test that cannot tell a refusal from a round trip
     * is not testing the guard.
     */
    const asked: unknown[] = [];
    useComposioClient(
      recording({
        listActions: async (toolkit, page) => {
          asked.push({ toolkit, page });
          return [];
        },
      }).client,
    );

    const refused = listTools({ url: "https://example.com" });

    // The two refusals send an operator to different places — one to this deployment's
    // configuration, one to the row — so they must not share a sentence.
    await expect(refused).rejects.toThrow(/does not name a Composio app/i);

    const thrown = (await refused.catch((error: unknown) => error)) as Error;
    expect(thrown.message).not.toMatch(/not configured/i);
    expect(thrown.message).toContain("https://example.com");
    expect(asked).toEqual([]);
  });

  test("a listing the vendor's own schema rejects throws a sentence, not a Zod dump", async () => {
    const issues = [
      {
        code: "invalid_type",
        expected: "string",
        received: "number",
        path: ["slug"],
        message: "Expected string, received number",
      },
    ];
    useComposioClient(
      recording({
        listActions: async () => {
          // What `ToolSchema` throws: `message` is the issue array as JSON, which is what would land
          // in `lastError` and, before `refreshTools` existed, in a model's context.
          throw Object.assign(new Error(JSON.stringify(issues, null, 2)), {
            name: "ZodError",
            issues,
          });
        },
      }).client,
    );

    const refused = listTools({ url: "composio://gmail" });

    // Propagated rather than answered empty, because `refreshTools` records a throw in `lastError`
    // and leaves the tools it already holds alone. An empty answer would read as an app that has no
    // actions, and every grant would point at a name nothing advertises.
    await expect(refused).rejects.toThrow(/did not match/i);

    const thrown = await refused.catch((error: unknown) => error);
    expect(String((thrown as Error).message)).not.toContain("invalid_type");
    expect(String((thrown as Error).message)).toContain("gmail");
  });

  test("a listing that failed with nothing said still names the app it was about", async () => {
    // The other arm of `listingSentence`'s fallback, which nothing reached. `refreshTools` puts
    // this string in the row's `lastError` and an administrator reads it off the Plugins page, so
    // a blank one is a refresh that reports having failed and declines to say about what.
    for (const thrown of [{ status: 502 }, new Error(""), new Error("   ")]) {
      useComposioClient(
        recording({
          listActions: async () => {
            throw thrown;
          },
        }).client,
      );

      const message = await listTools({ url: "composio://gmail" }).then(
        () => "",
        (error: unknown) => (error as Error).message,
      );

      expect(message.trim()).not.toBe("");
      expect(message).toContain("gmail");
    }
  });

  test("a listing failure carrying only the vendor's placeholder says something else", async () => {
    /*
     * `callTool` already refuses to pass "Error executing the tool X" on, and the listing path did
     * not. Same string, same reader: `refreshTools` writes this sentence into the row's
     * `lastError` and an administrator reads it off the Plugins page, where the name of the thing
     * they asked to refresh is the one fact they already have.
     */
    useComposioClient(
      recording({
        listActions: async () => {
          throw new Error("Error executing the tool GMAIL_FETCH_EMAILS");
        },
      }).client,
    );

    const message = await listTools({ url: "composio://gmail" }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message).not.toMatch(/error executing the tool/i);
    expect(message).toContain("gmail");
  });

  test("a listing refusal this deployment authored beats whatever the vendor said", async () => {
    /*
     * THE RULE THIS PATH NEVER ASKED ABOUT. `routes.ts` reads `brokerSentence` first and
     * `vendorSentence` second, and `callTool`'s own catch was corrected to the same order; this one
     * consulted `brokerSentence` nowhere at all. `./composio-adapter`'s `askVendor` wraps the raw
     * tool listing exactly as it wraps the execute, so a `BrokerRefusalError` arrives here as
     * readily as it arrives there — and an authored sentence is the only one that names the step
     * that clears the condition.
     *
     * WHAT IT LOST TO IS A READ ONE LEVEL SHALLOW, the same way it did on the call path.
     * `vendorRefusal` authors only where `vendorSentence` of the ORIGINAL was null, so asking the
     * WRAPPER the same question lands somewhere the adapter never judged and comes back with
     * whatever sits there — below, two words naming nothing, in place of a remedy.
     */
    const authored =
      'Composio refuses a call whose toolkit version is "latest", and that is the version travelling with this one, so gmail\'s action list was not refreshed and the tools already held are untouched. A dated version is recorded when an app\'s actions are listed, so refreshing gmail\'s tools on its Plugins page replaces "latest" with a version Composio will accept.';

    useComposioClient(
      recording({
        listActions: async () => {
          throw new BrokerRefusalError(authored, {
            cause: { error: { error: { message: "Invalid request" } } },
          });
        },
      }).client,
    );

    const message = await listTools({ url: "composio://gmail" }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    // Pinned whole rather than by a fragment, for the reason its sibling on the call path is: a
    // substring check passes on a sentence joined to the vendor's or cut short of the remedy.
    expect(message).toBe(authored);
    expect(message).not.toContain("Invalid request");
  });

  test("a listing that failed with no wrapper still carries the vendor's sentence", async () => {
    /*
     * `./composio-adapter`'s listing calls `getRawComposioTools`, which awaits
     * `this.client.tools.list` with no try around it, so what lands here is `@composio/client`'s
     * own error — see {@link unwrapped}. `refreshTools` writes this string into the row's
     * `lastError` for an administrator to read off the Plugins page, and what it used to write was
     * a status code followed by the entire response body.
     */
    useComposioClient(
      recording({
        listActions: async () => {
          throw unwrapped("Composio holds no auth config for gmail.");
        },
      }).client,
    );

    const message = await listTools({ url: "composio://gmail" }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message).toBe("Composio holds no auth config for gmail.");
    // The error carries the whole HTTP response beside the sentence. None of it belongs on an
    // admin page, in an audit row, or in a model's context.
    expect(message).not.toContain("must-not-appear");
    expect(message).not.toContain("x-request-id");
  });

  test("a listing failure whose body says nothing is not answered with the body", async () => {
    /*
     * WHAT ESCAPES WHEN THERE IS NO SENTENCE HAS TO BE WORTH SHOWING. `APIError` builds its message
     * by JSON-stringifying the whole body behind the status code where the body has no top-level
     * `message`, so the fallback to the thrown message handed an operator a response dump — the
     * same thing the Zod-dump refusal above exists to stop, arriving through a different door.
     */
    useComposioClient(
      recording({
        listActions: async () => {
          throw dumped({
            detail: [{ loc: ["body", "toolkit"], msg: "unrecognised" }],
            request_id: "must-not-appear",
          });
        },
      }).client,
    );

    const message = await listTools({ url: "composio://gmail" }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message).not.toContain("must-not-appear");
    expect(message).not.toContain("unrecognised");
    expect(message).not.toContain("{");
    expect(message).toContain("gmail");
  });

  test("a destructive action is listed as destructive", async () => {
    /*
     * THE ONE CLASSIFICATION THAT MATTERS MOST, AND NOTHING STOOD OVER IT. `effectOf` is asserted
     * on both answers directly, but every assertion that reached this mapping asserted
     * `destructive: false` — so hardcoding `destructive: false` here left the whole suite green,
     * and the field a Bot is gated on before it runs a dangerous action was pinned by nobody.
     *
     * `store.ts` records it on the `mcp_tools` row and a grant is what a person approves against
     * it: an action recorded as safe that deletes a mailbox is approved once and run for ever.
     */
    useComposioClient(
      recording({
        listActions: async () => [
          GMAIL_READ,
          {
            slug: "GMAIL_DELETE_MESSAGE",
            description: "Delete a message.",
            tags: ["destructiveHint"],
            version: "20260903_00",
          },
        ],
      }).client,
    );

    const listed = await listTools({ url: "composio://gmail" });

    // Both rows, so the assertion fails on a mapping that hardcodes EITHER answer rather than
    // reading the labels.
    expect(
      listed.map((tool) => `${tool.name}: ${tool.effect}/${tool.destructive}`),
    ).toEqual([
      "GMAIL_FETCH_EMAILS: read/false",
      "GMAIL_DELETE_MESSAGE: write/true",
    ]);
  });

  test("an action Composio described in no words is listed with an empty description", async () => {
    /*
     * `description` is optional on the vendor's tool and `ListedTool`'s is not, so the mapping has
     * to supply something. Nothing asserted which: `?? "no description available"`, `?? tool.name`
     * and `?? null` all left the suite green, and the last of those is a row `store.ts` writes as
     * NULL against a NOT NULL column.
     *
     * The empty string is the honest answer — the vendor said nothing, so this deployment says
     * nothing rather than inventing a sentence a model will read as the action's own.
     */
    useComposioClient(
      recording({
        listActions: async () => [
          { slug: "GMAIL_ODD", tags: ["readOnlyHint"], version: "20260903_00" },
        ],
      }).client,
    );

    const [tool] = await listTools({ url: "composio://gmail" });

    expect(tool?.description).toBe("");
    // Asserted separately from `toEqual`, which treats a key holding `undefined` as a key that is
    // not there and would accept the fallback being dropped altogether.
    expect(Object.keys(tool ?? {})).toContain("description");
  });

  test("an answer that is not a list of actions throws a sentence, not a TypeError", async () => {
    /*
     * `ComposioActions` is OUR projection of the vendor, implemented by an adapter nobody has
     * written yet, and TypeScript polices none of what a promise actually resolves to at runtime.
     * A client that answers `null` — a 204, an SDK path that returns before assigning, a mock in
     * somebody's staging deployment — used to reach `actions.length` and `actions.filter` outside
     * the try that wraps the vendor's call, so what propagated was `null is not an object`. That
     * lands verbatim in `lastError` on the Plugins page and tells an administrator nothing about
     * which app or what to do, which is the whole reason this path throws sentences.
     */
    // `[null]` is the same failure one level down: it clears `Array.isArray` and then reaches
    // `action.inputParameters` in the filter, which is outside that try as well.
    // NOT `"gmail"` AS THE SCALAR, which is what this loop used to carry: the assertion below is
    // that the sentence names the app, and a shape that IS the app's name satisfies it whether the
    // name came from the url or from the malformed answer being echoed back.
    for (const shape of [
      null,
      undefined,
      { items: [] },
      "an action list",
      [null],
    ]) {
      useComposioClient(
        recording({
          listActions: async () => shape as unknown as ComposioAction[],
        }).client,
      );

      const message = await listTools({ url: "composio://gmail" }).then(
        () => "",
        (error: unknown) => (error as Error).message,
      );

      expect(message).toContain("gmail");
      expect(message).not.toMatch(/is not an object|is not a function/i);
    }
  });

  test("an action with no slug breaks the listing rather than being dropped from it", async () => {
    /*
     * The slug is the action's whole identity: `name` in `mcp_tools`, which is NOT NULL and half
     * the primary key, the string a grant records, and the `slug` `callTool` sends back to call it.
     * An element without one reached the map and became a tool named `undefined`, so one malformed
     * action in a listing of sixty took the entire app's refresh down on the insert.
     *
     * REFUSED RATHER THAN SKIPPED, which is what this asserts. Skipping would hand `refreshTools` a
     * SHORT listing, and it commits a listing as the complete truth about the app: the replace is a
     * delete and an insert, so every recorded action missing from it is deleted along with its
     * `version`, under a refresh that reported success. Nobody could even be told which action went
     * missing, because the thing that names it is the thing that is not there.
     */
    for (const slug of [undefined, null, "", "   ", 7]) {
      useComposioClient(
        recording({
          listActions: async () =>
            [
              GMAIL_READ,
              { slug, description: "Nameless.", tags: ["readOnlyHint"] },
            ] as unknown as ComposioAction[],
        }).client,
      );

      const outcome = await listTools({ url: "composio://gmail" }).then(
        () => "the listing was committed",
        (error: unknown) => (error as Error).message,
      );

      // The success arm says nothing about a slug, so this is the refusal and not a message match.
      expect(outcome).toContain("slug");
      expect(outcome).toContain("gmail");
    }
  });

  test("a version made only of whitespace is recorded as no version at all", async () => {
    /*
     * TRIMMED ON THE WAY IN BECAUSE IT IS TRIMMED ON THE WAY OUT. `callTool` trims the recorded
     * version and refuses an empty one, so a blank string that counts as a version here is written
     * to `mcp_tools` as a version this deployment believes it has and is then permanently
     * unusable — and the refusal the caller gets names a refresh, which rewrites the same blank.
     * That is exactly the loop the test above reasons about, reached by recording rather than by
     * the vendor publishing nothing.
     */
    useComposioClient(
      recording({
        listActions: async () => [
          { slug: "GMAIL_BLANK", tags: ["readOnlyHint"], version: "   " },
          {
            slug: "GMAIL_PADDED",
            tags: ["readOnlyHint"],
            version: " 20260903_00\n",
          },
        ],
      }).client,
    );

    const [blank, padded] = await listTools({ url: "composio://gmail" });

    expect(Object.keys(blank ?? {})).not.toContain("version");
    // Recorded as the version `callTool` will actually send, rather than as one it has to repair.
    expect(padded?.version).toBe("20260903_00");
  });

  test("the name recorded is the slug the guard measured, without its padding", async () => {
    /*
     * The guard above admits an action by measuring `slug.trim()`, and the version beside it is
     * recorded trimmed for a reason this file writes down — so the name went to `mcp_tools` and on
     * to Composio with the padding still on it. That name is NOT NULL and half the primary key, it
     * is what a grant records, and it is the `slug` `callTool` sends back; a row keyed on
     * " GMAIL_FETCH_EMAILS " is a different action from the one anybody granted.
     */
    useComposioClient(
      recording({
        listActions: async () => [
          { ...GMAIL_READ, slug: " GMAIL_FETCH_EMAILS\n" },
        ],
      }).client,
    );

    const [tool] = await listTools({ url: "composio://gmail" });

    expect(tool?.name).toBe("GMAIL_FETCH_EMAILS");
  });

  test("a slug listed twice is listed twice, because the collision is settled downstream", async () => {
    /*
     * WHY THIS IS NOT A FIFTH REFUSAL, written down because it was proposed as one. `mcp_tools`
     * holds one row per name, so a vendor naming an action twice IS a collision — and
     * `storableTools` in `./store` already resolves it before a transaction is opened, keying the
     * insert by name and keeping the first occurrence. "a vendor naming one action twice records it
     * once" in `plugin-store.integration.test.ts` pins that end: one row, and `lastError` null.
     * Refusing here would replace a healthy refresh with a total failure and strand every grant on
     * the app — the loss the refusals around this one exist to prevent, caused by one of them.
     *
     * WHAT THIS PATH DOES OWE THAT DE-DUPLICATION is the name it de-duplicates by. The map records
     * the trimmed slug, so two spellings of one action arrive downstream as one name rather than
     * as two rows the database will happily keep apart.
     */
    useComposioClient(
      recording({
        listActions: async () => [
          GMAIL_READ,
          {
            ...GMAIL_READ,
            slug: "  GMAIL_FETCH_EMAILS  ",
            description: "Fetch emails, listed again.",
            version: "20260101_00",
          },
        ],
      }).client,
    );

    const listed = await listTools({ url: "composio://gmail" });

    expect(listed.map((tool) => tool.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_EMAILS",
    ]);
  });

  test("tags that are not a list of labels break the listing rather than the runtime", async () => {
    /*
     * `effectOf` builds a Set out of whatever is in this field, and the element guard above only
     * settles that the action is an object. A `tags` that is not iterable throws
     * `{} is not iterable` out of a map that sits OUTSIDE the try wrapping the vendor's call, so
     * that string is what `refreshTools` writes into `lastError` for a person to read.
     *
     * A STRING IS THE WORSE HALF, because it does not throw at all: `new Set("readOnlyHint")`
     * yields its characters, no hint matches, and a read-only action is recorded as a write. That
     * is the silent wrong answer a refusal exists to prevent, so both shapes are refused rather
     * than repaired.
     */
    for (const tags of [{}, "readOnlyHint", 7, { 0: "readOnlyHint" }]) {
      useComposioClient(
        recording({
          listActions: async () =>
            [
              GMAIL_READ,
              { slug: "GMAIL_ODD", description: "Odd labels.", tags },
            ] as unknown as ComposioAction[],
        }).client,
      );

      const outcome = await listTools({ url: "composio://gmail" }).then(
        () => "the listing was committed",
        (error: unknown) => (error as Error).message,
      );

      expect(outcome).not.toBe("the listing was committed");
      expect(outcome).toContain("GMAIL_ODD");
      expect(outcome).toContain("gmail");
      expect(outcome).not.toMatch(/is not iterable|is not a function/i);
    }
  });

  test("a vendor complaint that merely carries issues is not answered with an upgrade", async () => {
    /*
     * `isSchemaMismatch` duck-types on the PRESENCE of an `issues` array, and an array under that
     * name is not the vendor's SDK refusing its own answer. A gateway's validation payload carries
     * one, and so does any error somebody built with a list of complaints in it. Read as a schema
     * mismatch, the one sentence saying what actually went wrong is replaced by an instruction to
     * upgrade a package that is working perfectly.
     */
    for (const thrown of [
      Object.assign(
        new Error(
          "Composio's gmail gateway rejected the query: from: is not a search operator.",
        ),
        { issues: ["from: is not a search operator."] },
      ),
      Object.assign(new Error("Composio rejected the request for gmail."), {
        issues: [{ field: "query", reason: "required" }],
      }),
    ]) {
      useComposioClient(
        recording({
          listActions: async () => {
            throw thrown;
          },
        }).client,
      );

      const message = await listTools({ url: "composio://gmail" }).then(
        () => "",
        (error: unknown) => (error as Error).message,
      );

      // PINNED WHOLE RATHER THAN BY THE ONE WORD EVERY CANDIDATE ANSWER CONTAINS. "rejected" is in
      // the fixture, so it survived the sentence being wrapped, prefixed or cut short — and both
      // of the answers this branch must not give, the upgrade advice and "Composio did not answer
      // with an action list for gmail.", are sentences a fragment check cannot tell from this one.
      expect(message).toBe(thrown.message);
      // And it names the row the operator is looking at, which is what every sibling refusal on
      // this path asserts and this one did not: `refreshTools` writes this string into `lastError`
      // and an administrator reads it off the Plugins page beside a list of apps.
      expect(message).toContain("gmail");
      expect(message).not.toMatch(/upgrad/i);
    }
  });

  test("a listing left empty by the file filter is not committed as an app with no actions", async () => {
    /*
     * THE FILTER CAN EMPTY A LISTING, and an empty listing is the one thing this function's four
     * other refusals exist to prevent. `refreshTools` commits a listing as the complete truth
     * about the app — the replace is a delete and an insert — so every recorded action goes, with
     * its `effect`, `destructive` and `version`, under a refresh that reported success. The
     * versions are the loss no later refresh repairs where Composio publishes none.
     *
     * An app whose actions all stage files is not an app with no actions, and the sentence has to
     * say which of the two this is.
     */
    const onlyFiles = [
      {
        slug: "GMAIL_SEND_EMAIL",
        description: "Send an email.",
        tags: ["createHint"],
        version: "20260903_00",
        inputParameters: {
          type: "object",
          properties: { attachment: FILE_PROPERTY },
        },
      },
      {
        slug: "GMAIL_REPLY_TO_THREAD",
        description: "Reply to a thread.",
        tags: ["createHint"],
        version: "20260903_00",
        inputParameters: {
          type: "object",
          properties: { attachment: FILE_PROPERTY },
        },
      },
    ];
    useComposioClient(recording({ listActions: async () => onlyFiles }).client);

    const outcome = await listTools({ url: "composio://gmail" }).then(
      (listed) => `the listing was committed with ${listed.length} actions`,
      (error: unknown) => (error as Error).message,
    );

    expect(outcome).not.toContain("committed");
    expect(outcome).toContain("gmail");
    expect(outcome).toMatch(/file/i);
    // The COUNT, which is the only thing separating this refusal from the empty answer asserted
    // below. Both are listings with nothing left in them; a sentence that did not say how many
    // actions the app really published would send an operator looking for the wrong fault.
    expect(outcome).toContain("2");

    /*
     * AND THE VENDOR'S OWN EMPTY ANSWER IS STILL AN ANSWER, which is a decision this file shares
     * with `store.ts` rather than one it makes alone.
     *
     * `@composio/core` does manufacture an empty listing out of a response it could not read —
     * `getRawComposioTools` ends `if (!tools) { return []; }` (0.18.1,
     * `src/models/Tools.ts:553-557`) — so the hazard of committing `[]` is real. It is answered at
     * the layer that does the committing: `refreshTools` has its own empty-listing guard, which
     * keeps every recorded action with its `effect`, `destructive` and `version` whenever an app
     * that holds actions lists none, and stamps no refresh
     * (`plugin-store.integration.test.ts`, "a refresh the vendor answered with no actions at all").
     *
     * Refusing here as well would buy nothing that guard does not hold, and would cost the case it
     * is careful to allow: an app that genuinely advertises nothing stays recordable instead of
     * reading as broken for good. The refusal above is about a listing this deployment emptied,
     * not one that arrived empty.
     */
    useComposioClient(recording({ listActions: async () => [] }).client);
    expect(await listTools({ url: "composio://gmail" })).toEqual([]);
  });
});

describe("calling one action", () => {
  test("the call runs as the connection's actor, at the recorded version", async () => {
    const { client, calls } = recording();
    useComposioClient(client);

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { query: "is:unread", __version: "20260903_00" },
    );

    expect(calls).toEqual([
      {
        toolkit: "gmail",
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_asker",
        version: "20260903_00",
        args: { query: "is:unread" },
      },
    ]);
    expect(result.isError).toBe(false);
  });

  test("the app goes out with the call, and follows the url when the url changes", async () => {
    /*
     * THE DEEPEST HOLE THIS TRANSPORT HAD. `toolkitOf` resolved the app, `accessFor` gated the
     * person's `composio_connections` row on it, and then the call went out as the slug alone —
     * and a slug is what a LISTING recorded, not what the url says now. A url edited between a
     * refresh and a call was therefore gated on the app it names today and run against the app it
     * named when the tools were last read: a person who connected Slack satisfying the gate for a
     * Gmail action that still runs in their Gmail.
     *
     * Composio's wire cannot carry the pair — `ToolExecuteParams` has no toolkit field and
     * `tools.execute(toolSlug, params)` takes the slug alone (`@composio/client` 0.1.0-alpha.76,
     * `resources/tools.d.ts:480-493` and `:41`) — so what binds them here is that the app is an
     * argument of the call this module makes and an implementation has to reconcile it with the
     * tool it resolves. Asserting it is passed asserts the implementation was handed the fact it
     * needs; asserting it FOLLOWS the url is the part a check performed and then discarded could
     * never show, and discarding it was the defect.
     */
    const { client, calls } = recording();
    useComposioClient(client);

    for (const app of ["gmail", "slack"]) {
      await callTool(
        { url: `composio://${app}`, actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );
    }

    expect(calls.map((call) => call.toolkit)).toEqual(["gmail", "slack"]);
  });

  test("the version is not passed on to the vendor as an argument", async () => {
    const seen: Record<string, unknown>[] = [];
    useComposioClient(
      recording({
        execute: async (_call, args) => {
          seen.push(args);
          return answered({});
        },
      }).client,
    );

    // Held in a variable rather than written inline, because `seen` showing the version absent
    // shows it only of whatever object the module chose to pass on. Deleting the key from the
    // CALLER'S object and forwarding that satisfies the assertion below while destroying the
    // record the call path still holds — the same identity-for-value mistake the schema test had.
    const args = { query: "is:unread", __version: "20260903_00" };
    await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      args,
    );

    expect(seen).toEqual([{ query: "is:unread" }]);
    expect(args).toEqual({ query: "is:unread", __version: "20260903_00" });
  });

  test("a call with no recorded version refuses rather than guessing one", async () => {
    const { client, calls } = recording();
    useComposioClient(client);

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      {},
    );

    // Composio refuses a call without a specific version and refuses "latest" too. A guessed version
    // is a call against some other revision of the action, which is worse than not calling.
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/version/i);
    expect(calls).toEqual([]);

    // The refusal used to name a refresh as THE fix, unconditionally. It is not one where the
    // vendor published no version: `listTools` sets the field only when Composio sent one, so a
    // refresh writes the same nothing back and the reader presses the button again. The sentence
    // has to make the remedy conditional on the vendor, which is the part nobody here controls.
    expect(result.text).not.toContain(
      "Refresh this app's tools on its Plugins page and try again.",
    );
    expect(result.text).toMatch(/only if Composio publishes/i);
  });

  test("the version goes out without its padding, and padding alone is no version", async () => {
    /*
     * THE CALL SIDE OF A TRIM THE LISTING SIDE ALREADY TESTS. "a version made only of whitespace is
     * recorded as no version at all" pins what `listTools` writes; nothing pinned what `callTool`
     * sends, so the `.trim()` here could be deleted with the whole suite green.
     *
     * BOTH HALVES OF IT MATTER AND THEY FAIL DIFFERENTLY. A padded version forwarded as it arrived
     * is a string Composio does not match to any revision of the action — the call fails at the
     * vendor, wearing the vendor's words, for a fault that is this deployment's. A version made
     * only of padding is not a version at all, and read as one it sends `"   "` where the module's
     * own refusal says there is nothing to fall back on; the recorded-version guard is the thing
     * that keeps that off the wire, and it is the trim that lets the guard see it.
     *
     * The same two shapes the listing side uses, reached from the other end: `mcp_tools` holds what
     * `listTools` wrote, and `store.ts` hands it back through `__version` on the next call.
     */
    const { client, calls } = recording();
    useComposioClient(client);

    const padded = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: " 20260903_00\n" },
    );

    expect(padded.isError).toBe(false);
    expect(calls.map((call) => call.version)).toEqual(["20260903_00"]);

    const blank = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "   " },
    );

    expect(blank.isError).toBe(true);
    expect(blank.text).toMatch(/no recorded version/i);
    // Refused before dialling, which is the half a message match cannot show: nothing was added to
    // the record above.
    expect(calls).toHaveLength(1);
  });

  test("an actor named in the arguments is ignored, whichever way it is spelled", async () => {
    /*
     * THE HEADLINE PROPERTY OF THIS FILE, AND IT WAS ASSERTED OF HALF THE CALL. The recorder's
     * default `execute` dropped the arguments, so what this test could see was the call record's
     * own `userId` — the half a transport gets right by construction, because it is the field it
     * fills from the connection. What it could not see was the object actually forwarded to the
     * vendor, which is where a model's three spellings of an identity live and where the vendor
     * reads `arguments` from. Both halves go out on one request, so both halves are the claim.
     *
     * ASSERTED AS THE WHOLE CALL rather than field by field, the way the adapter suite's own
     * attribution test is ("a call that runs carries the person, the version and the arguments"):
     * an EXTRA field on this request is as much a finding as a wrong one, and a per-field check is
     * blind to every one of them.
     *
     * THE THREE SPELLINGS TRAVEL ON AS ARGUMENTS, which is the correct outcome and not an
     * oversight. They are the model's own arguments; the vendor is the party that decides what an
     * action's `userId` parameter means, and stripping keys by name would be this module reading
     * `args` for an identity — the very thing that makes the property structural rather than
     * merely checked. What must never happen is one of them reaching the field beside them.
     *
     * THE PERSON IS NAMED AFTER NOTHING ELSE IN THIS FILE, which is what makes the assertion able
     * to tell attribution from coincidence: `user_asker` is the house id every other call here
     * uses, so it is exactly the literal a transport that had stopped reading the connection would
     * most plausibly be hard-coded to.
     */
    const { client, calls } = recording();
    useComposioClient(client);

    const spelled = {
      userId: "user_victim",
      user_id: "user_victim",
      entityId: "user_victim",
    };

    await callTool(
      { url: "composio://gmail", actorId: "user_whose_mailbox_this_is" },
      "GMAIL_FETCH_EMAILS",
      { ...spelled, query: "is:unread", __version: "20260903_00" },
    );

    // The identity is not a field a model fills. This is the defect OpenTag got wrong three times,
    // and the only structural defence is that the argument name is never read.
    expect(calls).toEqual([
      {
        toolkit: "gmail",
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_whose_mailbox_this_is",
        version: "20260903_00",
        args: { ...spelled, query: "is:unread" },
      },
    ]);
  });

  test("a call with nobody attributed refuses and reaches nothing", async () => {
    /*
     * AN ACTOR MADE OF PADDING IS NOBODY, and that is the half of this guard nothing was asking.
     * Only the absent key was tested, so the `.trim()` in front of the check could be deleted with
     * the suite green — and what it keeps out is worse than an absent id, not better: `" "` is a
     * user id Composio will happily look up, find no connected account for, and refuse. The call
     * would then read as somebody's lapsed connection rather than as a run this deployment never
     * attributed to anybody, which sends the person who reads it to the wrong page.
     *
     * The shapes are the ones an identifier arrives as when something upstream had nothing to put
     * in it: a column read back empty, a header that was sent blank, a value assembled by a shell.
     */
    for (const actorId of [undefined, "", "   ", "\n\t "]) {
      const { client, calls } = recording();
      useComposioClient(client);

      const result = await callTool(
        { url: "composio://gmail", actorId },
        "GMAIL_FETCH_EMAILS",
        {
          __version: "20260903_00",
        },
      );

      const named = JSON.stringify(actorId ?? null);
      expect(`${named}: ${result.isError}`).toBe(`${named}: true`);
      expect(result.text).toMatch(/not attributed to anybody/i);
      expect(calls).toEqual([]);
    }
  });

  test("a thrown failure is reported with the vendor's own sentence", async () => {
    useComposioClient(
      recording({
        execute: async () => {
          throw Object.assign(
            new Error("Error executing the tool GMAIL_FETCH_EMAILS"),
            {
              cause: {
                status: 404,
                headers: { "x-request-id": "must-not-appear" },
                error: {
                  error: {
                    message:
                      "No connected account found for user ID u1 for toolkit gmail",
                  },
                },
              },
            },
          );
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No connected account found");
    // The error also carries the whole HTTP response. None of it belongs in a model's context or an
    // audit row.
    expect(result.text).not.toContain("must-not-appear");
    expect(result.text).not.toContain("x-request-id");
  });

  test("a failure with no vendor sentence falls back to the thrown message, whole", async () => {
    /*
     * WHY THIS ONE REFUSAL NAMES NEITHER THE ACTION NOR A REMEDY, which every sibling around it
     * does and which this test used to accept without saying anything about.
     *
     * `toContain` accepted the current answer and would have accepted any of the wrong ones too: a
     * sentence with this deployment's generic advice bolted on, one cut short of the vendor's
     * words, one with the action's name prefixed. So what the fallback actually IS was pinned by
     * nobody, and the difference between the branches is the whole subject of this describe.
     *
     * THE RULE THE MODULE FOLLOWS IS THAT THE WORDS THAT WERE SAID BEAT THE WORDS WE WOULD INVENT,
     * and it is the same rule `listingSentence` follows on the other path. `unexplained` — which
     * names the action and sends the reader to the Plugins page — is what the two sibling tests
     * below assert, and it is reached only where the vendor said NOTHING usable: an empty message,
     * or the placeholder. A transport fault that came with a diagnosis is not that case, and
     * replacing "composio unreachable" with "check that this app is still connected" would be
     * exactly the wrong advice at exactly the wrong moment — the connection is fine and Composio
     * is down. The action's name is in `store.ts`'s audit row beside this sentence either way, and
     * the model reading it has just called the action.
     *
     * So this refusal carrying neither is deliberate, and the test now says so by pinning the
     * answer WHOLE rather than by looking for a fragment inside whatever arrived.
     *
     * THE PADDED ONE IS HERE BECAUSE THE TRIM IS. What comes back is measured by the cap and read
     * by a person, and the module already decided this string was worth passing on — with the
     * padding dropped, the way `vendorSentence` drops it.
     */
    for (const thrown of ["composio unreachable", "  composio unreachable\n"]) {
      useComposioClient(
        recording({
          execute: async () => {
            throw new Error(thrown);
          },
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      expect(result.isError).toBe(true);
      expect(result.text).toBe("composio unreachable");
      expect(result.truncated).toBe(false);
    }
  });

  test("a thrown client error with no wrapper is reported with its sentence", async () => {
    /*
     * The same correction as the listing's, on the path where the string reaches a model rather
     * than an admin page. See {@link unwrapped} for which calls throw this shape; what used to be
     * handed on for them was a status code followed by the whole response body, which is both the
     * request id this file already refuses to pass on and somebody's context window spent on it.
     */
    useComposioClient(
      recording({
        execute: async () => {
          throw unwrapped("Gmail rejected the query: invalid search syntax.");
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Gmail rejected the query: invalid search syntax.",
    );
    expect(result.text).not.toContain("must-not-appear");
    expect(result.text).not.toContain("x-request-id");
  });

  test("a failure whose body says nothing is not answered with the body", async () => {
    // The dump reaching a model, rather than an operator. `unexplained` is the right answer here
    // for the reason it is the right answer to the placeholder: neither says anything the reader
    // can act on, and one of them costs a context window to say it.
    useComposioClient(
      recording({
        execute: async () => {
          throw dumped({
            detail: [{ loc: ["body", "arguments"], msg: "unrecognised" }],
            request_id: "must-not-appear",
          });
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("must-not-appear");
    expect(result.text).not.toContain("unrecognised");
    expect(result.text).not.toContain("{");
    expect(result.text).toMatch(/Plugins page/);
    expect(result.text).toContain("GMAIL_FETCH_EMAILS");
  });

  test("a result the exact size of the cap is not cut, and one character more is", async () => {
    /*
     * THE BOUNDARY, WHICH IS THE ONLY PLACE A CAP CAN BE WRONG. Every other test here measures a
     * string far over the limit or far under it, so `<=` and `<` answered both of them the same
     * way — and the off-by-one is the version that reports `truncated: true` beside text nothing
     * was taken from, which is a lie in the field whose whole job is telling a model that what it
     * is reading stops early.
     */
    for (const [length, cut] of [
      [RESULT_CAP, false],
      [RESULT_CAP + 1, true],
    ] as const) {
      useComposioClient(
        recording({
          execute: async () => {
            throw new Error("x".repeat(length));
          },
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      expect(`${length}: ${result.truncated}`).toBe(`${length}: ${cut}`);
      expect(`${length}: ${result.text.length}`).toBe(
        `${length}: ${cut ? CAPPED_LENGTH : RESULT_CAP}`,
      );
      expect(result.text.endsWith(TRUNCATION_MARKER)).toBe(cut);
    }
  });

  test("a result is capped visibly rather than silently", async () => {
    useComposioClient(
      recording({
        execute: async () => answered({ body: "x".repeat(60_000) }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    // VISIBLY is the marker and RATHER THAN SILENTLY is the flag, and this test asserted only the
    // flag. `truncated: true` beside text that just stops is exactly the silent cut the name
    // promises against: the model reads a JSON document that ends mid-token and completes it from
    // memory, because nothing in what it was handed says the ending is ours.
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text.slice(-TRUNCATION_MARKER.length)).toBe(
      TRUNCATION_MARKER,
    );
    expect(result.text.length).toBe(CAPPED_LENGTH);
  });

  test("an empty answer says so in words rather than being empty", async () => {
    useComposioClient(recording({ execute: async () => answered({}) }).client);

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    // An empty string in front of a model reads as "the action had nothing to say" rather than "there
    // is nothing there", and the model closes the gap from memory. Same reasoning as `resultText`.
    // `data` is a required record, so the empty answer the SDK can actually produce is `{}` — if that
    // did not count, this branch would be unreachable and its promise would be a fiction.
    expect(result.text).toMatch(/returned nothing/i);
    // Nothing to say is not a failure and is not a truncation. Both fields were unasserted, so this
    // branch could have started reporting an error and the test would not have noticed.
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(false);
  });

  test("an answer the vendor marked unsuccessful is a failure, not content", async () => {
    // `ToolExecuteResponseSchema` makes `successful` REQUIRED and resolves `{ data, error,
    // successful }`, so a 200 answer can carry a failure. Reported as a success it is audited as
    // `mcp.call_succeeded` and the failure is handed to the model as though it were content.
    useComposioClient(
      recording({
        execute: async () =>
          answered(
            {},
            {
              successful: false,
              error: "Gmail rejected the query: invalid search syntax.",
            },
          ),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid search syntax");
  });

  test("a successful answer hands the model the action's data and not the envelope", async () => {
    useComposioClient(
      recording({
        execute: async () => ({
          ...answered({ messages: [{ id: "m1" }] }),
          logId: "log_must_not_appear",
        }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(false);
    // `successful`, `error` and `logId` are the envelope this transport reads to decide the
    // outcome. Reporting them as content spends a model's context on our own bookkeeping. Pinned
    // as the whole string rather than as three absences, because a list of things that must not
    // appear is only ever as long as the fields the envelope had on the day it was written — the
    // vendor's `sessionInfo` is already in the type and named in none of them.
    expect(result.text).toBe(
      JSON.stringify({ messages: [{ id: "m1" }] }, null, 2),
    );
  });

  test("an unsuccessful answer with no sentence still says something actionable", async () => {
    useComposioClient(
      recording({
        execute: async () => answered({}, { successful: false, error: null }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("GMAIL_FETCH_EMAILS");
    expect(result.text).toMatch(/Plugins page/);
  });

  test("a failure carrying only the vendor's placeholder says something actionable", async () => {
    // "Error executing the tool X" is the string this module's own comment calls useless. Echoing it
    // tells a person nothing they did not already know: they asked for that tool.
    useComposioClient(
      recording({
        execute: async () => {
          throw new Error("Error executing the tool GMAIL_FETCH_EMAILS");
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    // ASKED OF THE WHOLE STRING, the way the listing-side sibling asks it. A not-equals only
    // refuses the placeholder standing alone, so a refusal that carried it in the middle of a
    // sentence — "GMAIL_FETCH_EMAILS failed: Error executing the tool GMAIL_FETCH_EMAILS" — is the
    // same useless words in a model's context and in the audit row, and passed.
    expect(result.text).not.toMatch(/error executing the tool/i);
    expect(result.text).toMatch(/Plugins page/);
  });

  test("a failure that carries no message at all still says something actionable", async () => {
    /*
     * The empty-message arm of the fallback, which nothing reached. Both ways of arriving at it are
     * real: `@composio/core` rejects with plain objects on some paths, so `error instanceof Error`
     * is false and there is no message to read at all; and a thrown `Error` whose message is blank
     * or whitespace is what a transport-level abort produces.
     *
     * Passed on unchanged, either one lands in a model's context and in `store.ts`'s audit row as an
     * empty refusal — a failure with `isError: true` and nothing said, which reads to a model as
     * permission to invent a reason and retry.
     */
    for (const thrown of [{ status: 502 }, new Error(""), new Error("  \n ")]) {
      useComposioClient(
        recording({
          execute: async () => {
            throw thrown;
          },
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      expect(result.isError).toBe(true);
      expect(result.text.trim()).not.toBe("");
      expect(result.text).toContain("GMAIL_FETCH_EMAILS");
      expect(result.text).toMatch(/Plugins page/);
    }
  });

  test("an enormous vendor sentence is capped in a refusal too, and says so", async () => {
    useComposioClient(
      recording({
        execute: async () =>
          answered({}, { successful: false, error: "x".repeat(60_000) }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    // A refusal goes into a model's context exactly as a result does, so an uncapped vendor sentence
    // is the same unbounded spend the success path already refuses to make.
    expect(result.isError).toBe(true);
    expect(result.truncated).toBe(true);
    // "and says so" is the marker, which nothing here used to check.
    expect(result.text.slice(-TRUNCATION_MARKER.length)).toBe(
      TRUNCATION_MARKER,
    );
    expect(result.text.length).toBe(CAPPED_LENGTH);
  });

  test("an enormous thrown message is capped in a refusal too", async () => {
    useComposioClient(
      recording({
        execute: async () => {
          throw new Error("y".repeat(60_000));
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text.slice(-TRUNCATION_MARKER.length)).toBe(
      TRUNCATION_MARKER,
    );
    expect(result.text.length).toBe(CAPPED_LENGTH);
  });

  test("our own serialization failure is not reported as the action having failed", async () => {
    useComposioClient(
      recording({
        execute: async () => {
          const data: Record<string, unknown> = { subject: "hello" };
          // A circular reference, which `JSON.stringify` refuses. The action already ran and the
          // vendor already answered; what fails is this deployment reading that answer.
          data.itself = data;
          return answered(data);
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    // Two different events, and the audit trail has to be able to tell them apart: the vendor did
    // its part here.
    expect(result.text).toMatch(/could not turn that answer into text/i);
    expect(result.text).toContain("GMAIL_FETCH_EMAILS");
  });

  test("an answer reporting an error while claiming success is a failure", async () => {
    /*
     * `ToolExecuteResponseSchema` spells `error` and `successful` as two independent required
     * fields and correlates them nowhere; `transformToolExecuteResponse` copies both straight off
     * the wire (`@composio/core` 0.18.1, `src/models/Tools.ts:215-222`). So the combination is a
     * shape the vendor's own schema permits, and keying only on `successful === false` dropped the
     * one sentence in it that says anything — audited as `mcp.call_succeeded`, with the failure
     * handed to the model as though it were content.
     *
     * The strict reading is the safe one and it is also the vendor's: where the SDK has to derive
     * the flag itself it writes `successful: !response.error` (`src/models/Tools.ts:1247`), so a
     * present error IS a failure by their own arithmetic. Same rule as `effectOf` uses for
     * contradictory labels — both at once is somebody else's bug, and we take the strict branch.
     */
    useComposioClient(
      recording({
        execute: async () =>
          answered(
            { messages: [{ id: "m1" }] },
            {
              successful: true,
              error: "Gmail rejected the query: invalid search syntax.",
            },
          ),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid search syntax");
    // The data must not be handed over as content beside a reported failure.
    expect(result.text).not.toContain("m1");
  });

  test("an error made of nothing but padding beside a success is still a success", async () => {
    /*
     * The other side of the rule, and the reason it is worded as a SENTENCE rather than as a
     * present field: `successful: !response.error` treats `""` as success, so an empty string is
     * the vendor saying nothing went wrong in the least committal way available to it.
     *
     * THE PADDED ONES ARE THE HALF THAT WAS UNASSERTED. Only `""` was here, so the `.trim()` that
     * decides whether this field says anything could be deleted with the suite green — and what it
     * would cost is the worst outcome on this path: a newline in `error` read as a complaint turns
     * a call that worked into a reported failure, the action's own data is withheld from the model
     * as content, and `store.ts` audits a failure against a call the vendor was perfectly happy
     * with. A blank field is not a sentence here for the same reason it is not one in
     * `vendorSentence`.
     */
    for (const error of ["", "   ", "\n\t", "\r\n "]) {
      useComposioClient(
        recording({
          execute: async () =>
            answered({ messages: [] }, { successful: true, error }),
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      const named = JSON.stringify(error);
      expect(`${named}: ${result.isError}`).toBe(`${named}: false`);
      expect(result.text).toBe(JSON.stringify({ messages: [] }, null, 2));
    }
  });

  test("a list where the envelope should be is refused, not called an empty success", async () => {
    /*
     * `typeof [] === "object"`, so an array cleared a guard written as a bare `typeof` test and was
     * then read as an envelope: `error` and `successful` came off it as undefined, so nothing was
     * reported, and `data` came off it as undefined, so `resultOf` answered "The action returned
     * nothing." An answer this deployment could not read reached the model as a call that worked
     * and found nothing, and `store.ts` wrote `mcp.call_succeeded` beside it — which is the exact
     * outcome the third kind of failure exists to keep off the trail.
     *
     * Not a hypothetical shape: an envelope unwrapped one level too far, or a client that answers
     * the batch form, is a list where this expects a record.
     */
    for (const shape of [[], [{ data: { messages: [] }, successful: true }]]) {
      useComposioClient(
        recording({
          execute: async () => shape as unknown as ComposioResult,
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      expect(result.isError).toBe(true);
      expect(result.text).toContain("GMAIL_FETCH_EMAILS");
      expect(result.text).not.toContain("returned nothing");
    }
  });

  test("an object that is not the envelope is refused, not called an empty success", async () => {
    /*
     * THE HOLE THE ARRAY FIX LEFT, WHICH IS EVERY OTHER OBJECT. The guard above this one asked
     * whether an object had arrived, so it caught `[]` and admitted the whole of the rest of the
     * world — and the two shapes it was written about walked straight through it.
     *
     * An envelope unwrapped ONE level, which is what a client reaching one field too far resolves,
     * is the action's own `data` standing where the envelope belongs: `error` and `successful`
     * come off it as absent, so nothing is reported, and `data` comes off it as absent, so
     * `resultOf` answers "The action returned nothing." A bare `{}` does the same by having
     * nothing on it at all. Both reached the model as a call that worked and found nothing, and
     * `store.ts` wrote `mcp.call_succeeded` beside each — while the refusal that never fired
     * claimed the `{ data, error, successful }` envelope had been checked for.
     *
     * THE PARTIAL ONES ARE HERE FOR THE SAME REASON THE WHOLE ONES ARE. An answer carrying two of
     * the three fields is not an envelope either, and each of them lands on the identical false
     * success: no `data` serializes to nothing, and no `successful` reports nothing.
     */
    const shapes: Record<string, unknown> = {
      "an envelope unwrapped one level": { messages: [{ id: "m1" }] },
      "a bare object": {},
      "an envelope with no data": { error: null, successful: true },
      "an envelope with no successful": {
        data: { messages: [{ id: "m1" }] },
        error: null,
      },
      "an envelope whose successful is present as undefined": {
        data: {},
        error: null,
        successful: undefined,
      },
    };

    for (const [shape, answer] of Object.entries(shapes)) {
      useComposioClient(
        recording({
          execute: async () => answer as ComposioResult,
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      expect(`${shape}: ${result.isError}`).toBe(`${shape}: true`);
      expect(result.text).toContain("GMAIL_FETCH_EMAILS");
      // The two halves of the false success this guard exists to stop: the sentence that reads as
      // a call that worked, and the vendor's data handed over as content beside it.
      expect(result.text).not.toContain("returned nothing");
      expect(result.text).not.toContain("m1");
    }
  });

  test("an error that is not a sentence is not read as silence", async () => {
    /*
     * `ToolExecuteResponseSchema` spells `error` a nullable string, so an object — or the issue
     * list a gateway leaves there — is a field this deployment cannot read. Collapsed to `""` by a
     * `typeof` test, it was indistinguishable from the vendor saying nothing went wrong: the data
     * was handed to the model as content and the call was audited as a success, with the one field
     * carrying the complaint shown to nobody.
     *
     * THE FLAG DECIDES WHICH SENTENCE, because the two states differ. Beside `successful: false`
     * the vendor has already reported the failure and only its reason is unreadable, which is the
     * actionable connection sentence. Beside a claimed success nothing here knows whether the
     * action ran, and that failure is ours rather than the vendor's, so it says so in our words.
     */
    const unreadable = { message: "Quota exceeded.", code: 429 };

    useComposioClient(
      recording({
        execute: async () =>
          ({
            data: { messages: [{ id: "m1" }] },
            error: unreadable,
            successful: true,
          }) as unknown as ComposioResult,
      }).client,
    );

    const claimed = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(claimed.isError).toBe(true);
    expect(claimed.text).toContain("could not read");
    // The data must not be handed over as content beside a complaint nobody could read.
    expect(claimed.text).not.toContain("m1");

    useComposioClient(
      recording({
        execute: async () =>
          ({
            data: {},
            error: unreadable,
            successful: false,
          }) as unknown as ComposioResult,
      }).client,
    );

    const reported = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(reported.isError).toBe(true);
    expect(reported.text).toContain("Plugins page");
  });

  test("a successful flag that is not a boolean is not read as a success", async () => {
    /*
     * `successful !== false` ASKED ONE QUESTION OF A FIELD WITH THREE ANSWERS. The schema spells
     * it a required boolean, but the value is the vendor's and the type is this module's
     * projection — and every shape below is none of them literally `false`, so each one passed as
     * a success: the reported failure was handed to the model as content and `store.ts` audited
     * `mcp.call_succeeded` beside it. This is the same defect the `error` field beside it was
     * fixed for, on the field that decides the outcome outright.
     *
     * `"false"` IS THE ONE THAT PROVES FALSINESS IS NOT THE REPAIR. A non-empty string is truthy,
     * so a plain `!answer.successful` reads the vendor's literal word "false" as a success just as
     * the old check did, and `0` — which no schema permits and no reader can interpret — it would
     * read as a considered no. What is wanted is neither: a field this deployment cannot read is
     * the third kind of failure, and it says so in this file's own words rather than guessing a
     * value for it.
     */
    for (const successful of ["false", 0, null, "true", {}]) {
      useComposioClient(
        recording({
          execute: async () =>
            ({
              data: { messages: [{ id: "m1" }] },
              error: null,
              successful,
            }) as unknown as ComposioResult,
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      const named = JSON.stringify(successful);
      expect(`${named}: ${result.isError}`).toBe(`${named}: true`);
      expect(result.text).toContain("GMAIL_FETCH_EMAILS");
      // Not the vendor's words: nobody reported this failure, so the sentence must not read as
      // though Composio had. And the data must not travel beside it as content.
      expect(result.text).toMatch(/could not read/i);
      expect(result.text).not.toContain("m1");
    }
  });

  test("an unreadable flag loses to the sentence Composio did send", async () => {
    /*
     * THE SHAPE CHECK ABOVE MUST NOT COST A READER THE ONE USEFUL SENTENCE. A malformed flag
     * beside a real complaint is a failure either way, and "this deployment could not read the
     * flag" is the less actionable of the two things that could be said about it. So the vendor's
     * own words still win, and the check is reached only where the alternative would be calling
     * the answer a success.
     */
    useComposioClient(
      recording({
        execute: async () =>
          ({
            data: {},
            error: "Gmail rejected the query: invalid search syntax.",
            successful: "false",
          }) as unknown as ComposioResult,
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid search syntax");
    expect(result.text).not.toMatch(/could not read/i);
  });

  test("an answer that is not an envelope refuses rather than throwing", async () => {
    /*
     * THE NEVER-THROW CONTRACT, asserted against the shape that broke it. This module documents a
     * failure as a RESULT and `store.ts` relies on it: a model is mid-run with a person waiting,
     * and an exception ends the turn with nothing said and nothing audited.
     *
     * `reportedFailure(answer, …)` read `answer.successful` outside every try, so a client
     * resolving `null` threw a `TypeError` straight out of `callTool`. Like the listing case, this
     * is a shape `ToolExecuteResponseSchema` forbids and `ComposioActions` cannot police — the
     * projection is ours, the adapter is unwritten, and a runtime resolution is not a type.
     */
    for (const shape of [null, undefined, "ok", 7]) {
      useComposioClient(
        recording({
          execute: async () => shape as unknown as ComposioResult,
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      expect(result.isError).toBe(true);
      expect(result.text).toContain("GMAIL_FETCH_EMAILS");
      expect(result.text).not.toMatch(/is not an object|undefined is not/i);
    }
  });

  test("a schema mismatch on the way to the call is not handed on as a Zod dump", async () => {
    /*
     * THE SDK'S PARSE RUNS BEFORE THE SDK'S OWN TRY DOES. `./composio-adapter` resolves the tool
     * first — `getRawComposioToolBySlug`, which runs `ToolSchema.parse` — so a vendor answer their
     * schema rejects arrives here as a raw `ZodError`, whose `message` is the issue array as JSON.
     * The listing path has refused that string since the day it was written; this path passed the
     * whole dump to the model and into `store.ts`'s audit row, wearing the vendor's words for a
     * failure that is a version skew between this deployment and their package.
     */
    const issues = [
      {
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        path: ["toolkit", "slug"],
        message: "Required",
      },
    ];
    useComposioClient(
      recording({
        execute: async () => {
          throw Object.assign(new Error(JSON.stringify(issues, null, 2)), {
            name: "ZodError",
            issues,
          });
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("invalid_type");
    expect(result.text).not.toContain("received");
    expect(result.text).toContain("GMAIL_FETCH_EMAILS");
    // A vendor change rather than anything an administrator can do to this connection, so the
    // sentence has to name the one step that helps.
    expect(result.text).toMatch(/upgrad/i);
  });

  test("a placeholder nested in the cause is refused like the thrown one", async () => {
    /*
     * The same string, reached by the route the guard did not cover. `vendorSentence` is preferred
     * over the thrown message, so a placeholder sitting where the useful sentence usually sits was
     * handed to the model past a check written to stop it.
     */
    useComposioClient(
      recording({
        execute: async () => {
          throw Object.assign(
            new Error("Error executing the tool GMAIL_FETCH_EMAILS"),
            {
              cause: {
                error: {
                  error: {
                    message: "Error executing the tool GMAIL_FETCH_EMAILS",
                  },
                },
              },
            },
          );
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    // ANCHORED TO NOTHING, for the reason above: the module's own `VENDOR_PLACEHOLDER` is anchored
    // because it is deciding whether a string IS the placeholder, and this is asking whether a
    // refusal CARRIES it. A start-anchored question of the answer lets it through anywhere but the
    // first character.
    expect(result.text).not.toMatch(/error executing the tool/i);
    expect(result.text).toMatch(/Plugins page/);
  });

  test("a refusal this deployment authored beats whatever the vendor said", async () => {
    /*
     * THE ORDER `routes.ts` USES, WHICH THIS PATH HAD BACKWARDS. `brokerRefusal` there reads
     * `brokerSentence` first and falls back to `vendorSentence`; this catch read `vendorSentence`
     * first. Both meet the same throws — `./composio-adapter`'s `askVendor` raises a
     * `BrokerRefusalError` out of the execute path as readily as out of a listing — so one vendor
     * condition was answered with two different sentences depending on which door the reader came
     * through, and on this one the authored remedy lost.
     *
     * AND IT LOST TO A READ ONE LEVEL SHALLOW. `vendorRefusal` authors a refusal only where
     * `vendorSentence` of the ORIGINAL error was null, so the vendor keeps the last word wherever
     * it had one. Asking the same question of the WRAPPER is a different question: its `cause` is
     * the original, so the reach for `cause.error.error.message` lands one level in from where it
     * landed before and finds whatever sits there — below, a bare "Invalid request" that the
     * adapter had already judged not to be an explanation.
     *
     * What that costs is the whole point of translating the condition: a sentence naming the step
     * that clears it, replaced by three words naming nothing.
     */
    const authored =
      'Composio refuses a call whose toolkit version is "latest", and that is the version travelling with this one, so GMAIL_FETCH_EMAILS was not run. A dated version is recorded when an app\'s actions are listed, so refreshing gmail\'s tools on its Plugins page replaces "latest" with a version Composio will accept.';

    useComposioClient(
      recording({
        execute: async () => {
          throw new BrokerRefusalError(authored, {
            cause: { error: { error: { message: "Invalid request" } } },
          });
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    // Pinned whole rather than by a fragment: what this asserts is that the authored sentence
    // arrives as its author wrote it, and a substring check would pass on a sentence that had
    // been joined to the vendor's or cut short of the remedy.
    expect(result.text).toBe(authored);
    expect(result.text).not.toContain("Invalid request");
  });

  test("a failure this deployment cannot explain still reaches for the vendor's words", async () => {
    // The other half of the precedence, and the reason it is `brokerSentence` rather than
    // `error.message`. `./broker` raises its class only where the sentence names the step that
    // fixes it; a failure it knows nothing about stays a plain `Error`, and for those the vendor's
    // own nested sentence is still worth far more than a generic top-level message.
    useComposioClient(
      recording({
        execute: async () => {
          throw Object.assign(
            new Error("Error executing the tool GMAIL_FETCH_EMAILS"),
            nested(
              "No connected account found for user ID u1 for toolkit gmail",
            ),
          );
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No connected account found");
  });

  test("an answer that serializes to nothing at all is refused in this file's own words", async () => {
    /*
     * `JSON.stringify` ANSWERS `undefined` RATHER THAN THROWING for a function, a symbol, or
     * anything else with no JSON form — `ComposioResult` is this module's projection and the value
     * is the vendor's, so that is a shape this path meets rather than one it forbids. The
     * `undefined` then reached the cap, which measures `.length`, and the engine's own
     * `undefined is not an object` became the second half of a sentence this file wrote.
     */
    useComposioClient(
      recording({
        execute: async () => ({
          data: (() => "x") as unknown as Record<string, unknown>,
          error: null,
          successful: true,
        }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/could not turn that answer into text/i);
    expect(result.text).toContain("GMAIL_FETCH_EMAILS");
    expect(result.text).not.toMatch(
      /is not an object|undefined is not|TypeError/i,
    );
  });
});
