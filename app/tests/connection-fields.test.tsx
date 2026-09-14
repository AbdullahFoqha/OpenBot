import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionFields } from "@/components/plugins/connection-fields";
import type { BrokerField } from "@/lib/plugins/mutations";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/**
 * The form one app's published fields are drawn into, and the names in it are the VENDOR's.
 *
 * THE HARNESS IS `button-native.test.tsx`'s, which is the lightest one here: `GlobalRegistrator` in
 * `beforeAll`/`afterAll`, `cleanup` in `afterEach`, and queries off `render()`'s own return. This
 * component takes no router and no query client — it is a list of inputs and a submit — so nothing
 * else is wrapped around it.
 *
 * WHAT IS UNDER TEST IS THE SAME CONCERN THE SERVER SIDE OF THIS FLOW WAS CORRECTED FOR: a name
 * Composio chose is used here as a key into the object holding what somebody has typed, and a plain
 * object answers for names nobody put in it. The list is re-published on every open, so the carrying
 * over of typed values across a new list is exactly where that read happens.
 */
const API_KEY: BrokerField = {
  name: "api_key",
  label: "API key",
  help: "Your Firecrawl API key, a token starting with fc-",
  required: true,
  secret: true,
};

/** A field named after something every object already answers for, with a default of its own. */
const RENDERING: BrokerField = {
  name: "toString",
  label: "Rendering",
  help: "How this account names itself.",
  required: false,
  secret: false,
  default: "plain",
};

test("a newly published box named toString is filled with its default, not with a function", async () => {
  /*
   * THE READ THAT GOES WRONG IS `held[field.name]` ON A LIST THAT HAS JUST CHANGED. The dialog asks
   * the app what it wants on every open and hands this form the answer while it is already mounted,
   * so a field the app has only just started publishing is looked up in values that never held it —
   * and `held["toString"]` is not `undefined` on a plain object, it is the function hanging off
   * `Object.prototype`. Read as somebody's typing, it survives into the values, is drawn into the
   * box, and is submitted under a name the app really does read.
   */
  const submissions: Record<string, string>[] = [];
  const submit = (values: Record<string, string>) => {
    submissions.push(values);
  };

  const { container, getByLabelText, rerender } = render(
    <ConnectionFields busy={false} fields={[API_KEY]} onSubmit={submit} />,
  );

  /*
   * TYPED RATHER THAN SET. The box is a Base UI input, which reads a keystroke and not a `change`
   * event dispatched at the element, so `fireEvent.change` moves the DOM value and leaves this
   * form's own state where it was — which would make the assertion below pass on nothing.
   */
  await userEvent.type(getByLabelText("API key"), "fc-live-a-secret");

  // The same dialog, a moment later, holding what the app publishes now.
  rerender(
    <ConnectionFields
      busy={false}
      fields={[API_KEY, RENDERING]}
      onSubmit={submit}
    />,
  );

  /*
   * THE BOX ITSELF, WHICH IS WHAT THE PERSON IS LOOKING AT. `getByLabelText` also asserts the label
   * still points at its own input — the ids these draw from are the vendor's names, so they are
   * namespaced rather than used as document-wide ids, and a label that stopped finding its box
   * would be that namespacing applied to one of the two and not the other.
   */
  const rendering = getByLabelText("Rendering") as HTMLInputElement;
  expect(rendering.value).toBe("plain");

  const form = container.querySelector("form");
  if (form === null) throw new Error("the form was not drawn");
  fireEvent.submit(form);

  // What was typed, and the new box's own default beside it — nothing that came off a prototype.
  expect(submissions).toEqual([
    { api_key: "fc-live-a-secret", toString: "plain" },
  ]);
});

/**
 * A name every object already answers for, published with no default, so a keystroke is all it has.
 *
 * `__proto__` FAILS THE OTHER WAY FROM `toString`, AND ONLY ONE OF THE TWO PROTECTIONS CATCHES IT.
 * Reading `toString` off a plain object hands back a function, which the reconcile below refuses by
 * going through a `Map`; assigning `__proto__` on a plain object reaches the prototype setter,
 * which ignores a string — so the value is dropped between the keystroke and the request, and no
 * read anywhere can recover it. Only the bag having no prototype keeps it.
 */
