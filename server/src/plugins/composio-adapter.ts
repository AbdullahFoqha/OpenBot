import { Composio } from "@composio/core";
import {
  type BrokerApp,
  type ComposioBroker,
  BrokerRefusalError,
} from "./broker";
import {
  type ComposioAction,
  type ComposioActions,
  type ComposioResult,
  LISTING_LIMIT,
  vendorSentence,
} from "./composio";

/**
 * The one file in `server/src` that imports `@composio/core`, and what it owes the rest of them.
 *
 * `./composio` describes calling an action and `./broker` describes everything that has to be true
 * before one can be called; both are written as narrow projections that name no vendor type, so
 * that the SDK's shape — its constructor, its retries, its zod schemas and whatever the next
 * version renames — is confined here. This module is the adapter that satisfies both from one
 * client. A second importer of `@composio/core` under `server/src` would undo that, because the
 * point of a single import site is that a version bump has exactly one file to be read against.
 *
 * NO SESSION IS EVER CREATED, AND THAT IS A SECURITY BOUNDARY RATHER THAN A PREFERENCE. The SDK's
 * `composio.create(...)` and `sessions.create(...)` open a Composio tool-router session, and a
 * session brings Composio's own hosted surface with it — a remote shell and a Python sandbox that
 * this deployment neither asked for, cannot see into, and could not audit if a model reached them.
 * Everything below is a plain per-call request carrying a user id. A `create` of a session
 * anywhere in this file is a defect, not an optimisation, and it will not look like one: the
 * session API is the shortest path to most of what this file does the long way.
 *
 * EVERY LISTING PASSES AN EXPLICIT LIMIT. Composio's default page is 20, which is smaller than the
 * number of actions Gmail alone publishes, and for a tool listing the default does a second thing
 * as well: `getRawComposioTools` sets `important=true` whenever a toolkit query arrived with no
 * limit, no tags and no search (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so an
 * omitted limit silently narrows the answer to the vendor's own "important" subset and nothing in
 * the result says a filter was applied. A limit is therefore not tuning; it is the difference
 * between the list and a fragment of it that reads exactly like the list. {@link LISTING_LIMIT} is
 * the documented ceiling, and `./composio` explains why one page at the ceiling is the largest
 * listing this SDK can express at all.
 *
 * THE API KEY NEVER LEAVES THIS FILE. It arrives as {@link createComposioClient}'s only argument,
 * goes straight into the vendor's constructor, and is held from there on by the vendor's client
 * inside a closure. Nothing below logs it, no thrown message quotes it, and neither of the two
 * returned objects carries a field that could be read back to it — they expose eight methods and
 * no state. A key in a log line is a key in a log aggregator, and a key in an error message is a
 * key in an audit row and in a model's context.
 */

/**
 * One tool as the vendor hands it over, in as much detail as anything here reads.
 *
 * Declared structurally rather than imported as `Tool`, for the same reason the seams it feeds are
 * structural: a field this file does not read is a field a vendor rename cannot break. `toolkit`
 * is optional because the SDK spells it optional — see {@link ComposioActions.execute} below for
 * what is done when it is in fact missing.
 *
 * THIS IS THE ONE ROW BELOW WHOSE FIELDS ARE AS NARROW AS THE SDK'S SCHEMA, AND THE REASON IS THAT
 * THIS IS THE ONE ROW THE SDK ACTUALLY VALIDATES. `Tools.transformToolCases` ends in
 * `ToolSchema.parse(...)` (`@composio/core` 0.18.1, `src/models/Tools.ts:193`), a throwing parse
 * rather than the warn-only `transform()` every other listing here goes through — and both calls
 * this file makes run through it (`:561` for the listing, `:719` for the single tool). So a tool
 * whose `slug` is missing, or whose `toolkit` is present without a `slug`, does not arrive as a
 * malformed row: it arrives as a `ZodError`. `ToolkitSchema` spells that inner `slug` required
 * (`src/types/tool.types.ts:12-16`), so `toolkit?: { slug: string }` is a guarantee this file may
 * rest on, unlike every declaration under it.
 */
type VendorTool = {
  slug: string;
  description?: string;
  inputParameters?: Record<string, unknown>;
  tags?: string[];
  version?: string;
  toolkit?: { slug: string };
};

/**
 * One catalogue row as the vendor hands it over.
 *
 * `meta` is where all of it lives and every field of it is optional, which is not the SDK being
 * cautious: Composio genuinely publishes toolkits with no logo, no description and no category.
 * See {@link ComposioBroker.listApps} below for what each absence becomes.
 *
 * WIDER THAN THE SDK'S OWN SCHEMA, BECAUSE THE SCHEMA IS NOT ENFORCED ON THIS PATH. `transform()`
 * validates with `safeParse` and, where that fails, logs a warning and `return transformed` — the
 * unvalidated object — anyway (`@composio/core` 0.18.1, `src/utils/transform.ts:26-36`). So
 * `ToolKitItemSchema` spelling `name` required and `toolsCount` a number describes the answer
 * Composio means to send rather than the one this file has to be able to read: a row whose `name`
 * is null, or whose count arrives as a string, reaches the map below exactly as it came off the
 * wire and the only thing that noticed was a log line. A TypeScript interface over a wire value is
 * an assertion and not a check, so the least this one can do is assert something true.
 *
 * `meta` ITSELF IS NOT WIDENED, AND THAT IS A FINDING RATHER THAN AN OVERSIGHT.
 * `transformToolkitListResponse` builds each row's meta itself and reads `item.meta.categories`
 * while doing so (`src/utils/transformers/toolkits.ts:21-34`), so a row that carries no meta never
 * arrives here at all — the read throws and `Toolkits.getToolkits` rethrows it as
 * `ComposioToolkitFetchError` (`src/models/Toolkits.ts:76-82`). Every row that does arrive carries
 * a meta object. Its `categories` are objects for the same reason, the transformer constructing
 * each one; the values inside them are copied across verbatim and are therefore worth exactly what
 * the wire is worth.
 *
 * `description` AND `toolsCount` ARE `unknown` RATHER THAN A WIDER UNION, because the wire can put
 * anything in them and a union would be another guess. `unknown` is the type that forces the
 * reader to say what it does with a value it has not checked, which is the whole point.
 *
 * `slug` IS AS WIDE AS `name` NOW, AND FOR THE SAME REASON. It was left narrow while the other
 * fields were widened, on no argument that distinguishes it: `ToolKitItemSchema` spells it required
 * and the warn-only `transform()` above copies it across whatever it turns out to be, exactly as it
 * does the name. A slug is the only name this deployment has for an app — it is what enabling one
 * records and what every later call names — so the one it must not quietly become is `undefined`
 * read as a string. {@link appOf} has refused that since the sweep; the declaration says so now.
 */
type VendorToolkit = {
  slug?: string | null;
  name?: string | null;
  meta: {
    description?: unknown;
    logo?: string | null;
    categories?: { name?: string | null }[];
    toolsCount?: unknown;
  };
};

/**
 * One auth config as the vendor hands it over, which is three fields because all three decide.
 *
 * `name` IS THE ONLY PROVENANCE THERE IS. Composio publishes no field saying which client created a
 * config, and the listing is scoped to the project rather than to this deployment, so a config an
 * operator made by hand in the dashboard comes back beside the ones made here and is otherwise
 * identical. The name is the one field this deployment chooses, which is why {@link CONFIG_SUFFIX}
 * is written into it and why every decision below reads it.
 *
 * `status` because a DISABLED config is still a config: it answers the listing, it satisfies the
 * "does one exist" question, and a connect link minted against it does not work. The two facts have
 * to be separable or an app with a disabled config reads as an app that is ready.
 *
 * BOTH OF THOSE ARE DECLARED AS THE WIRE CAN SEND THEM RATHER THAN AS THE SDK SPELLS THEM, for the
 * reason the toolkit row above gives at length: `transformAuthConfigRetrieveResponse` copies
 * `name` and `status` across verbatim inside a warn-only `transform()`
 * (`@composio/core` 0.18.1, `src/utils/transformers/authConfigs.ts:29-58`), so
 * `AuthConfigRetrieveResponseSchema` requiring a string name and an `ENABLED`/`DISABLED` enum is
 * not something this file can rest on. A null name reaches {@link madeHere}, and a status the
 * enum does not contain reaches the choice of config to connect against — where "not ENABLED" and
 * "disabled" are different facts and only one of them is worth telling an operator.
 *
 * `id` IS NOW DECLARED THE SAME WAY, AND THE GUARD IT WAS WAITING FOR IS WRITTEN. It was left narrow
 * on the argument that widening belongs beside the check rather than ahead of one; {@link configOf}
 * makes that check, so the declaration no longer claims more than the wire promises. It is the one
 * of the three whose absence sends a request: a delete named with `undefined` asks Composio to
 * remove whatever it cares to, and this deployment then records that the app was withdrawn.
 */
type VendorAuthConfig = {
  id?: string | null;
  name?: string | null;
  status?: string;
};

/**
 * The connected-account statuses this file knows how to ask for, as the literals the SDK admits.
 *
 * The whole enum is named rather than the two or three in use, because the point of the two lists
 * below is that they are CHOICES: a reader comparing them can see which statuses each question
 * leaves out, and a status added by a vendor version shows up here as a name nothing mentions
 * rather than as an answer that quietly got narrower. Written as literals for the reason the
 * previous `"ACTIVE"[]` was: the vendor's parameter is an enum and a widened `string[]` does not
 * satisfy it.
 */
type VendorAccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

/*
 * WHY EVERY LISTING BELOW IS READ OUT OF `unknown` AND NOT OUT OF THE TYPES ABOVE.
 *
 * The declarations on {@link ComposioVendor} say what the SDK MEANS to send, and each row type says
 * at length why that is not the same as what arrives: `transform()` validates with `safeParse`,
 * logs a warning where it fails, and returns the unvalidated object anyway (`@composio/core`
 * 0.18.1, `src/utils/transform.ts:26-36`). So the declarations are kept — they are the contract a
 * version bump is read against, and they are what makes an unchecked read fail to compile — and the
 * value itself is checked here before any field is taken off it.
 *
 * REFUSING RATHER THAN FILLING IN, WHICH IS THE WHOLE OF THE ARGUMENT. A `?? ""`, a `String(x)` or
 * a cast does not make a malformed answer safe; it converts a fault this deployment could have
 * reported into an answer it gives wrongly, and the wrong answers are not small ones — an app with
 * no name in an administrator's picker, an action with no slug put in front of a model, and the one
 * that was actually happening: a delete sent with `undefined` where an account id belongs,
 * answered by Composio however it likes, after which the audit trail records that a person's access
 * was withdrawn and nothing had been. Every reader below therefore answers null on anything it
 * cannot read, and every caller turns that null into a sentence naming what Composio sent.
 */

/**
 * The remedy every shape refusal here ends with, because it is the same act in every one of them.
 *
 * None of these is a misconfiguration. The key is right, the request is right and the answer
 * arrived; what changed is the shape of it, which is a thing nobody operating this deployment can
 * correct from any page it has. Saying so is the difference between an operator reading their own
 * settings for an hour and an operator upgrading a package.
 */
const VENDOR_SHAPE_REMEDY =
  "That is a change in what Composio answers rather than a setting an operator can correct, so upgrading this deployment's @composio/core is what fixes it.";

/**
 * WHAT COMPOSIO PUT SOMEWHERE, NAMED IN A SENTENCE A READER CAN ACT ON.
 *
 * Every refusal below says what arrived where something else belonged, because "Composio's answer
 * was not a shape this deployment reads" sends whoever is holding the page looking through a vendor
 * dashboard with nothing to look for.
 *
 * THE VALUE IS NEVER QUOTED, AND THAT IS THE POINT OF THE FUNCTION RATHER THAN AN INTERPOLATION. A
 * listing row carries a person's mailbox address, an account handle and whatever else the vendor
 * chose to put on it, and a refusal from here is read off an admin page, written into an app's
 * `lastError` and put in front of a model. The shape is the part that is safe to say and is also
 * the only part that helps: a reader who knows a list arrived where an object belongs knows which
 * vendor change they are looking at.
 */
