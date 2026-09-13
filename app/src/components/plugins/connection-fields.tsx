import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import type { BrokerField } from "@/lib/plugins/mutations";

/**
 * What one app asks for, drawn from what that app published.
 *
 * NOTHING HERE IS PER-APP KNOWLEDGE. The label, the help sentence, the masking and the pre-filled
 * default all come off the field, which came off Composio. An app this deployment has never heard of
 * draws correctly for the same reason Gmail does: Perplexity publishes one secret `generic_api_key`
 * whose help sentence says to look for a value starting with `pplx-`; Shopify publishes a plain
 * subdomain beside a secret admin token; Firecrawl publishes a base URL carrying a default most
 * people keep. All three are this list, with different rows in it.
 *
 * SO THERE IS NOTHING TO SWITCH ON. Across forty sampled apps every required field is a plain string
 * and the most any app asks for is three, and the server refuses anything that is not a string
 * before it reaches here — so this is a list of text inputs and deliberately nothing more. A field
 * type to branch on would be a second vocabulary to keep level with the vendor's, invented for a
 * shape nobody publishes.
 *
 * THE LIST CHANGES UNDER THIS FORM, WHICH IS WHY THE VALUES FOLLOW IT. The row that opens this asks
 * the app again on every open — the catalogue is the vendor's, and what an app wants typed in is
 * free to differ from what it wanted last time — but it opens holding the previous answer, so this
 * form is mounted on the old list and handed the new one a moment later. Seeded once, it would draw
 * today's rows over yesterday's values: a newly published field with its default missing, and a
 * retired field's name still in the values and still going up with the submission, which is the 400
 * that tells somebody their current form is not the current form.
 *
 * THE VALUES ARE HELD HERE AND IN THE REQUEST THAT CARRIES THEM, AND NOWHERE ELSE: no query cache,
 * no router state, no local storage. They are somebody's own key. This copy is the component's, so
 * it goes when the dialog closes; the mutation's copy is erased as its request settles, because a
 * mutation keeps the input it was called with for as long as its observer lives — see
 * `connectBrokeredWithFieldsMutationOptions` in `lib/plugins/mutations.ts`. Between them the key's
 * whole life here is the form somebody is filling in and the request it is sent in, which is the
 * most a credential we were only ever asked to forward may have.
 */
export function ConnectionFields({
  fields,
  onSubmit,
  busy,
}: {
  fields: BrokerField[];
  onSubmit: (values: Record<string, string>) => void;
  /** Whether the submission is already in flight, so the button cannot start a second one. */
  busy: boolean;
}) {
  /* Seeded from the defaults the app published, so a field most people keep is already filled in. */
  const [values, setValues] = useState<Record<string, string>>(() =>
    seed(fields),
  );
  /*
   * The list those values were last filled in against, kept so a new one can be told from a render.
   *
   * Adjusted during render rather than in an effect, which is what React asks for when state has to
   * follow a prop: the fix happens before this paint, so the new field is drawn with its default
   * already in it rather than drawn empty and corrected a frame later, under somebody's cursor.
   */
  const [published, setPublished] = useState<BrokerField[]>(fields);
  if (published !== fields) {
    setPublished(fields);
    setValues((held) => reconcile(fields, published, held));
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      {fields.map((field) => (
        /* `muted` rather than a card: `--card` and `--popover` are the same colour, so a
           card-coloured row inside a dialog is no row at all. */
        <Item key={field.name} variant="muted">
          <ItemContent>
            <ItemTitle>
              <label htmlFor={field.name}>{field.label}</label>
            </ItemTitle>
            {/* Unclamped: the app's own instructions are the point of the row, not a hint under it. */}
            {field.help ? (
              <ItemDescription className="line-clamp-none">
                {field.help}
              </ItemDescription>
            ) : null}
            <Input
              autoComplete="off"
              id={field.name}
              onChange={(event) =>
                setValues((held) => ({
                  ...held,
                  [field.name]: event.target.value,
                }))
              }
              required={field.required}
              /* The app said which value is the secret; nothing here guesses from its name. */
              type={field.secret ? "password" : "text"}
              value={values[field.name] ?? ""}
            />
          </ItemContent>
        </Item>
      ))}
      <Button className="self-end" disabled={busy} size="sm" type="submit">
        {busy ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}

/** What a freshly published list of fields is worth before anybody has typed: its own defaults. */
function seed(fields: BrokerField[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field.name, field.default ?? ""]),
  );
}

/**
 * The values for a list the app has just published, carrying over what somebody had typed.
 *
 * THE VALUES ARE EXACTLY THE NAMES THE APP PUBLISHES NOW. A name it has stopped publishing is
 * dropped rather than carried along, because the only thing left to happen to it is being sent, and
 * the server refuses the whole connection over a field the app does not ask for.
 *
 * AND A FIELD NOBODY TOUCHED TAKES TODAY'S DEFAULT. Untouched is knowable rather than guessed: a
 * value equal to what the previous list seeded is one this form put there, so the new list's answer
 * replaces it, and anything else is somebody's own typing and survives. That is what keeps this from
 * being a choice between losing a half-typed key and pinning a default the vendor has changed.
 */
function reconcile(
  next: BrokerField[],
  previous: BrokerField[],
  held: Record<string, string>,
): Record<string, string> {
  const seeded = new Map(
    previous.map((field) => [field.name, field.default ?? ""]),
  );
  return Object.fromEntries(
    next.map((field) => {
      const value = held[field.name];
      const untouched = value === undefined || value === seeded.get(field.name);
      return [field.name, untouched ? (field.default ?? "") : value];
    }),
  );
}
