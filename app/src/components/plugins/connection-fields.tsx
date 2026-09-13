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
 * THE VALUES ARE HELD IN THIS COMPONENT AND NOWHERE ELSE: no query cache, no router state, no local
 * storage. They are somebody's own key. They go to the mutation on submit and are gone when the
 * dialog closes, because keeping a credential we were only ever asked to forward is the one thing
 * this form must not do.
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
    Object.fromEntries(
      fields.map((field) => [field.name, field.default ?? ""]),
    ),
  );

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
