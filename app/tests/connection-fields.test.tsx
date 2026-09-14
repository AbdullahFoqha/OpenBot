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