function sent(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (value === "") return "an empty string";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * A vendor status named as itself, because an enum value is the one wire value worth quoting.
 *
 * {@link sent} withholds what it is given for a reason that does not reach here: an auth config's
 * status is one of a closed set of vendor enum names, carries nobody's data, and IS the finding —
 * "Composio called it PENDING" is something an operator can search their dashboard and the vendor's
 * changelog for, where "Composio sent a string" is something they can only shrug at.
 */
function named(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? sent(value) : `"${text}"`;
}

/**
 * One listing row as its fields, and a type predicate so that nothing below needs a cast.
 *
 * Arrays are excluded deliberately. `typeof [] === "object"` and every field read off one answers
 * `undefined`, so a listing of lists would otherwise arrive here as a listing of rows that are
 * missing every field — which is a worse sentence for the same fault.
 */
function hasFields(row: unknown): row is Record<string, unknown> {
  return typeof row === "object" && row !== null && !Array.isArray(row);
}

/**
 * The rows inside an envelope the vendor answers with, or null where it answered something else.
 *
 * THE TWO CONTAINER SHAPES ARE NOT INTERCHANGEABLE AND COMPOSIO USES BOTH. Toolkits and tools come
 * back as bare arrays; auth configs and connected accounts come back as `{ items, nextCursor }`. So
 * one where the other belongs is a vendor change rather than a quirk to absorb — and it is the
 * change that hides best, because `[].items` is `undefined` rather than an error and a bare list
 * where an envelope belongs therefore used to read as an envelope with nothing in it: no configs to
 * connect against, no accounts to withdraw, and a confident answer either way.
 */
function itemsOf(answer: unknown): unknown[] | null {
  if (!hasFields(answer)) return null;
  const items = answer.items;
  return Array.isArray(items) ? items : null;
}

/**
 * One field as the non-empty string it has to be, or null where the vendor sent anything else.
 *
 * EMPTY COUNTS AS ABSENT because every caller of this reads an identifier — a slug, an id, a name
 * this file matches a suffix against — and an empty identifier is unusable in exactly the way a
 * missing one is, while being the one that reads as present at every glance.
 */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Whether a field is the list of strings it is declared to be, all the way through. */
function isTextList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/**
 * How many pages of one listing this deployment will read before it stops and says so.
 *
 * THE BOUND IS AGAINST A VENDOR THAT NEVER STOPS, not against a large answer. Both listings paged
 * below are narrow — one app's authorization configs, or one person's accounts for one app — at
 * {@link LISTING_LIMIT} rows a page, so a second page is already extraordinary and a fiftieth is
 * not a data set. What it is is a cursor that keeps being handed back, which without a ceiling is
 * a request that never returns: a person waiting on a page they pressed disconnect from, and a
 * process holding every row it has read so far.
 *
 * REACHING IT IS A REFUSAL AND NEVER A TRUNCATION, which is the property the whole guard exists for
 * — see {@link everyRowOf}. A ceiling that answered with what it had would be the page ceiling
 * again, one order of magnitude further out and harder to notice.
 */
const PAGE_CEILING = 50;

/**
 * The listing a refusal is about, as the two clauses every sentence below is built from.
 *
 * WRITTEN AT THE CALL SITE for the same reason {@link VendorCall}'s outcome is: what could not be
 * told is a fact about the question being asked — "whether this person is connected" is not
 * something {@link everyRowOf} can know — and composing it beside the call keeps it true.
 */
type Listing = {
  /** The listing as a noun phrase: "this person's gmail accounts". */
  noun: string;
  /** What could not be told, as a clause following "so": "whether one exists could not be read". */
  consequence: string;
};

/**
 * EVERY ROW OF A LISTING THE VENDOR PAGES, or a refusal rather than a fragment read as the whole.
 *
 * WHY THIS PAGES WHERE THE CATALOGUE REFUSES, which is the one decision worth writing down here.
 * `fetchDirectory` below meets a full page and refuses, and `./composio` does the same with a full
 * action listing, and both say why in the same words: the SDK offers no cursor to ask for a second
 * page with, so an answer at the ceiling and an answer past it are indistinguishable and no second
 * request could tell them apart. That is a refusal born of an inexpressible request rather than a
 * house style. Here the request IS expressible: `AuthConfigListParamsSchema` and
 * `ConnectedAccountListParamsSchema` both name a `cursor` (`@composio/core` 0.18.1,
 * `src/types/authConfigs.types.ts:124-131`, `src/types/connectedAccounts.types.ts:259-266`), both
 * models forward it (`src/models/AuthConfigs.ts:95`, `src/models/ConnectedAccounts.ts:118`) and
 * both transformers fill `nextCursor` in from the response's `next_cursor`
 * (`src/utils/transformers/authConfigs.ts:80`, `connectedAccounts.ts:116`).
 *
 * AND THE CALLER THAT DECIDES IT IS `revoke`. Refusing a truncated listing would be honest and
 * would also mean that the person it happened to could never disconnect: every attempt would meet
 * the same page and the same refusal, with their grants standing the whole time. The removal of an
 * app is the same shape one level up. Reading the rest is the answer that finishes the job, and
 * refusing is what is left for the cases where reading the rest is not possible — which is what the
 * three refusals below are, and why none of them can be reached by a caller carrying a partial
 * answer that reports itself complete.
 *
 * THE FIRST REQUEST CARRIES NO CURSOR FIELD AT ALL rather than an undefined one, which is what
 * {@link everyRowOf}'s callers spread for: a `cursor: undefined` would reach the vendor's `parse`
 * as a key, and an explicit undefined is not something this file needs to make the SDK have an
 * opinion about.
 */
async function everyRowOf(
  listing: Listing,
  page: (cursor: string | undefined) => Promise<unknown>,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const followed = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const answered: unknown = await page(cursor);
    const items = itemsOf(answered);
    if (items === null) {
      throw new BrokerRefusalError(
        `Composio answered ${listing.noun} with ${sent(answered)} where a list of them belongs, so ${listing.consequence}. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    rows.push(...items);

    /*
     * ABSENT AND NULL BOTH MEAN THE END, and they are the two the vendor actually sends: the
     * auth-config schema spells the field nullable and the connected-account one spells it nullish,
     * and a transformer that met no `next_cursor` writes null. Anything else is a field this
     * deployment cannot follow, and reading it as the end would be the exact mistake this function
     * exists to prevent — one page treated as the whole answer, by a reader that had been told
     * otherwise in a way it did not understand.
     */
    const next = hasFields(answered) ? answered.nextCursor : undefined;
    if (next === undefined || next === null) return rows;

    const follow = textOf(next);
    if (follow === null) {
      throw new BrokerRefusalError(
        `Composio sent ${sent(next)} where the cursor to the next page of ${listing.noun} belongs, so ${listing.consequence}: there are more of them than arrived and no cursor this deployment can ask for the rest with. ${VENDOR_SHAPE_REMEDY}`,
      );
    }

    /*
     * A CURSOR ALREADY FOLLOWED IS A LOOP AND NOT A PAGE. Nothing here can tell a vendor bug from a
     * proxy answering from a cache, and both end the same way: the same rows for ever. Refusing on
     * the second sight of one is what keeps a person's disconnect a request that returns.
     */
    if (followed.has(follow)) {
      throw new BrokerRefusalError(
        `Composio answered the same page of ${listing.noun} twice, so ${listing.consequence}: following its cursor did not advance, so the rest of them cannot be reached. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    if (followed.size >= PAGE_CEILING) {
      throw new BrokerRefusalError(
        `Composio has answered ${PAGE_CEILING} pages of ${listing.noun} at ${LISTING_LIMIT} rows each and is still offering another, so ${listing.consequence}: this deployment stops there rather than read on, because what is left cannot be told from a listing that never ends. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    followed.add(follow);
    cursor = follow;
  }
}

/**
 * One catalogue row checked into the app an administrator picks from, or a refusal saying why not.
 *
 * A ROW THIS FILE CANNOT READ STOPS THE WHOLE CATALOGUE, for the reason the full-page guard in
 * {@link buildComposioClient} gives at length: the directory is held for ten minutes and both the
 * picker and the enable route read the held copy, so a row quietly dropped is an app missing from a
 * search and an app whose Add button reports that Composio does not publish it. One refusal an
 * operator can act on is worth more than several hundred rows, one of which is a guess.
 *
 * THE ABSENCES THAT ARE REAL ANSWERS ARE STILL ANSWERS. Composio genuinely publishes toolkits with
 * no description, no logo, no category and no count, and each of those is a fact about the app
 * rather than a fault in the answer — so an absent one becomes the value that reads honestly on a
 * screen, exactly as it did before. What is refused is the other thing: a field that is PRESENT and
 * is not what it is declared to be. A count that arrived as the string "63" is not a count, and
 * `Number(x)` over it would turn a vendor change into a plausible figure nobody would question.
 */
function appOf(row: unknown, position: number): BrokerApp {
  const at = `row ${position + 1} of Composio's app catalogue`;
  if (!hasFields(row)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row)} as ${at}, where an app belongs, so the directory was not shown. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const slug = textOf(row.slug);
  if (slug === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.slug)} where the slug of ${at} belongs. The slug is the only name this deployment has for an app — it is what enabling one records and what every later call names — so the directory was not shown, rather than shown with an app nothing could be done with. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const name = textOf(row.name);
  if (name === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.name)} where the name of ${at} belongs, and ${slug} is a slug rather than a title, so there is nothing to show an administrator choosing between apps. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const meta = row.meta;
  if (!hasFields(meta)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta)} where ${slug}'s meta belongs, which is where its description, logo, categories and action count all live. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const description = meta.description ?? "";
  if (typeof description !== "string") {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta.description)} where ${slug}'s description belongs. An app that publishes none is ordinary and reads as a gap on the page; an app whose description is not text is an answer this deployment cannot show. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const logo = meta.logo ?? null;
  if (typeof logo !== "string" && logo !== null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta.logo)} where ${slug}'s logo belongs, and this deployment puts that value in an image address. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const published = meta.categories ?? [];
  if (!Array.isArray(published)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta.categories)} where ${slug}'s categories belong. ${VENDOR_SHAPE_REMEDY}`,
    );
  }
  const categories = published.map((entry: unknown, index: number) => {
    const label = hasFields(entry) ? textOf(entry.name) : null;
    if (label === null) {
      throw new BrokerRefusalError(
        `Composio sent ${sent(hasFields(entry) ? entry.name : entry)} where the name of ${slug}'s category ${index + 1} belongs. The catalogue shows an app's categories as the words a person chooses by, so a category with no name is a blank one of those. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    return label;
  });

  const actionCount = meta.toolsCount ?? 0;
  if (typeof actionCount !== "number" || !Number.isFinite(actionCount)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta.toolsCount)} where ${slug}'s action count belongs. The count is shown BEFORE anybody enables an app, because it is the difference between a small addition and a rewrite of what a model sees, so a figure derived from a value that is not a number is the one number here nobody would think to question. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  return { slug, name, description, logo, categories, actionCount };
}

/**
 * One auth config with the two fields every decision here turns on, checked.
 *
 * `status` IS CARRIED ACROSS UNCHECKED ON PURPOSE, which is the one field of the three this reader
 * does not settle. {@link ComposioBroker.authorize} is its only reader and it has three answers to
 * give rather than two — enabled, disabled, and a word the vendor has invented since — so a check
 * here could only collapse the third into one of the first two, which is the exact defect being
 * closed. It is left as `unknown` so the reader has to say what it does with it.
 */
type CheckedAuthConfig = {
  id: string;
  name: string;
  status: unknown;
};

/**
 * One auth-config row checked into something worth deciding on, or a refusal saying why not.
 *
 * EVERY ROW IS CHECKED AND NOT ONLY THE ONES THAT TURN OUT TO BE OURS, because which ones are ours
 * is precisely what the name decides. A row whose name cannot be read cannot be sorted into "made
 * here" or "somebody's dashboard work", and both of the guesses are damaging in opposite
 * directions: read as somebody else's, {@link ComposioBroker.ensureAuthConfig} creates a second
 * config beside it and splits one app's connections in two; read as ours,
 * {@link ComposioBroker.deleteAuthConfig} deletes an object nobody here chose and every account
 * anybody had connected against it.
 */
function configOf(
  row: unknown,
  position: number,
  toolkit: string,
): CheckedAuthConfig {
  const at = `row ${position + 1} of Composio's authorization configs for ${toolkit}`;
  if (!hasFields(row)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row)} as ${at}, where a config belongs. This listing is what decides whether a config is created, connected against or deleted, so a row it cannot read is not a row it may pass over. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const id = textOf(row.id);
  if (id === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.id)} where the id of ${at} belongs, and the id is the whole of what a deletion names. Nothing was sent, because a delete without one asks Composio to remove whatever it cares to while this deployment records that the app was withdrawn. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const name = textOf(row.name);
  if (name === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.name)} where the name of ${at} belongs, and the name is the only thing that says whether this deployment made a config or an operator built it by hand in Composio's dashboard. Neither guess is safe: one splits this app's connections across two configs, and the other deletes a config nobody here chose along with every account connected against it. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  return { id, name, status: row.status };
}