const PROXY: BrokerField = {
  name: "__proto__",
  label: "Proxy",
  help: "The gateway this account is reached through.",
  required: false,
  secret: false,
};

test("what somebody types into a box named __proto__ is what gets submitted", async () => {
  /*
   * THE PROTECTION THIS PINS ON ITS OWN IS `bagOf`'s NULL PROTOTYPE. The test above covers both
   * protections at once and passes with either one of them removed — a name answered off
   * `Object.prototype` is refused by the bag having no prototype AND by {@link reconcile} reading
   * through maps, so neither was held by anything on its own. Nothing is re-published here, so
   * `reconcile` never runs and cannot answer for this one: a plain object silently drops this
   * assignment, and what the person typed never leaves the form.
   */
  const submissions: Record<string, string>[] = [];
  const submit = (values: Record<string, string>) => {
    submissions.push(values);
  };

  const { container, getByLabelText } = render(
    <ConnectionFields
      busy={false}
      fields={[API_KEY, PROXY]}
      onSubmit={submit}
    />,
  );

  await userEvent.type(getByLabelText("API key"), "fc-live-a-secret");
  await userEvent.type(getByLabelText("Proxy"), "gateway.example.test");

  // The box itself, because a value the bag dropped is also a box that stays empty under a cursor.
  expect((getByLabelText("Proxy") as HTMLInputElement).value).toBe(
    "gateway.example.test",
  );

  const form = container.querySelector("form");
  if (form === null) throw new Error("the form was not drawn");
  fireEvent.submit(form);

  /*
   * READ AS ENTRIES RATHER THAN COMPARED WITH A LITERAL, because `__proto__` written as a key in an
   * object literal is the prototype rather than a key — the expectation would decide what it means
   * to assert. `Object.entries` asks the submitted bag what it actually holds.
   */
  expect(submissions).toHaveLength(1);
  expect(Object.entries(submissions[0])).toEqual([
    ["api_key", "fc-live-a-secret"],
    ["__proto__", "gateway.example.test"],
  ]);
});

test("a box named __proto__ nobody touched takes the default the app publishes now", async () => {
  /*
   * AND THIS IS THE PROTECTION THE ONE ABOVE CANNOT ANSWER FOR: {@link reconcile} reading both
   * sides through maps. "Nobody typed this" is decided by comparing what is held against what the
   * PREVIOUS list seeded, and that second lookup is by field name — so a plain object holding the
   * previous defaults answers `Object.prototype` for this name rather than the default it was
   * given. Nothing then equals anything, the field reads as somebody's own typing, and a default
   * the vendor has just changed is pinned to yesterday's value with nothing to notice it.
   */
  const submissions: Record<string, string>[] = [];
  const submit = (values: Record<string, string>) => {
    submissions.push(values);
  };

  const { container, getByLabelText, rerender } = render(
    <ConnectionFields
      busy={false}
      fields={[API_KEY, { ...PROXY, default: "gateway.example.test" }]}
      onSubmit={submit}
    />,
  );

  await userEvent.type(getByLabelText("API key"), "fc-live-a-secret");

  // The same dialog a moment later, with the app publishing a different gateway.
  rerender(
    <ConnectionFields
      busy={false}
      fields={[API_KEY, { ...PROXY, default: "edge.example.test" }]}
      onSubmit={submit}
    />,
  );

  expect((getByLabelText("Proxy") as HTMLInputElement).value).toBe(
    "edge.example.test",
  );

  const form = container.querySelector("form");
  if (form === null) throw new Error("the form was not drawn");
  fireEvent.submit(form);

  expect(submissions).toHaveLength(1);
  expect(Object.entries(submissions[0])).toEqual([
    ["api_key", "fc-live-a-secret"],
    ["__proto__", "edge.example.test"],
  ]);
});