/**
 * One connected-account row checked down to the only field anything here reads.
 *
 * THIS IS THE MOST LOAD-BEARING OF THESE READERS AND THE ONE WHOSE ABSENCE WAS DOING REAL DAMAGE.
 * {@link ComposioBroker.revoke} deletes by id and then answers `true`, and `store.ts` writes that
 * answer into the audit trail as this person's access having been withdrawn before deleting the one
 * row in this deployment that names which app they had connected. An id-less account reaching the
 * delete is a request to withdraw `undefined` — which the vendor is free to read as anything at all
 * — followed by a `true`, a trail entry, and a live grant with nothing left pointing at it.
 */
function accountIdOf(row: unknown, position: number, toolkit: string): string {
  const at = `row ${position + 1} of Composio's ${toolkit} accounts for this person`;
  if (!hasFields(row)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row)} as ${at}, where an account belongs. Whether this person is connected and what there is to withdraw are both read off this listing, so a row it cannot read is answered with neither. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const id = textOf(row.id);
  if (id === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.id)} where the id of ${at} belongs, and the id is the whole of what a withdrawal names. Nothing was sent, because a delete without one is a request this deployment cannot describe, after which the audit trail would record that this person's access had ended while their grant stood. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  return id;
}

/**
 * One tool row checked into the action this deployment holds, or a refusal saying why not.
 *
 * CHECKED DESPITE {@link VendorTool}'s ARGUMENT THAT THIS ONE ROW IS VALIDATED. That argument is
 * sound about the SDK — `transformToolCases` ends in a throwing `ToolSchema.parse` rather than the
 * warn-only `transform()` everything else here goes through — and it is an argument about the
 * vendor's code rather than about this deployment's. A schema is one version away from being
 * relaxed, and the difference in cost between the two sides is not close: the check is a few
 * comparisons per action, and what it stands between is `inputParameters` going in front of a model
 * as the vendor's own schema when it is not a schema at all.
 *
 * A PLAIN `Error` RATHER THAN A `BrokerRefusalError`, because this listing's failures are not
 * answered to a route. `./composio` records them in an app's `lastError` for an administrator to
 * read on its Plugins page, and `listingSentence` passes an authored message through untouched.
 */
function actionOf(
  row: unknown,
  position: number,
  toolkit: string,
): ComposioAction {
  const at = `row ${position + 1} of Composio's action list for ${toolkit}`;
  if (!hasFields(row)) {
    throw new Error(
      `Composio sent ${sent(row)} as ${at}, where an action belongs, so the list was not refreshed and the tools already held are untouched. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const slug = textOf(row.slug);
  if (slug === null) {
    throw new Error(
      `Composio sent ${sent(row.slug)} where the slug of ${at} belongs, and the slug is what calling the action names, so the list was not refreshed and the tools already held are untouched. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const description = row.description;
  if (description !== undefined && typeof description !== "string") {
    throw new Error(
      `Composio sent ${sent(description)} where ${slug}'s description belongs, and that description is what a model reads to decide whether to call it. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const inputParameters = row.inputParameters;
  if (inputParameters !== undefined && !hasFields(inputParameters)) {
    throw new Error(
      `Composio sent ${sent(inputParameters)} where ${slug}'s input schema belongs. That value is put in front of a model as Composio's own JSON Schema for the action, so a thing that is not an object cannot be shown as one. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const tags = row.tags;
  if (tags !== undefined && !isTextList(tags)) {
    throw new Error(
      `Composio sent ${sent(tags)} where ${slug}'s tags belong, and this deployment reads those to decide whether an action only reads or also writes. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const version = row.version;
  if (version !== undefined && typeof version !== "string") {
    throw new Error(
      `Composio sent ${sent(version)} where ${slug}'s version belongs, and the version travels with every call made to the action. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  return { slug, description, inputParameters, tags, version };
}

/**
 * WHAT THIS DEPLOYMENT WAS DOING WHEN A VENDOR CALL REFUSED, so a translated refusal can say.
 *
 * A CONDITION AND AN OUTCOME ARE TWO DIFFERENT HALVES OF A SENTENCE, and only one of them is the
 * vendor's. "This person already holds an account for gmail" is what Composio determined; "so their
 * connection to gmail was not begun" is what this deployment did about it, and a reader needs both
 * — the first to know why asking again will not help, the second to know what state they are in
 * now. The vendor cannot supply the second, because it does not know which of this file's ten calls
 * it was answering.
 *
 * WRITTEN AT THE CALL SITE AS A FINISHED CLAUSE, in the past tense, so that it reads after "so"
 * without any sentence below having to conjugate it. That is also what keeps the outcomes honest:
 * each one is composed beside the call it describes, where whether anything was sent is a fact
 * rather than a guess.
 */
type VendorCall = {
  /** What did not happen, as a clause following "so": "the app catalogue was not read". */
  outcome: string;
  /** The app the call is about, or null where the question names no app at all. */
  app: string | null;
};

/**
 * The vendor's own name for the condition it raised, or null where it raised something anonymous.
 *
 * READ OFF `name` RATHER THAN ASKED WITH `instanceof`, which is a deliberate choice and not a
 * shortcut. Every error class in `@composio/core` 0.18.1 ends its constructor by assigning its own
 * `name` (`src/errors/*.ts`), so the name is the vendor's published discriminator and is stable
 * across the package boundary; `instanceof` is not, because it is identity on a constructor and
 * therefore hostage to a second copy of the package anywhere in the tree. The SDK makes the same
 * judgement about its own classes — `isRequestAbortError` falls back to `constructor.name` and
 * `name` and says why: "dual-package-hazard cases" (`src/errors/SDKErrors.ts`). `./composio`'s
 * `isSchemaMismatch` reaches for a shape rather than a class for the same reason.
 *
 * AND IT IS WHAT LETS THE TABLE BE A TABLE. Naming eight classes as values would mean importing
 * eight symbols from the vendor into the one file whose whole argument is that the vendor's surface
 * is confined — and a version that renames one would then be a compile error in a switch that is
 * meant to degrade to "not a condition this file knows" rather than to fail the build.
 */
function conditionOf(error: unknown): string | null {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

/**
 * A VENDOR CONDITION AS A SENTENCE THIS DEPLOYMENT WROTE, or null where there is none to write.
 *
 * THE DEFECT THIS CLOSES IS THAT ALMOST NOTHING WAS TRANSLATED. `routes.ts` answers a thrown broker
 * error by reaching for the vendor's own sentence and, finding none, telling the reader that
 * Composio said nothing about why and that an administrator should check this deployment's Composio
 * key. That is exactly right about a socket that hung up. It is wrong twice over about a condition
 * `@composio/core` raised by name: the key is fine — the call that failed usually went out through
 * a listing that had just succeeded on the same key — and several of these states are settled at
 * the vendor, so the "and try again" half of the advice is an instruction to repeat something that
 * will answer identically for ever. The worst of them is the first row below: a person who already
 * has an account for an app was told to check an API key and retry.
 *
 * ONE SENTENCE PER CONDITION AND NO SENTENCE SHARED, which is the property its test asserts in both
 * directions. A translation that gave two conditions one wording would be worse than leaving both
 * alone: the reader would be handed a remedy that is right for somebody else's failure and would
 * have no way to tell, where an untranslated failure at least says plainly that nothing is known.
 *
 * NULL WHERE COMPOSIO'S OWN SERVER EXPLAINED ITSELF, WHICH IS THE LIMIT ON DOING THIS AT ALL.
 * `routes.ts` reads `brokerSentence` first and `vendorSentence` second, so a refusal authored here
 * HIDES the vendor's message rather than joining it. Several of the SDK's classes are wrappers
 * around whatever the API returned — `ComposioFailedToCreateConnectedAccountLink` keeps the
 * `BadRequestError` as its `cause` (`src/models/ConnectedAccounts.ts`), and `vendorSentence` reaches
 * through exactly that nesting — so translating one of those unconditionally would replace a
 * specific server sentence with this deployment's general one. Where the vendor said something a
 * reader can use, the error goes on untouched and the vendor gets the last word.
 *
 * THE ORIGINAL IS KEPT AS `cause` on every refusal, for whoever is reading a log rather than a page.
 * It is never quoted into the message: the file's promise about {@link BrokerRefusalError} is that
 * its sentence is safe to show anybody who could have made the request, and a vendor error object
 * out of `connectedAccounts.link` carries the request that was being minted.
 *
 * WHAT IS DELIBERATELY NOT HERE, because the route's default answer is the correct one for it:
 * `ComposioToolkitFetchError`, which `Toolkits.getToolkits` wraps around EVERY catalogue failure
 * including its own validation one, and whose message is the bare "Failed to fetch toolkits" — the
 * key and the status page genuinely are the remedy; and `ComposioToolExecutionError`, the same
 * wrapper one call further on, whose `cause` carries the server's own words for `vendorSentence` to
 * find and whose own message `./composio`'s {@link VENDOR_PLACEHOLDER} already refuses to pass on.
 */
function vendorRefusal(
  error: unknown,
  call: VendorCall,
): BrokerRefusalError | null {
  if (vendorSentence(error) !== null) return null;

  const app = call.app ?? "the app";
  const outcome = call.outcome;
  const refusal = (message: string): BrokerRefusalError =>
    new BrokerRefusalError(message, { cause: error });

  switch (conditionOf(error)) {
    /*
     * THE ONE THAT WAS DOING THE MOST DAMAGE. `connectedAccounts.link` lists this person's active
     * accounts for the config before it mints anything and refuses where it finds one
     * (`@composio/core` 0.18.1, `src/models/ConnectedAccounts.ts`), which is this deployment's own
     * rule met one layer down — one person holds one account per app, because the call that runs an
     * action names the person and not the account. So it is a settled fact rather than a moment,
     * and "check the key and try again" is advice that cannot ever come true.
     */
    case "ComposioMultipleConnectedAccountsError":
      return refusal(
        `Composio answered that this person already holds a connected account for ${app}, so ${outcome}. That is a settled state at Composio rather than a moment that passes — asking again meets the same answer — and what clears it is disconnecting the account they already hold, on this deployment's Connected accounts page, before another is attached.`,
      );

    /*
     * ACCESS RULES ARE NOT SOMETHING THIS FILE SENDS, which is the whole of why this one is worth a
     * sentence. The SDK raises it when the server rejects ACL fields on an account that is not
     * shared, and nothing here asks for sharing — so the reader must not go looking through this
     * deployment's settings for a field it does not have. The config in Composio's dashboard is
     * where the sharing is decided and where an operator can change it.
     */
    case "ComposioAclOnlyForSharedError":
      return refusal(
        `Composio refused account-sharing rules on an account that is not a shared one, so ${outcome}. This deployment attaches every account to one person and asks for no sharing, so the rules are on the authorization config rather than on anything sent from here: an operator changing how ${app} is shared in Composio's own dashboard is what clears it.`,
      );

    /*
     * REACHED ONLY WHERE THE SERVER SAID NOTHING, by the guard at the top of this function. What is
     * left when it is reached is still worth far more than the route's default, because of what has
     * already happened by the time this call is made: the auth configs were listed through the same
     * key moments earlier and one of them was found enabled. So the two things the default sends an
     * operator to check are both already proven, and the two things a person needs to know — that
     * they were not sent anywhere, and that their consent is unspent — are facts about this
     * particular call that no general sentence carries.
     */
    case "ComposioFailedToCreateConnectedAccountLink":
      return refusal(
        `Composio would not mint a connect link for ${app} and said nothing about why, so ${outcome}. Nobody was sent to a consent screen and no consent was spent. This deployment's key and its authorization config for the app were both read through successfully moments earlier, so neither of those is what to check; Composio's status page is.`,
      );

    /*
     * THE SDK'S OWN SCHEMA REFUSING, ON EITHER SIDE OF THE WIRE. `ValidationError` is raised by
     * nearly every model here — the auth-config create, the connected-account listing and link, the
     * tool listing and the execute all `safeParse` what they are handed and what comes back — and in
     * both directions it means the same thing: this deployment's copy of `@composio/core` and
     * Composio's API no longer agree. It is the one condition below whose remedy is a package
     * rather than a page, which is why it shares its wording with the shape refusals above.
     */
    case "ValidationError":
      return refusal(
        `This deployment's @composio/core refused the request or Composio's answer against its own schema, so ${outcome} — either before Composio was asked or after it had replied. Nothing an operator can set corrects that and the key is not what to check: upgrading this deployment's @composio/core is what fixes it.`,
      );

    /*
     * NOTHING IS WRONG AT COMPOSIO, WHICH IS THE ENTIRE MESSAGE. A cancelled request is a caller's
     * own abort, so sending somebody to a key or a status page is sending them to look at two things
     * that are working. The one honest thing to add is the ambiguity: a call cancelled in flight may
     * or may not have been acted on at the vendor, and this deployment cannot tell which.
     */
    case "ComposioRequestCancelledError":
      return refusal(
        `The request was cancelled before Composio answered, so ${outcome} as far as this deployment can tell — and how far it had got when the cancellation landed is exactly what it cannot tell. Nothing is wrong at Composio and nothing needs setting here; asking for it again is what settles which of the two it was.`,
      );

    /*
     * THE ACCOUNT IS GONE AT THE VENDOR, WHICH THIS DEPLOYMENT'S ROWS DO NOT KNOW. `tools.execute`
     * maps API error code 1803 onto this class (`src/errors/ToolErrors.ts`), and what it reports is
     * a person whose `composio_connections` row still stands over an account Composio no longer
     * holds — a grant withdrawn at Google, or an account removed in the dashboard. Retrying reaches
     * neither; connecting again is what puts an account back under the row.
     */
    case "ComposioConnectedAccountNotFoundError":
      return refusal(
        `Composio holds no connected account for this person and ${app}, so ${outcome}. A grant withdrawn at the provider and an account removed in Composio's own dashboard both read exactly like this, and a retry reaches neither: connecting ${app} again on this deployment's Connected accounts page is what restores it.`,
      );

    /*
     * THE ACTION THIS DEPLOYMENT HOLDS IS NO LONGER ONE COMPOSIO PUBLISHES. Raised by the resolve
     * that `execute` makes before it runs anything (`src/models/Tools.ts`), so nothing ran. The
     * tools this deployment stores are a listing taken at some earlier moment, and the remedy is
     * therefore the same one the app-mismatch refusal below already names: re-read the listing.
     */
    case "ComposioToolNotFoundError":
      return refusal(
        `Composio no longer publishes that action at the version this deployment recorded for it, so ${outcome}. An action withdrawn from an app and a toolkit version retired both read like this, and a retry reaches neither: refreshing ${app}'s tools on its Plugins page records what Composio publishes now.`,
      );

    /*
     * A RECORDED VERSION OF "latest" IS A ROW THAT NEEDS REWRITING, not a call that needs repeating.
     * The SDK refuses `latest` for a tool executed one at a time (`src/models/Tools.ts`), and the
     * version travelling with a call is whatever the listing wrote down for the action, so the fix
     * is on the row rather than at Composio.
     */
    case "ComposioToolVersionRequiredError":
      return refusal(
        `Composio refuses a call whose toolkit version is "latest", and that is the version travelling with this one, so ${outcome}. A dated version is recorded when an app's actions are listed, so refreshing ${app}'s tools on its Plugins page replaces "latest" with a version Composio will accept.`,
      );

    default:
      return null;
  }
}

/**
 * One vendor call, with whatever it refuses with translated on the way out.
 *
 * WRAPPED AROUND THE `await vendor.*` AND NOTHING ELSE, which is the discipline that makes this
 * safe to apply everywhere. Everything else inside these methods is this file's own reading and
 * refusing, and those already carry authored sentences; passing one back through
 * {@link vendorRefusal} could only find a name it does not know, but the narrower scope is what
 * makes that true by construction rather than by inspection.
 *
 * A CALL WITH NO ENTRY HERE IS THE FAILURE MODE THE TABLE IN THE TESTS EXISTS FOR. TypeScript has
 * no checked exceptions, so nothing enumerates the calls that translate and nothing notices a new
 * one that does not; the seam's own test walks every method of both projections and fails the
 * method that forgot.
 */
async function askVendor<T>(
  call: VendorCall,
  ask: () => Promise<T>,
): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    const refusal = vendorRefusal(error, call);
    if (refusal !== null) throw refusal;
    throw error;
  }
}

/**
 * Whether a thrown failure is this deployment's own bug rather than anybody's answer to a request.
 *
 * ONLY A PROGRAM PRODUCES THESE. A `TypeError`, a `ReferenceError` and a `RangeError` are what a
 * mistake in this file or in the SDK looks like — a field read off `undefined`, a name that is not
 * there — and none of them is a thing Composio can reply. The distinction matters in exactly one
 * place, {@link buildComposioClient}'s delete loop, whose whole job is to keep going after a
 * refusal: a loop that absorbs a bug of ours reports it as "Composio refused the rest" and tells an
 * operator to press the button again about a fault that will do the same thing every time.
 *
 * NAMED AS A SMALL CLOSED LIST RATHER THAN GUESSED AT, because the cost of the two mistakes is not
 * symmetric. A vendor error wrongly treated as our bug escapes the loop early and is reported as
 * itself, which is loud and recoverable; our bug wrongly treated as a vendor refusal is swallowed
 * into a count and a retry instruction, which is the state that hides.
 */
function isOurFault(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError
  );
}

/**
 * Every reason a set-wide refusal collected, in one value a `cause` can hold.
 *
 * ALL OF THEM, WHICH IS THE CORRECTION. The two loops below used to throw with `cause: refused[0]`,
 * so a person with five accounts of which three refused left one reason attached and two discarded
 * — and the sentence those throws carry is a COUNT, deliberately, because a count is the thing a
 * reader can act on. The reasons were therefore the only place the detail existed at all, and two
 * thirds of it was being dropped on the floor.
 *
 * CARRIED RATHER THAN LOGGED, and that is this file's rule rather than a preference. A vendor error
 * out of `connectedAccounts.link` or an account delete carries the request it was made for, and a
 * console line is a line in an aggregator; nothing in this module logs a vendor object, for the same
 * reason nothing in it logs the key. A `cause` travels to whoever is already holding the failure.
 *
 * ONE REFUSAL STAYS ITSELF. Wrapping a single error in an `AggregateError` would make every reader
 * unwrap a list to find one thing, and `store.ts` already reads `error.cause` directly.
 */
function everyRefusal(refused: unknown[]): unknown {
  if (refused.length === 1) return refused[0];
  return new AggregateError(
    refused,
    `Composio refused ${refused.length} of the requests this call made.`,
  );
}

/**
 * What this adapter needs of `@composio/core`'s client, written as a shape rather than as a class.
 *
 * A TEST SATISFIES IT WITH AN OBJECT LITERAL, which is the entire argument for it and the reason
 * {@link buildComposioClient} takes one of these instead of an API key. The vendor's own client
 * cannot be constructed without a key and answers nothing without a network, so an adapter that
 * built its own client would be an adapter no test could reach — and this is the file where the
 * field names, the argument order and the refusal below would go wrong unnoticed.
 *
 * Every member is written with METHOD syntax deliberately. Method parameters are compared
 * bivariantly, so a real `Composio` — whose signatures carry optional request-options arguments
 * and wider parameter types than the calls here use — satisfies this without a cast.
 *
 * THE TWO DELETES ARE NOT `Composio`'s, AND THAT IS THE ONE PLACE THIS SHAPE DIVERGES FROM IT. Both
 * of the vendor's own wrappers hard-code the request body they send — `this.client.authConfigs
 * .delete(nanoid, undefined, requestOptions)` and the same line for connected accounts
 * (`@composio/core` 0.18.1, `src/models/AuthConfigs.ts:303-311` and
 * `src/models/ConnectedAccounts.ts:532-540`) — so through them the `revoke_on_delete` parameter
 * cannot be passed at all, and both calls soft-delete while the grant at Google or Slack stands. So
 * the shape below asks for the underlying client's signature instead, and
 * {@link createComposioClient} satisfies it from `composio.getClient()`. See
 * {@link ComposioBroker.revoke} for what that flag is and what its absence made this deployment
 * claim.
 */
export type ComposioVendor = {
  tools: {
    getRawComposioTools(query: {
      toolkits: string[];
      limit: number;
    }): Promise<VendorTool[]>;
    getRawComposioToolBySlug(
      slug: string,
      options?: { version?: string },
    ): Promise<VendorTool>;
    execute(
      slug: string,
      body: {
        arguments: Record<string, unknown>;
        userId: string;
        version: string;
      },
    ): Promise<ComposioResult>;
  };
  toolkits: {
    get(query: { limit: number; sortBy: "usage" }): Promise<VendorToolkit[]>;
  };
  authConfigs: {
    list(query: {
      toolkit: string;
      limit: number;
      /**
       * Ask for the disabled ones too, ALWAYS, which is why this is the literal and not a boolean.
       *
       * The vendor's listing returns enabled configs unless asked otherwise
       * (`AuthConfigListParamsSchema.showDisabled`, `@composio/core` 0.18.1,
       * `src/types/authConfigs.types.ts:124-131`), and a config this listing cannot see is a config
       * {@link ComposioBroker.ensureAuthConfig} creates a second of — which is the exact split that
       * method exists to prevent, arriving through the one door it was not watching. Every question
       * this file asks of the listing is better served by seeing a disabled config and saying so:
       * creation must not duplicate it, deletion must remove it, and consent must refuse against
       * it rather than mint a link that cannot work.
       */
      showDisabled: true;
      /**
       * Where the last page left off, ABSENT on the first request rather than undefined.
       *
       * `AuthConfigListParamsSchema` names it and `AuthConfigs.list` forwards it
       * (`@composio/core` 0.18.1, `src/types/authConfigs.types.ts:124-131`,
       * `src/models/AuthConfigs.ts:95`), which is the fact that decides how a truncated answer is
       * handled here: the catalogue refuses a full page because it has no way to ask for the next
       * one, and this listing does. See {@link everyRowOf}.
       */
      cursor?: string;
    }): Promise<{
      items: VendorAuthConfig[];
      /**
       * The vendor's own word for "there is another page", which was being discarded at this type.
       *
       * `AuthConfigListResponseSchema` carries it (`@composio/core` 0.18.1,
       * `src/types/authConfigs.types.ts:129-133`) and
       * `transformAuthConfigListResponse` fills it in from `next_cursor` on every answer
       * (`src/utils/transformers/authConfigs.ts:72-80`). Omitting it here did not make the
       * truncation go away; it made it unobservable, because a field a projection does not name is
       * a field no caller and no test of a caller can ask about. {@link everyRowOf} reads it, and
       * follows it until the vendor stops offering one — so a listing at {@link LISTING_LIMIT} is
       * no longer a fragment this file can mistake for the whole answer.
       */
      nextCursor?: string | null;
    }>;
    create(
      toolkit: string,
      options: { type: "use_composio_managed_auth"; name: string },
    ): Promise<unknown>;
    /**
     * Delete one auth config, and ask for the upstream credentials on it to be revoked too.
     *
     * THE SAME TRAP AS THE ACCOUNT DELETE BELOW, one level up. The endpoint "soft-deletes an
     * authentication configuration" and revokes "the upstream credentials of every connection using
     * this auth config" only when the flag is passed (`@composio/client` 0.1.0-alpha.76,
     * `resources/auth-configs.d.ts:60-72` and `:651-659`), so a delete without it leaves every
     * grant that was ever made against this config alive at the provider.
     *
     * WHICH IS WHY IT IS PASSED HERE EVEN THOUGH THE ACCOUNTS WERE ALREADY ASKED FOR INDIVIDUALLY.
     * Removing an app revokes each connected person first and drops the config last, and that loop
     * reaches exactly the people this deployment has a `composio_connections` row for. An account
     * whose row drifted — cleared by a confirm that Composio answered `false` to, or lost with a
     * database this deployment restored — is invisible to it and still live at the vendor. This is
     * the one call that reaches those, and there is nothing on this config that removing the app is
     * not meant to end.
     */
    delete(id: string, params: { revoke_on_delete: true }): Promise<unknown>;
  };
  connectedAccounts: {
    list(query: {
      userIds: string[];
      toolkitSlugs: string[];
      /**
       * Which statuses this particular question is about — see {@link CONNECTED} and
       * {@link REVOCABLE}, which are the only two answers this file gives.
       */
      statuses: VendorAccountStatus[];
      /**
       * Both sharing models, ALWAYS, which is why this is the literal and not the enum.
       *
       * OMITTING IT IS NOT "NO OPINION", in exactly the way an omitted limit is not. The parameter
       * defaults to private accounts only (`ConnectedAccountListParamsSchema.accountType`,
       * `@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:286-293`), so a person whose
       * account for an app is a SHARED one reads as not connected, is told to connect an app they
       * already have, and — far worse — is invisible to the revoke, which then reports that there
       * was nothing to withdraw while their grant stands. Neither of the two questions this file
       * asks has any reason to care how an account is shared: the gate is about whether this person
       * can act through the app, and the revoke is about ending every account they can act through.
       */
      accountType: "ALL";
      limit: number;
      /**
       * Where the last page left off, ABSENT on the first request rather than undefined.
       *
       * `ConnectedAccountListParamsSchema` names it and `ConnectedAccounts.list` forwards it
       * (`@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:259-266`,
       * `src/models/ConnectedAccounts.ts:118`). This is the listing the paging matters most for:
       * {@link ComposioBroker.revoke} answers `true` for "this person's access has ended", and one
       * page of their accounts is not the set of their accounts. See {@link everyRowOf}.
       */
      cursor?: string;
    }): Promise<{
      /**
       * The id is the only field read off an account, and it is read off the wire unchecked.
       *
       * `transformConnectedAccountResponse` spreads the raw item and overrides the fields it
       * renames (`@composio/core` 0.18.1, `src/utils/transformers/connectedAccounts.ts:52-66`), so
       * `id` arrives exactly as Composio sent it inside the same warn-only `transform()` as
       * everything else here. An account with no id is the one shape the revoke below cannot act
       * on, and it is the shape nothing was checking for.
       */
      items: { id?: string | null }[];
      /**
       * The same truncation signal as the auth-config listing above, from the same vendor schema.
       *
       * `ConnectedAccountListResponseSchema` spells it `nullish`
       * (`src/types/connectedAccounts.types.ts:297-303`) and the transformer sets it on every
       * answer (`src/utils/transformers/connectedAccounts.ts:109-117`). It matters more here than
       * anywhere else in this file: {@link ComposioBroker.revoke} answers `true` for "this
       * person's access has ended", and it used to have seen only one page of the accounts it
       * would have to end. {@link everyRowOf} follows it until there is none left.
       */
      nextCursor?: string | null;
    }>;
    /**
     * Mint one person's connect link against one auth config, with the page to come back to.
     *
     * `link` RATHER THAN `initiate`, AND RATHER THAN `toolkits.authorize`. All three end at a
     * redirect url, and only the choice between them decides whether this deployment keeps working.
     * `toolkits.authorize` takes a user id, a toolkit and an optional auth config id and has no
     * parameter for a callback at all (`@composio/core` 0.18.1, `src/models/Toolkits.ts:333-338`),
     * which is why consent used to end on Composio's hosted page — the address below has nowhere
     * to travel on that call. `initiate` does carry one (`:249`), but the endpoint under it is
     * retired for Composio-managed OAuth on redirectable schemes — cutover 2026-05-08 for new
     * organizations and 2026-07-03 for the rest, after which it throws
     * `ComposioLegacyConnectedAccountsEndpointRetiredError` (`src/models/ConnectedAccounts.ts:146-160`)
     * — and `use_composio_managed_auth` is exactly what {@link ComposioBroker.ensureAuthConfig}
     * creates. `link` is the vendor's own named replacement for that combination, carries the
     * callback, and answers in the same shape.
     *
     * TAKING THE AUTH CONFIG ID IS NOT A COST HERE. It is the one thing `toolkits.authorize` was
     * doing for us, and it did it by listing the configs and creating one at Composio's managed
     * defaults where it found none — which this deployment already does for itself, at enable
     * time, named so an operator can find it in their dashboard. The listing below is that same
     * read; the creation is not repeated, because an app with no config is a state to report
     * rather than one to paper over.
     */
    link(
      userId: string,
      authConfigId: string,
      options: { callbackUrl: string },
    ): Promise<{ redirectUrl?: string | null }>;
    /**
     * Delete one connected account, and ask for the grant behind it to be revoked too.
     *
     * WITHOUT THE FLAG THIS CALL DOES NOT REVOKE ANYTHING, and that is the vendor's own description
     * of it: it "soft-deletes a connected account by marking it as deleted in the database", which
     * "prevents the account from being used for API calls but preserves the record"
     * (`@composio/client` 0.1.0-alpha.76, `resources/connected-accounts.d.ts:59-72`). The refresh
     * token at Google or Slack survives that untouched. Every path in this deployment that claims
     * to end somebody's access — a person disconnecting, an administrator removing an app, a person
     * being offboarded — runs through here, so an unflagged delete made all three of those claims
     * false at once and wrote `true` into the audit trail beside them.
     *
     * WHAT THE FLAG BUYS IS A REQUEST AND NOT A RESULT, which is the whole reason
     * {@link ComposioBroker.revoke}'s answer is named the way it is. The upstream revocation runs as
     * a background job; the response carries its `revoke_job_id` and the vendor documents that no
     * generally available endpoint polls it (`:7447-7459`). So the answer is deliberately typed as
     * `unknown` and read for nothing: there is no field on it this deployment could turn into a
     * stronger claim than "we asked", and a shape declared here that nothing reads is a shape a
     * vendor rename can break for no benefit.
     */
    delete(id: string, params: { revoke_on_delete: true }): Promise<unknown>;
  };
};

/**
 * The suffix every auth config this deployment creates carries, so a reader can tell whose it is.
 *
 * An auth config is visible in Composio's own dashboard beside any that were made by hand there,
 * and the two are otherwise indistinguishable. The name is the only field this deployment gets to
 * choose, so it is where the provenance goes.
 */
const CONFIG_SUFFIX = "(OpenBot)";

/**
 * Whether this deployment made that auth config, which is the question every decision here turns on.
 *
 * THE SUFFIX IS WRITTEN FOR EXACTLY THIS AND WAS NOT BEING READ. Both callers used to take the
 * first row of an unordered listing, and the two consequences are of different sizes. Removing an
 * app deleted whatever came back first — which can be a config an operator built by hand, with
 * their own scopes and their own tool restrictions, taking every account on it down with it.
 * Beginning a connection attached a person to whatever came back first — which can be a
 * configuration nobody here chose and this deployment cannot see or tighten. And because the order
 * is the vendor's, the two calls can resolve DIFFERENT rows, so an app could be removed while
 * people kept connecting against a config the removal left behind.
 *
 * MATCHED ON THE END OF THE NAME rather than on the whole of it, because the rest of the name is an
 * app's title as an administrator saw it at enable time and titles are edited. The suffix is the
 * part this file writes. Trailing whitespace is tolerated for the same reason it is tolerated
 * anywhere a human-edited string is compared: a name that picked up a space in a dashboard is the
 * same config.
 *
 * IT TAKES A {@link CheckedAuthConfig} AND NOT A {@link VendorAuthConfig}, which is what makes this
 * one line honest. A predicate cannot refuse — it answers true or false — so reading a name the
 * vendor may not have sent here could only ever have meant silently answering `false`, and `false`
 * from this function means "somebody else's config": untouched by a removal, and satisfying the
 * check that stops a second one being created. {@link configOf} is where the absence becomes a
 * sentence instead, upstream of every caller.
 */
function madeHere(config: CheckedAuthConfig): boolean {
  return config.name.trimEnd().endsWith(CONFIG_SUFFIX);
}

/**
 * The statuses that answer "is this person connected", which is the narrow question of the two.
 *
 * ACTIVE ONLY. An `INITIATED` account is somebody who started an authorization and never finished
 * it, and an `EXPIRED` or `REVOKED` one is a grant that no longer opens anything; counting any of
 * them as connected tells a person their app is wired up and then fails every call they make with
 * it.
 */
const CONNECTED: VendorAccountStatus[] = ["ACTIVE"];

/**
 * The statuses that answer "what is there to revoke", which is a deliberately wider question.
 *
 * THE TWO QUESTIONS ARE NOT THE SAME ONE, AND TREATING THEM AS ONE LEFT GRANTS STANDING. This used
 * to be a single ACTIVE listing shared by both, on the argument that "connected" and "there is
 * something to revoke" are the same fact. They are not. A half-finished consent can already have
 * been granted at the provider with the callback never delivered; an `EXPIRED` account is an access
 * token that lapsed and a refresh token that did not; an `INACTIVE` one is a live grant the vendor
 * has set aside. None of them should tell a person they are connected, and every one of them is
 * something whose withdrawal is the entire point of pressing disconnect.
 *
 * `REVOKED` IS THE ONE STATUS LEFT OUT, and left out on purpose rather than forgotten. It is the
 * only value that positively says the grant is already gone, so including it would have this
 * deployment delete a tombstone and then record that it ended somebody's access — the one way the
 * audit field can be made to lie in the direction nobody would check.
 */
const REVOCABLE: VendorAccountStatus[] = [
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "FAILED",
  "EXPIRED",
  "INACTIVE",
];

/**
 * How long one catalogue answer is served to everybody who asks for it.
 *
 * THE CATALOGUE IS READ ONCE PER SEARCH KEYSTROKE OTHERWISE, WHICH IS WHAT THIS IS ABOUT. The admin
 * picker debounces its search field and then asks `/composio/apps`, and that route filters in this
 * process precisely because Composio's toolkit listing takes no search term — so every distinct term
 * a person types is another request for the whole directory, a few hundred rows of it, to answer a
 * question about one. Typing "linear" pulls the catalogue four or five times, and enabling the app
 * afterwards pulls it once more.
 *
 * TEN MINUTES BECAUSE OF WHAT GOES STALE IN IT. The rows are Composio's published toolkits: an app
 * is added to their catalogue or its action count moves every so often, never within one
 * administrator's sitting, and the worst a stale row can do here is show a description or a count
 * that is a few minutes behind. Held for a working session it would be a cache nobody could explain
 * to an operator whose new app is missing; held for seconds it would not survive the debounce it
 * exists for.
 */
const DIRECTORY_TTL_MS = 10 * 60 * 1000;

/**
 * The held catalogue as a copy nobody else holds, which is what makes handing it out safe.
 *
 * WHAT WAS HANDED OUT WAS THE CACHE ITSELF. One array of one set of row objects was returned to
 * every caller for ten minutes, so a route that sorted the rows in place reordered the catalogue for
 * everybody, and one that edited a row — a title trimmed for display, a description truncated —
 * edited what the next caller would read as Composio's answer. Nothing does that today, which is
 * precisely the problem with leaving it: the first caller that does will have changed a cache it
 * had no idea it was holding, and the fault will surface in the NEXT request rather than its own.
 *
 * `categories` IS COPIED TOO, because a shallow spread of the row would hand the same array on. It
 * is the one field here that is not a primitive.
 *
 * COPIED RATHER THAN FROZEN, which was the other candidate. Freezing would make the sharing safe by
 * making a mutation throw, but the type says `BrokerApp[]` and a caller is entitled to sort a list
 * it was given; turning a reasonable caller into a `TypeError` is a worse answer than a few hundred
 * small objects, which is nothing beside the request this cache exists to avoid.
 */
function copyOf(apps: Promise<BrokerApp[]>): Promise<BrokerApp[]> {
  return apps.then((held) =>
    held.map((app) => ({ ...app, categories: [...app.categories] })),
  );
}

/**
 * Both seams, over one vendor client.
 *
 * TAKING THE VENDOR OBJECT RATHER THAN A KEY IS THE SEAM. It is what lets every test of this
 * file's own decisions — which limit went out, which field became which, which call was refused
 * before it was made — run against an object literal and never a socket. {@link createComposioClient}
 * is the one line that turns a key into a vendor, and it is deliberately too thin to have a bug in.
 *
 * The vendor is captured in a closure rather than stored on either returned object, so neither
 * `actions` nor `broker` offers a route back to the client or to the key it holds.
 *
 * @param now The clock the catalogue's lifetime is measured against, injected for the same reason
 * the vendor is. A test that could not move the clock could only assert the cache's hit by counting
 * calls and would have to sleep ten minutes to assert its expiry, so the window would be the one
 * thing here no test could reach. It is a parameter of the builder rather than of
 * {@link ComposioBroker.listApps}, because the seam's callers are routes and none of them has an
 * opinion about what time it is.
 */
export function buildComposioClient(
  vendor: ComposioVendor,
  now: () => number = Date.now,
): {
  actions: ComposioActions;
  broker: ComposioBroker;
} {
  /**
   * This person's accounts for this app, in whichever states the ASKING question is about.
   *
   * ONE LISTING WITH THE STATUSES AS ITS ARGUMENT, rather than one listing both callers share.
   * They shared one until it turned out that the shared answer was wrong for one of them: see
   * {@link CONNECTED} and {@link REVOCABLE} for why "is this person connected" and "what is there
   * to revoke" are different questions. What they do share is everything a drift between them
   * would come from — the breadth of `accountType`, the limit, and the fact that both ask about one
   * person and one app — so the difference between them is exactly the list of statuses and is
   * visible at both call sites.
   */
  const accountsFor = async (
    userId: string,
    toolkit: string,
    statuses: VendorAccountStatus[],
  ): Promise<string[]> => {
    /*
     * EVERY PAGE, AND THE SHAPE OF EACH ONE CHECKED HERE RATHER THAN AT EITHER CALLER, so that the
     * two questions cannot drift on either. `isConnected` answers a boolean and `revoke` deletes by
     * id, and both a truncated listing and an unreadable one are the wrong answer to both for the
     * same reason — `false` claims somebody has no account for an app when nobody looked at all of
     * them, and a delete without an id claims a withdrawal that never went out. The ids are all
     * either caller takes, so this hands back ids and nothing else.
     */
    const rows = await everyRowOf(
      {
        noun: `this person's ${toolkit} accounts`,
        consequence:
          "neither whether they are connected nor what there is to withdraw could be read",
      },
      (cursor) =>
        askVendor(
          {
            outcome: `this person's ${toolkit} accounts were not read`,
            app: toolkit,
          },
          () =>
            vendor.connectedAccounts.list({
              userIds: [userId],
              toolkitSlugs: [toolkit],
              statuses,
              accountType: "ALL",
              limit: LISTING_LIMIT,
              ...(cursor === undefined ? {} : { cursor }),
            }),
        ),
    );
    return rows.map((row, position) => accountIdOf(row, position, toolkit));
  };

  /**
   * The auth configs for one app that THIS DEPLOYMENT made, oldest name first.
   *
   * THE LISTING IS SCOPED TO THE PROJECT AND NOT TO THIS DEPLOYMENT, which is the correction. An
   * auth config is scoped to the project the API key belongs to — so nothing here is hidden from
   * this listing, and that was read as "everything it returns is ours". It is not: an operator with
   * the same project open in Composio's dashboard can create configs for the same app by hand, for
   * purposes this deployment knows nothing about. {@link madeHere} is the only thing that tells the
   * two apart, and every caller below is about an object one of them must not touch.
   *
   * SORTED SO THAT TWO CALLERS AGREE. The vendor's order is not documented, and the whole failure
   * being fixed here is two calls resolving different rows; a total order on the id makes the
   * choice this file makes a stable one, whoever asks and whenever.
   */
  const configsMadeHere = async (
    toolkit: string,
  ): Promise<CheckedAuthConfig[]> => {
    /*
     * EVERY PAGE, BECAUSE A CONFIG ON THE SECOND ONE IS STILL OURS. Read one page and the two
     * callers below are wrong in the two opposite directions {@link madeHere} describes:
     * `ensureAuthConfig` finds none and creates the second config it exists to prevent, and
     * `deleteAuthConfig` leaves one standing, reports a clean removal, and lets `removeServer`
     * delete the app's row over the top of a live grant.
     */
    const rows = await everyRowOf(
      {
        noun: `this deployment's authorization configs for ${toolkit}`,
        consequence:
          "whether one exists is not something this deployment can tell",
      },
      (cursor) =>
        askVendor(
          {
            outcome: `this deployment's authorization configs for ${toolkit} were not read`,
            app: toolkit,
          },
          () =>
            vendor.authConfigs.list({
              toolkit,
              limit: LISTING_LIMIT,
              showDisabled: true,
              ...(cursor === undefined ? {} : { cursor }),
            }),
        ),
    );
    /*
     * CHECKED BEFORE THE FILTER AND NOT AFTER IT, which is the order the whole guard turns on. The
     * filter's question IS the name, so a row checked only once it had been kept would be a row
     * sorted by a field nobody had read — see {@link madeHere} for what each of the two guesses
     * costs. Every row therefore passes {@link configOf} first, including the ones that turn out to
     * belong to an operator's own dashboard work.
     */
    return rows
      .map((row, position) => configOf(row, position, toolkit))
      .filter(madeHere)
      .sort((one, other) => one.id.localeCompare(other.id));
  };

  /**
   * Ask for every one of them and answer with what refused, rather than stopping at the first.
   *
   * A THROW MID-LOOP ABANDONS GRANTS THAT ARE STILL LIVE. Both callers below are deleting a set of
   * things that each independently hold somebody's access, and an exception out of the second of
   * five leaves three untouched and unmentioned — while the caller is told only about the one that
   * failed, so nothing in the answer says the loop did not finish. Attempting all of them makes the
   * failure a statement about a set: this many were asked for and this many refused.
   *
   * SERIALLY RATHER THAN TOGETHER, for the same reason every other call here goes out one at a
   * time: the vendor rate-limits, and a person with several accounts is not a reason to open
   * several connections. The order is the listing's, which is sorted.
   *
   * EVERY REFUSAL IS ANSWERED AND NOT ONLY THE FIRST. What the callers do with this list is throw a
   * COUNT — "two of three were withdrawn and the rest refused" — because a count is what a reader
   * can act on, which makes the reasons the only place the detail lives. Returning them all is what
   * lets {@link everyRefusal} put all of them on the failure the caller raises; the previous version
   * collected them and both callers then read `refused[0]`, so the second and third reason existed
   * for the length of one expression and were then dropped.
   *
   * AND A BUG OF OURS IS NOT A REFUSAL BY COMPOSIO, which is the other half. The catch used to take
   * everything, so a `TypeError` out of this file's own code arrived in the same list as a vendor's
   * 502 and came back to a person as "Composio refused the rest, press disconnect again" — advice
   * about a fault that will do exactly the same thing the second time, wearing the vendor's name.
   * {@link isOurFault} names the three classes only a program produces, and one of those comes
   * straight back out of the loop as itself.
   */
  const askForEach = async <T>(
    items: T[],
    ask: (item: T) => Promise<unknown>,
  ): Promise<unknown[]> => {
    const refused: unknown[] = [];
    for (const item of items) {
      try {
        await ask(item);
      } catch (error) {
        if (isOurFault(error)) throw error;
        refused.push(error);
      }
    }
    return refused;
  };

  /**
   * The catalogue answer this process is currently serving, and the moment it was asked for.
   *
   * A PROMISE RATHER THAN THE ROWS, WHICH IS THE WHOLE ANSWER TO CONCURRENCY. The entry is written
   * before the request is answered, so a second caller arriving while the first is still in flight
   * finds it and awaits the same request. Holding the resolved rows instead would leave the window
   * this cache exists to close wide open: three people opening the picker together, or one person's
   * debounce firing twice, are exactly the case where nothing is cached yet, and each of them would
   * start their own catalogue fetch and then overwrite each other's answer.
   *
   * IT IS PER BUILT CLIENT, not per module. This adapter is built once per deployment key, so in
   * this process that is one cache; in a test it is one cache per {@link buildComposioClient}, which
   * is what lets each test below start from nothing without an API for emptying it.
   */
  let heldDirectory: { at: number; apps: Promise<BrokerApp[]> } | null = null;

  /**
   * The catalogue as the vendor answers it, mapped to the rows an administrator chooses from.
   *
   * ONE PAGE AT THE CEILING, SORTED BY USAGE, AND NO SEARCH TERM.
   *
   * The order matters because the page is finite: at the ceiling the apps most likely to be wanted
   * are the ones that must not be the ones cut off. The absent search term is the subtler half —
   * the SDK's list params name no search field
   * (`ToolkitsListParamsSchema`, `@composio/core` 0.18.1, `src/types/toolkit.types.ts:9-15`)
   * and the parse strips what it does not name, so a term passed here would vanish before the
   * request and leave a caller believing they had filtered a list nobody filtered. Searching the
   * catalogue is this deployment's own job, over the rows below.
   */
  const fetchDirectory = async (): Promise<BrokerApp[]> => {
    const answered: unknown = await askVendor(
      { outcome: "the app catalogue was not read", app: null },
      () => vendor.toolkits.get({ limit: LISTING_LIMIT, sortBy: "usage" }),
    );

    /*
     * THE CONTAINER IS SETTLED BEFORE ITS LENGTH IS MEASURED, which is why this sits above the
     * truncation guard rather than beside the row checks below. `null.length` and `{}.length` are a
     * crash and an `undefined` respectively, and the second of those is the worse one: it compares
     * false against the ceiling, sails past the guard, and reaches a `.map` that throws a sentence
     * naming a vendor method instead of naming the fault.
     */
    const toolkits = Array.isArray(answered) ? answered : null;
    if (toolkits === null) {
      throw new BrokerRefusalError(
        `Composio answered the app catalogue with ${sent(answered)} where a list of apps belongs, so there was no directory to show. ${VENDOR_SHAPE_REMEDY}`,
      );
    }

    if (toolkits.length >= LISTING_LIMIT) {
      /*
       * A FULL PAGE IS NOT A COMPLETE CATALOGUE, and this deployment cannot find out which it is.
       * The same refusal `./composio` makes of a full action listing, for the same reason and one
       * line of vendor code apart.
       *
       * `LISTING_LIMIT` is the largest page the toolkit endpoint allows, and while its params do
       * name a `cursor` (`ToolkitsListParamsSchema`, `@composio/core` 0.18.1,
       * `src/types/toolkit.types.ts:9-15`) there is nothing to put in it: the SDK's
       * `ToolKitListResponse` is a bare array (`:53`) and `transformToolkitListResponse` drops the
       * response's `next_cursor` before any caller sees it. So a catalogue of exactly this many
       * apps and one with more of them answer identically here, and there is no second request that
       * could tell them apart.
       *
       * COMMITTED AS COMPLETE IT WOULD BE CACHED AS COMPLETE, which is what makes this worse than
       * one short answer. The fragment is held for ten minutes and served to both callers, so an
       * administrator searching for an app past the cut is told nothing matched, and the enable
       * route — which checks a slug against this same directory — tells them a real app "is not an
       * app Composio lists". Thrown from inside the fetch so the failure is never the thing that
       * gets held: `listApps` drops an entry whose request rejected.
       */
      throw new BrokerRefusalError(
        `Composio answered with ${toolkits.length} apps, which is the largest page this deployment's @composio/core can ask for, so there may be more that it cannot see. A partial directory is not shown, because an app missing from it reads exactly like an app Composio does not publish.`,
      );
    }

    /*
     * Each absence becomes the value that reads honestly on an administrator's screen, and each
     * PRESENT field that is not what it is declared to be becomes a refusal — see {@link appOf},
     * where both halves of that and every sentence live. An empty description shows as no
     * description; a null logo is the field's documented way of saying the vendor published none,
     * which renders as a gap rather than as a broken image.
     *
     * The categories are the DISPLAY names rather than the slugs, because this list is read by a
     * person choosing an app and "Productivity" is what they are choosing by.
     *
     * A MISSING COUNT BECOMES ZERO, WHICH IS THE ONE IMPERFECT ANSWER HERE. `actionCount` is a
     * number and the shape offers no way to say "not published", so a toolkit that publishes no
     * count reads as an app with no actions. It is the conservative direction — it understates
     * the size of a change rather than overstating it — and Composio publishes a count for every
     * toolkit measured, so this is a guard against the vendor rather than a routine case. A count
     * that arrives as something other than a number is the different case and is refused.
     */
    return toolkits.map(appOf);
  };

  const actions: ComposioActions = {
    async listActions(toolkit, page): Promise<ComposioAction[]> {
      /*
       * The caller's page is passed through rather than defaulted here, because the seam made
       * `page` required precisely so that no layer could quietly supply one. See the module
       * comment on what an omitted limit does beyond truncating.
       */
      const answered: unknown = await askVendor(
        {
          outcome: `${toolkit}'s action list was not refreshed and the tools already held are untouched`,
          app: toolkit,
        },
        () =>
          vendor.tools.getRawComposioTools({
            toolkits: [toolkit],
            limit: page.limit,
          }),
      );

      const tools = Array.isArray(answered) ? answered : null;
      if (tools === null) {
        throw new Error(
          `Composio answered ${toolkit}'s action list with ${sent(answered)} where a list of actions belongs, so the list was not refreshed and the tools already held are untouched. ${VENDOR_SHAPE_REMEDY}`,
        );
      }

      /*
       * Mapped field by field rather than spread, so what crosses the seam is the four things
       * `./composio` documents and not whatever else the vendor's tool object happens to carry.
       * `inputParameters` in particular goes straight in front of a model — which is also why
       * {@link actionOf} checks it rather than passing it on as whatever arrived.
       */
      return tools.map((row, position) => actionOf(row, position, toolkit));
    },

    async execute(call, args): Promise<ComposioResult> {
      /*
       * THE TOOL IS RESOLVED BEFORE IT IS RUN, AND THAT COSTS A ROUND TRIP ON PURPOSE.
       *
       * Composio's execute takes the slug alone — its REST parameters have no toolkit field — so
       * the pair the caller was gated on cannot travel on the wire, and the obligation
       * {@link ComposioActions.execute} writes down has to be discharged here instead. The
       * resolved tool carries the app the vendor will actually run it against, so asking for it
       * first is what makes the check possible at all.
       *
       * `tools.execute` resolves the same tool again internally, so this is a second request
       * rather than a saved one. It buys the one thing a single request cannot: a mismatch that is
       * refused before anything runs, rather than discovered in an audit row afterwards.
       */
      /*
       * READ OUT OF `unknown`, LIKE EVERY LISTING, AND FOR THE REASON THE LISTINGS GIVE. This is
       * one of the two answers in this file that is a single object rather than a page of them,
       * and that is the whole of why it went unchecked for as long as it did: a row type widened to
       * what the wire can send makes an unchecked read fail to build, and an object read straight
       * off an `await` has a declared type that looks settled. It is not — `transformToolCases`'
       * throwing parse is an argument about the SDK's code rather than about this deployment's, and
       * the same one {@link actionOf} declines to rest on.
       */
      const resolved: unknown = await askVendor(
        {
          outcome: `${call.slug} was not resolved and nothing was run`,
          app: call.toolkit,
        },
        () =>
          vendor.tools.getRawComposioToolBySlug(call.slug, {
            version: call.version,
          }),
      );
      if (!hasFields(resolved)) {
        throw new Error(
          `Composio answered ${sent(resolved)} where the ${call.slug} action belongs, so nothing was run: this deployment cannot show that the call it was about to make is for ${call.toolkit} rather than for some other app. ${VENDOR_SHAPE_REMEDY}`,
        );
      }

      /*
       * AN UNREADABLE APP IS NOT THE SAME FACT AS NO APP, AND THEIR REMEDIES DIFFER. The mismatch
       * refusal below ends by telling an administrator to refresh this app's tools, which is right
       * for a slug recorded against a url that has since changed and useless for an SDK that has
       * begun answering a different shape. So a `toolkit` that is present and not an object, or
       * whose slug is not a usable name, is refused as what it is rather than folded into "no app
       * at all" — where it would arrive wearing a remedy that cannot work.
       */
      const answeredApp = resolved.toolkit;
      let ran: string | undefined;
      if (answeredApp !== undefined) {
        if (!hasFields(answeredApp)) {
          throw new Error(
            `Composio sent ${sent(answeredApp)} where the app ${call.slug} belongs to should be, so nothing was run: this deployment cannot show that the call is for ${call.toolkit}. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        const named = textOf(answeredApp.slug);
        if (named === null) {
          throw new Error(
            `Composio sent ${sent(answeredApp.slug)} where the slug of the app ${call.slug} belongs to should be, so nothing was run: a name this deployment cannot read is not one it can compare with ${call.toolkit}. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        ran = named;
      }

      if (ran !== call.toolkit) {
        /*
         * REFUSED RATHER THAN FORWARDED, and both apps are named.
         *
         * The gate in `./access` cleared this run against the app the connection's url names
         * NOW; the slug was recorded by a listing made at some earlier time. Where the two
         * disagree — a url edited between a refresh and a call — forwarding runs one person's
         * Gmail action under a gate that only ever examined their Slack connection. A reader
         * holding only one of the two names cannot tell which of the two is the wrong one, so
         * both go in the sentence. An app the vendor did not name at all is the same refusal:
         * this deployment cannot show that the call is about the app it was gated on.
         */
        throw new Error(
          `${call.slug} was not sent to Composio: this connection is for ${call.toolkit}, and Composio resolves that action to ${
            ran ?? "no app at all"
          }. Refreshing this app's tools on its Plugins page recovers it where the action was recorded against a url that has since changed.`,
        );
      }

      return askVendor(
        { outcome: `${call.slug} was not run`, app: call.toolkit },
        () =>
          vendor.tools.execute(call.slug, {
            arguments: args,
            userId: call.userId,
            version: call.version,
          }),
      );
    },
  };

  const broker: ComposioBroker = {
    /**
     * The catalogue, from memory where this process asked for it less than ten minutes ago.
     *
     * BOTH CALLERS READ THE SAME HELD ANSWER, AND THE SECOND OF THEM IS THE INTERESTING ONE. The
     * search route filters the directory in this process, so caching it is what stops a debounced
     * search field from pulling a few hundred rows once per term. The enable route then reads the
     * directory again to check that the slug it was handed is one Composio lists, and that read
     * comes out of the same cache — which is the right answer rather than a concession, because
     * the slug being checked is one this deployment handed the browser out of THIS cache moments
     * earlier. The check exists to refuse a slug the catalogue never published — a request composed
     * by hand, or a row left over from a url somebody edited — and a ten-minute-old catalogue
     * settles that question exactly as well as a fresh one. The case it gives up is an app Composio
     * withdrew within the window, whose cost is one `mcp_servers` row for an app that answers
     * nothing, removable on the page that added it; the case it buys is that pressing Add does not
     * re-read a catalogue the picker just read.
     *
     * A FAILURE IS NEVER HELD. The entry is dropped when its request rejects, so a vendor that
     * refused once is asked again by the next caller rather than refusing from memory for ten
     * minutes — the failures here are an unset or wrong API key and Composio being down, and the
     * first two are fixed by an operator who then presses the button again, which must be allowed
     * to work. The callers already sharing that one in-flight request do share its failure, which
     * is the truth about their request: they asked while it was being answered.
     *
     * THERE IS NO INVALIDATION, AND THE DESIGN ASKED FOR ONE. It wanted the directory "refreshable
     * by an explicit reload", and that is not built: the lifetime above is the whole of the
     * freshness story. Nothing in this deployment reloads a catalogue today — no page, route or job
     * has such a control — so the method would have no caller, and an invalidation API with no
     * caller is an untested path that reads like a guarantee. The moment a reload button exists,
     * this is where it attaches.
     */
    async listApps(): Promise<BrokerApp[]> {
      const held = heldDirectory;
      if (held && now() - held.at < DIRECTORY_TTL_MS) return copyOf(held.apps);

      /*
       * Stamped when the request goes out rather than when it comes back, so a slow catalogue is
       * held for slightly less than the full window rather than for the window plus its own
       * latency. Written into the slot before it is awaited, which is what a concurrent caller
       * finds.
       */
      const entry = { at: now(), apps: fetchDirectory() };
      heldDirectory = entry;
      /*
       * The drop on failure, registered here rather than written as a try/catch around an await so
       * that this method hands every caller the one shared promise. `heldDirectory === entry`
       * because a later request may already have replaced this one, and clearing that would throw
       * away a good answer over an old failure.
       */
      entry.apps.catch(() => {
        if (heldDirectory === entry) heldDirectory = null;
      });
      return copyOf(entry.apps);
    },

    async ensureAuthConfig({ toolkit, name }): Promise<void> {
      /*
       * IDEMPOTENT BY LOOKING FIRST, because a second config is not a duplicate — it is a split.
       * A person's existing connection is created against one particular auth config, so creating
       * another and connecting the next person to that leaves two populations of connections for
       * one app, and removing "the" config later drops half of them.
       *
       * THE LOOK IS FOR ONE THIS DEPLOYMENT MADE, WHICH IS NARROWER THAN "ANY". It used to be any,
       * and the two ways that was wrong pull in opposite directions. A disabled config of ours was
       * invisible to the listing, so this created the very second config it exists to prevent — and
       * then `authorize` refused, because it looked with the same blind listing and found the app
       * had no config at all. A config an operator made by hand, meanwhile, satisfied the check and
       * this created nothing, leaving every later decision here pointed at an object nobody here
       * chose. Asking for our own answers both: the disabled one counts, and somebody else's does
       * not.
       *
       * WHICH MEANS AN APP CAN END UP WITH TWO CONFIGS, ONE OF THEM SOMEBODY ELSE'S, and that is
       * the intended outcome rather than a tolerated one. Adopting a hand-made config would have
       * this deployment mint people's connections against scopes and tool restrictions it cannot
       * see, and delete it when the app is removed. A config of our own, named, is the thing every
       * decision in this file can actually reason about.
       *
       * This is a read followed by a write and therefore not atomic: two administrators pressing
       * enable at the same instant can both find nothing and both create. Composio offers no
       * create-if-absent, so the window is the vendor's rather than this deployment's, and the
       * cost of losing that race is a spare config rather than a lost connection — spare rather
       * than orphaned, because both carry the suffix and `deleteAuthConfig` takes every one of
       * ours.
       */
      const existing = await configsMadeHere(toolkit);
      if (existing.length > 0) return;

      await askVendor(
        {
          outcome: `no authorization config was created for ${toolkit} and the app is not enabled`,
          app: toolkit,
        },
        () =>
          vendor.authConfigs.create(toolkit, {
            type: "use_composio_managed_auth",
            name: `${name} ${CONFIG_SUFFIX}`,
          }),
      );
    },

    async deleteAuthConfig(toolkit): Promise<void> {
      /*
       * EVERY CONFIG OF OURS, AND NOTHING THAT IS NOT OURS.
       *
       * This used to delete whichever row the vendor happened to return first, on the reasoning
       * that {@link ComposioBroker.ensureAuthConfig} creates at most one, so a second one must be
       * somebody's dashboard work and must be left alone. The reasoning was right and the code did
       * the opposite of it: with no test of the name, "the first row" is as likely to BE the
       * hand-made config — deleting it, and with it every account anybody had connected against it.
       * Reading the name inverts that. Anything without the suffix is untouched whatever order it
       * arrives in, and everything with it goes, which is also the only way the spare config from a
       * lost enable race is ever cleaned up.
       *
       * QUIET WHERE THERE IS NOTHING OF OURS TO DELETE, because removing an app has to be able to
       * happen twice. An app can be removed, re-enabled and removed again, two administrators can
       * press the button together, and an app enabled before this deployment created configs at all
       * has none to drop. In every one of those the end state is the one that was asked for, so a
       * throw would report a failure while the caller got exactly what they wanted.
       */
      const ours = await configsMadeHere(toolkit);
      const refused = await askForEach(ours, (config) =>
        askVendor(
          {
            outcome: `one of this deployment's authorization configs for ${toolkit} was not removed`,
            app: toolkit,
          },
          () =>
            vendor.authConfigs.delete(config.id, { revoke_on_delete: true }),
        ),
      );
      if (refused.length > 0) {
        /*
         * LOUD, because the caller is `removeServer` and the thing it is in the middle of is taking
         * an app away from everybody. A config left standing is a live grant that the removal was
         * supposed to end, and the app's row is deleted after this returns — so a swallowed failure
         * here is the one state nothing in this deployment can find again. The count is the whole
         * message: an operator who can see that one of two configs went knows that pressing remove
         * again finishes the job rather than repeating it. Every refusal the loop met travels as
         * `cause` — see {@link everyRefusal} — because the count is deliberately all the sentence
         * says, which leaves the reasons nowhere else to live.
         */
        throw new BrokerRefusalError(
          `Composio removed ${ours.length - refused.length} of this deployment's ${ours.length} authorization configs for ${toolkit} and refused the rest, so the app has not been fully withdrawn. Removing it again asks only for what is left.`,
          { cause: everyRefusal(refused) },
        );
      }
    },

    async authorize({
      userId,
      toolkit,
      returnUrl,
    }): Promise<{ redirectUrl: string }> {
      /*
       * THE CONFIG THIS DEPLOYMENT ALREADY MADE, AND NO SECOND ONE MADE HERE.
       *
       * `ensureAuthConfig` creates it when an administrator enables the app, which is what makes
       * this a read. Creating one here instead would mint it at the moment somebody presses
       * Connect, unnamed for this deployment and invisible in the dashboard until the first person
       * happened to try — and where a config already existed for an app enabled twice, a second
       * one would split one app's connections across two configs, so removing "the" config later
       * would drop half of them.
       *
       * NONE IS A STATE WITH A REMEDY, NOT A NULL TO WORK AROUND. It is the app enabled before
       * this deployment created configs at all, or a config deleted by hand in Composio's
       * dashboard. Neither is something a person pressing Connect can fix, so the sentence names
       * the app and the administrator's step rather than leaving them at a link that would attach
       * their account to a configuration nobody here chose.
       *
       * AND "NONE" MEANS NONE OF OURS, which is the correction. The read used to take whichever row
       * the vendor returned first, so an app whose only config was one an operator built by hand
       * read as ready and this minted somebody's connection against it — scopes this deployment
       * cannot see, tool restrictions it cannot read, and an object it must not delete. A
       * connection is a lasting attachment to whatever config it was made against, so guessing here
       * is not a guess that can be corrected later.
       */
      const ours = await configsMadeHere(toolkit);
      if (ours.length === 0) {
        throw new BrokerRefusalError(
          `This deployment has no authorization config at Composio for ${toolkit}, so there is nothing to connect an account against. An administrator removing the app on its Plugins page and adding it again creates one.`,
        );
      }

      /*
       * A DISABLED CONFIG IS NOT A CONFIG TO CONNECT AGAINST, and it is now visible enough to say
       * so. The listing asks for disabled configs — it has to, or the creation above duplicates one
       * — which means this is the first read that can meet one. A link minted against it does not
       * work, so sending a person to the vendor would spend their consent and end with nothing
       * attached; and nothing they can do from the page they are on changes it, because enabling a
       * config happens in Composio's dashboard.
       *
       * THE FIRST OF SEVERAL, WHICH IS A CHOICE AND NOT AN ACCIDENT. More than one enabled config
       * of ours means a lost enable race, and both are equally ours and equally valid. What
       * mattered about the old "first row" was that the order was the vendor's and the next caller
       * could get a different one; the listing is sorted on the id, so this is the same config for
       * every person and for the removal that later drops all of them.
       */
      const config = ours.find((held) => held.status === "ENABLED");
      if (!config) {
        /*
         * "DISABLED" IS A CLAIM, AND IT IS ONLY THIS DEPLOYMENT'S TO MAKE WHEN COMPOSIO MADE IT.
         *
         * The test above is `=== "ENABLED"`, so everything that is not that word fell through here
         * — and that is three different states wearing one sentence. A config Composio calls
         * DISABLED is genuinely disabled and the remedy below is genuinely the remedy. A config
         * with no status at all, or one carrying a word this deployment's `@composio/core` has
         * never heard of, is a config whose state is UNKNOWN, and telling an operator it is
         * disabled sends them to a dashboard to enable something that may already be enabled — and
         * where it is, they are left with a page insisting on a fact they can see is false and
         * nothing else to try.
         *
         * BOTH ARE STILL A REFUSAL, WHICH IS THE PART THAT DOES NOT CHANGE. Nothing here mints a
         * link against a config it cannot show is enabled: consent spent against a config that
         * turns out to be disabled attaches nothing and cannot be spent again without asking the
         * person to go round the loop a second time. What the status decides is which sentence a
         * person reads, not whether they are sent.
         *
         * The status is quoted where there is one, for the reason {@link named} gives: it is a
         * closed set of vendor enum names, it carries nobody's data, and it is the one fact an
         * operator can search a dashboard and a changelog for.
         */
        const unreadable = ours.filter((held) => held.status !== "DISABLED");
        const first = unreadable[0];
        if (first !== undefined) {
          throw new BrokerRefusalError(
            `Composio describes ${unreadable.length} of this deployment's ${ours.length} authorization configs for ${toolkit} as ${named(first.status)}, which is neither ENABLED nor DISABLED, so whether a connection begun against one could complete is not something this deployment can tell. No link was made, because consent spent against a config that turns out to be disabled attaches nothing. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        throw new BrokerRefusalError(
          `Every authorization config this deployment holds at Composio for ${toolkit} is disabled, so a connection begun against one could not complete. An administrator can enable it in Composio's dashboard, or remove the app on its Plugins page and add it again.`,
        );
      }

      /*
       * THE RETURN ADDRESS IS THE WHOLE POINT OF THIS CALL, and it is the caller's rather than
       * this file's: the adapter knows Composio, and where a person belongs afterwards is a fact
       * about this deployment's own pages. It is never logged and never quoted in the refusal
       * below, for the reason the url itself is not.
       *
       * NO `allowMultiple`, WHICH LEAVES THE VENDOR ENFORCING THE RULE THIS DEPLOYMENT ALREADY
       * STATES. One person holds one account per app here, because the call that runs an action
       * names the person and not the account — so with two accounts attached, which mailbox a Bot
       * reads would be Composio's choice and nothing here could say which one it had been. The
       * route refuses a second connection before it ever reaches this method, and that refusal is
       * the sentence a person reads; this is the same rule one layer further down, where the
       * vendor is the only party that can still see an account this deployment's rows have lost
       * track of. `toolkits.authorize` passed `allowMultiple: true` unconditionally — the SDK
       * calls it a "magic function" for exactly that — which is the opposite of what this
       * deployment wants.
       */
      const request: unknown = await askVendor(
        {
          outcome: `this person's connection to ${toolkit} was not begun`,
          app: toolkit,
        },
        () =>
          vendor.connectedAccounts.link(userId, config.id, {
            callbackUrl: returnUrl,
          }),
      );
      /*
       * THE OTHER SINGLE OBJECT, AND THE ONE WITH A PERSON WAITING ON IT. Read out of `unknown` for
       * the reason the resolve in `execute` is: nothing about this answer is validated any harder
       * than a listing row, and a field read off a null answer is a `TypeError` that reaches
       * somebody who has just pressed Connect as though Composio were down.
       */
      if (!hasFields(request)) {
        throw new BrokerRefusalError(
          `Composio answered ${sent(request)} where the connection it was asked to begin to ${toolkit} belongs, so there is nothing to send this person to — and whether anything was begun at Composio is not something this deployment can tell from that. ${VENDOR_SHAPE_REMEDY}`,
        );
      }

      const redirectUrl = request.redirectUrl;
      /*
       * PRESENT AND NOT A URL IS THE SHAPE THE ABSENCE GUARD BELOW CANNOT SEE. `!redirectUrl` is
       * false for an object, a number and a list alike, so each of those would be returned as the
       * `redirectUrl: string` this method promises and put in a `Location` header — a page nobody
       * can visit, handed to a person as the consent screen they were sent to.
       */
      if (
        redirectUrl !== undefined &&
        redirectUrl !== null &&
        typeof redirectUrl !== "string"
      ) {
        throw new BrokerRefusalError(
          `Composio sent ${sent(redirectUrl)} where the page to send this person to for ${toolkit} belongs, so nobody was sent anywhere. ${VENDOR_SHAPE_REMEDY}`,
        );
      }
      if (!redirectUrl) {
        /*
         * The SDK spells `redirectUrl` nullable because not every auth scheme has one — an API-key
         * toolkit is connected by typing a secret, not by visiting a page. This deployment's
         * enablement flow sends a person to a url, so no url is nothing to do rather than a
         * success, and the sentence says which app it was about. The url itself is never quoted
         * anywhere, here or elsewhere: whoever opens it attaches an account to this person's
         * connection, so it is handed to the browser that asked and then forgotten.
         */
        throw new BrokerRefusalError(
          `Composio began a connection to ${toolkit} but answered with no page to visit, so there is nothing to send this person to. An app that is connected by entering a credential rather than by visiting a page cannot be connected from here.`,
        );
      }
      return { redirectUrl };
    },

    async isConnected({ userId, toolkit }): Promise<boolean> {
      return (await accountsFor(userId, toolkit, CONNECTED)).length > 0;
    },

    async revoke({ userId, toolkit }): Promise<boolean> {
      /*
       * THE ANSWER IS WHAT WAS ASKED FOR, not whether the call threw. `false` here means there was
       * nothing to withdraw, which is what the audit trail's `vendorRevocationRequested` is for: a
       * reader has to be able to tell an account this deployment acted on from one that outlives it
       * somewhere else.
       *
       * ASKED FOR, RATHER THAN DONE, AND THE FIELD IS NAMED FOR THAT. The delete carries
       * `revoke_on_delete`, which is what turns it from a record-keeping soft-delete into an actual
       * withdrawal — and what it starts is a background job the vendor gives no supported way to
       * poll. So the account is gone at the broker by the time this returns and nothing here can
       * call with it again; whether Google has torn up the refresh token happens afterwards. `true`
       * claims exactly that much. See {@link ComposioVendor} for the two declarations this rests on.
       *
       * EVERY ACCOUNT, not the first, and in every state that could still be a grant. One person
       * can hold more than one account for one app — two mailboxes, or a stale account beside a
       * fresh one, or a shared account beside their own — and each of them is access this
       * deployment's calls could run under. See {@link REVOCABLE} for why the listing here is wider
       * than the one behind `isConnected`.
       */
      const accounts = await accountsFor(userId, toolkit, REVOCABLE);
      const refused = await askForEach(accounts, (id) =>
        askVendor(
          {
            outcome: `one of this person's ${toolkit} accounts was not withdrawn`,
            app: toolkit,
          },
          () => vendor.connectedAccounts.delete(id, { revoke_on_delete: true }),
        ),
      );

      if (refused.length > 0) {
        /*
         * A PARTIAL WITHDRAWAL IS A FAILURE AND NOT A `true`, and the reason is the row this throw
         * protects. `store.ts` revokes and only then deletes the `composio_connections` row, which
         * is the only thing in this deployment that names which app this person connected. Answer
         * `true` here on a partial and that row is deleted, the trail records a disconnection, and
         * the account this call could not end is left live with nothing pointing at it — the exact
         * state the store's revoke-before-delete order exists to make impossible. Throwing leaves
         * the row standing, so pressing disconnect again is a second attempt with everything the
         * first one had, and the accounts already gone are no longer in the listing, so the retry
         * converges rather than repeating.
         *
         * WHICH IS ALSO WHY IT IS NOT A `true` WITH A GRUMBLE. Nothing was disconnected in the
         * sense the person asked about: their app still answers. The count is in the sentence
         * because "some of your accounts were withdrawn" is the one thing a reader cannot work out
         * for themselves, and EVERY refusal the loop met is kept as `cause` for whoever is reading
         * a log rather than a page — see {@link everyRefusal} for why all of them rather than the
         * first, which is what this used to keep.
         */
        throw new BrokerRefusalError(
          `Composio withdrew ${accounts.length - refused.length} of this person's ${accounts.length} accounts for ${toolkit} and refused the rest, so their access to it has not ended. Disconnecting again asks only for the accounts that are left.`,
          { cause: everyRefusal(refused) },
        );
      }

      return accounts.length > 0;
    },
  };

  return { actions, broker };
}

/**
 * The lines that turn this deployment's API key into a vendor client.
 *
 * Everything this file decides lives in {@link buildComposioClient}, which is why this function has
 * no decision worth testing: it constructs the vendor and hands it over. The key is a parameter here
 * and a private field of the vendor's client thereafter, and no path out of this module carries it
 * — see the module comment.
 *
 * IT IS NO LONGER ONE LINE, AND THE REASON IS THE TWO DELETES. `Composio` used to satisfy
 * {@link ComposioVendor} whole, passed straight in. It cannot any more: its own `authConfigs.delete`
 * and `connectedAccounts.delete` send a hard-coded empty body and therefore cannot ask for the
 * upstream revocation, which is the difference between ending somebody's access and filing it away.
 * The underlying `@composio/client` takes the parameter, so those two members are satisfied from
 * `getClient()` and the rest from the SDK's own models. A wrapper per member rather than a spread,
 * so that the arrow's own type checks against the shape above — a vendor method whose signature
 * drifted would fail here rather than at the call site.
 *
 * NO NEW IMPORT, WHICH IS WHY THE ONE-IMPORT-SITE RULE SURVIVES THIS. `getClient()` is public on the
 * SDK's own object and the client's types are inferred from it; `@composio/client` is not named
 * anywhere under `server/src`, so a version bump still has exactly this file to be read against.
 */
export function createComposioClient(apiKey: string): {
  actions: ComposioActions;
  broker: ComposioBroker;
} {
  const composio = new Composio({
    apiKey,
    // Their default telemetry installs its own interrupt handlers, and this is a self-hosted
    // product whose operator never opted into a third party's analytics.
    allowTracking: false,
    // Both default the other way, so both have to be said. The version check reaches npm for the
    // SDK's latest release as the client is constructed, and a deployment's boot must not depend
    // on the vendor's release feed.
    disableVersionCheck: true,
  });
  const client = composio.getClient();

  return buildComposioClient({
    tools: composio.tools,
    toolkits: composio.toolkits,
    authConfigs: {
      list: (query) => composio.authConfigs.list(query),
      create: (toolkit, options) =>
        composio.authConfigs.create(toolkit, options),
      delete: (id, params) => client.authConfigs.delete(id, params),
    },
    connectedAccounts: {
      list: (query) => composio.connectedAccounts.list(query),
      link: (userId, authConfigId, options) =>
        composio.connectedAccounts.link(userId, authConfigId, options),
      delete: (id, params) => client.connectedAccounts.delete(id, params),
    },
  });
}
