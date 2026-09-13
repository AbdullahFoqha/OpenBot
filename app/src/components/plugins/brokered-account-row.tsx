import { IconArrowUpRight } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  type BrokerField,
  brokeredConnectionFieldsMutationOptions,
  confirmBrokeredConnectionMutationOptions,
  connectAccountMutationOptions,
  connectBrokeredWithFieldsMutationOptions,
  disconnectBrokeredMutationOptions,
} from "@/lib/plugins/mutations";

/**
 * One person's own brokered account, on whichever screen is asking.
 *
 * Two screens draw this — the connector's admin page, where an administrator checks the setup they
 * have just finished, and that person's own connected-accounts page — and they drew it twice, forty
 * lines apiece, comment for comment. The cost was not the duplication: it was that both copies held
 * the same two defects, a disconnect that went on reading "Connected" and a deployment with no
 * Composio key that said nothing about it, and both had to be found twice to be fixed once.
 *
 * What genuinely differs between the two stays an argument. An administrator is told their setup is
 * complete without this row; a person is told which Bots can read them as them. The consent flow
 * returns to whichever screen started it. Everything else — what the row says while there is no
 * key, what the dot means, what disconnecting ends — is one answer and lives here.
 */

/**
 * What this person actually does to connect: click through a consent screen, type a secret, or
 * nothing at all.
 *
 * A coarser question than the scheme the app's authorization config was created as. The recorded
 * `authScheme` is a vendor literal — `OAUTH2`, `DCR_OAUTH`, `API_KEY`, `NO_AUTH` and the rest — and
 * a row that branched on it would be re-asking the same three-way question at every branch, each
 * copy free to forget a literal the others remembered.
 */
export type BrokeredAccountKind = "consent" | "fields" | "no-auth";

/** The schemes whose secret a person types, which is the whole of what `fields` means here. */
const FIELD_SCHEMES = ["API_KEY", "BASIC", "BEARER_TOKEN", "BASIC_WITH_JWT"];

/**
 * Which of the three a recorded scheme is.
 *
 * Everything that is not `NO_AUTH` and not one of the typed schemes is consent, including a scheme
 * this file has never heard of: the catalogue is the vendor's and it may name a new one tomorrow,
 * and sending somebody to a consent screen that turns out not to exist is a refusal they can read,
 * where an empty form is a box they cannot fill in.
 */
function kindOf(authScheme: string | null): BrokeredAccountKind {
  if (authScheme === "NO_AUTH") return "no-auth";
  return authScheme !== null && FIELD_SCHEMES.includes(authScheme)
    ? "fields"
    : "consent";
}

/** The row's state and the things it can do, from {@link useBrokeredAccount}. */
export type BrokeredAccount = {
  /** Whether this person's account is live, as the vendor last answered. */
  connected: boolean;
  /**
   * Whether this deployment has a Composio key at all.
   *
   * Carried through the hook rather than passed to the row separately, so a caller wires the row up
   * once: with no key there is no broker to ask, nothing to confirm on arrival, and neither action
   * below can do anything but fail.
   */
  configured: boolean;
  /** See {@link BrokeredAccountKind}. Derived here so no branch below re-asks. */
  kind: BrokeredAccountKind;
  /** Leave for the vendor's consent screen. */
  connect: () => void;
  /** End the account at Composio, not only here. */
  disconnect: () => void;
  connecting: boolean;
  disconnecting: boolean;
  /**
   * What the app wants typed in, once it has been asked. Null until then, and for every app nobody
   * types anything into.
   */
  fields: BrokerField[] | null;
  /** Ask the app what it needs, which is the first press on a `fields` app. */
  requestFields: () => void;
  /**
   * Finish the connection with what the person typed.
   *
   * The values are handed straight to the request and held nowhere else: they are somebody's own
   * key, and this hook keeps no copy a later render could read back.
   */
  submitFields: (values: Record<string, string>) => void;
  requestingFields: boolean;
  submittingFields: boolean;
};

export function useBrokeredAccount(input: {
  serverId: string;
  /** Whether this row is about a brokered app at all. Asked of the recorded row by the caller. */
  brokered: boolean;
  /** See {@link BrokeredAccount.configured}. */
  configured: boolean;
  /** What this deployment recorded, which is what stands until the vendor has answered anything. */
  recorded: boolean;
  /**
   * How the app's authorization config was CREATED, as the vendor's own scheme literal.
   *
   * Read off the recorded server row rather than off a connection row: the connections endpoint
   * answers two different row shapes, so the absence of a field there says which READ a row came
   * from and never how an app connects. Null where the app is not brokered at all.
   */
  authScheme: string | null;
  /** Which screen the vendor's callback puts somebody down on. */
  returnTo: "settings" | "admin";
  /**
   * Where this row's failures go: the screen's own banner.
   *
   * Called with null as an action starts, so the reason the last attempt failed is not left sitting
   * over the one now in flight.
   */
  report: (message: string | null) => void;
}): BrokeredAccount {
  const queryClient = useQueryClient();
  const {
    authScheme,
    brokered,
    configured,
    recorded,
    report,
    returnTo,
    serverId,
  } = input;

  /*
   * Ask the vendor whether this person's brokered account is actually live, on arrival.
   *
   * The return trip from consent is an ordinary redirect with nothing signed in it, so being back
   * on the page proves nothing about what happened at the vendor. The row a screen would otherwise
   * read is written from that same unproven return, which is why the answer is asked for rather
   * than assumed.
   *
   * Deliberately not wired into the banner. Somebody who abandoned the consent screen — or who has
   * simply never connected — arrives with nothing at the vendor to confirm, and that is an ordinary
   * state of the page, not a failure of it. It reads as not connected, which is what it is; a red
   * sentence across the top would be the page reporting its own question as somebody's problem.
   *
   * Not asked at all where there is no key. The endpoint answers 503, the screen swallows it, and
   * the row falls back to whatever we recorded — so the question can only ever be a wasted request
   * that ends in the one state this row has a sentence for anyway.
   */
  const confirmation = useMutation(
    confirmBrokeredConnectionMutationOptions(queryClient),
  );
  const confirmAccount = confirmation.mutate;
  /*
   * The confirmed answer is thrown away whenever an action changes the account underneath it.
   *
   * A mutation's `data` is not query state: invalidating the queries refetches the recorded row and
   * leaves this answer exactly where it was, and the effect above does not run again because none
   * of its dependencies changed. So a successful disconnect kept its dot, its word and its
   * Disconnect button, the person read that as a failure and pressed again, and the second DELETE
   * wrote a second `mcp.account_disconnected` entry about an account that was already gone.
   *
   * Cleared on connect for the same reason in the other direction. That path ends in a full page
   * navigation, so the held answer is usually thrown away with the document — but a navigation the
   * browser declines to make, or one somebody comes back from, would otherwise leave a "not
   * connected" answer from before the consent deciding a row about the account it granted.
   */
  const forgetConfirmation = confirmation.reset;
  useEffect(() => {
    if (!(brokered && configured)) return;
    confirmAccount(serverId);
  }, [brokered, configured, serverId, confirmAccount]);

  const connect = useMutation({
    ...connectAccountMutationOptions(returnTo),
    onError: (thrown: Error) => report(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be
     * shown to this person in their own browser; there is deliberately nothing here that could
     * complete it for them, and nothing about being an administrator changes that.
     */
    onSuccess: (authorizationUrl) => {
      forgetConfirmation();
      window.location.href = authorizationUrl;
    },
  });

  /*
   * The mutation's own `onSuccess` is called rather than replaced: it is what invalidates every
   * plugin query, and spreading these options and then declaring a second `onSuccess` would quietly
   * drop it, leaving the recorded row on screen as stale as the confirmed answer.
   */
  const disconnectOptions = disconnectBrokeredMutationOptions(queryClient);
  const disconnect = useMutation({
    ...disconnectOptions,
    onError: (thrown: Error) => report(thrown.message),
    onSuccess: (...args) => {
      forgetConfirmation();
      return disconnectOptions.onSuccess?.(...args);
    },
  });

  /*
   * The first press on an app nobody consents to: what does it want typed in?
   *
   * A question about the app rather than about anybody's account, which is why it writes nothing
   * and refetches nothing. Its answer is the mutation's own `data` and is not held anywhere else,
   * so leaving the screen forgets the form rather than leaving a half-filled one behind.
   */
  const fieldsRequest = useMutation({
    ...brokeredConnectionFieldsMutationOptions(),
    onError: (thrown: Error) => report(thrown.message),
  });

  /*
   * The second press, with the values on it. Its `onSuccess` is called rather than replaced, for
   * the reason the disconnect above gives: that is what refetches the recorded row.
   *
   * The confirmed answer is dropped here too. A row that connects this way arrived with a "not
   * connected" answer from the mount, and nothing about typing a key changes the dependencies of
   * the effect that asked — so without this the account would go on reading as not connected
   * however well the vendor accepted it.
   */
  const submitOptions = connectBrokeredWithFieldsMutationOptions(queryClient);
  const submission = useMutation({
    ...submitOptions,
    onError: (thrown: Error) => report(thrown.message),
    onSuccess: (...args) => {
      forgetConfirmation();
      return submitOptions.onSuccess?.(...args);
    },
  });

  return {
    /*
     * What the vendor last answered, and only our own record until it has answered anything. The
     * answer wins once there is one, in both directions — an account ended at Composio by somebody
     * else reads as not connected here too. A confirm still in flight, or one that could not be
     * made at all, leaves the recorded row standing rather than inventing either answer.
     */
    connected: confirmation.data?.connected ?? recorded,
    configured,
    connect: () => {
      report(null);
      connect.mutate(serverId);
    },
    connecting: connect.isPending,
    disconnect: () => {
      report(null);
      disconnect.mutate(serverId);
    },
    disconnecting: disconnect.isPending,
    kind: kindOf(authScheme),
    fields: fieldsRequest.data ?? null,
    requestFields: () => {
      report(null);
      fieldsRequest.mutate(serverId);
    },
    requestingFields: fieldsRequest.isPending,
    submitFields: (values: Record<string, string>) => {
      report(null);
      submission.mutate({ serverId, values });
    },
    submittingFields: submission.isPending,
  };
}

/**
 * The row itself, for a `PageRows` card on either screen.
 *
 * Just the `Item`: where it sits in the card, and whether a `Separator` precedes it, is the screen's
 * business and differs between the two.
 */
export function BrokeredAccountRow({
  account,
  connectedDescription,
  disconnectedDescription,
}: {
  account: BrokeredAccount;
  /** What being connected means on this screen, said beside the button rather than after it. */
  connectedDescription: string;
  /** What connecting would do, in the voice of whoever is reading. */
  disconnectedDescription: string;
}) {
  return (
    <Item size="sm">
      <ItemContent>
        {/* Not "Connect your account": the row is also the connected state, and a title has to read
            for both. */}
        <ItemTitle>Your account</ItemTitle>
        {/* Unclamped where the key is missing: that sentence is the only place the setting is named,
            so it is the point rather than a hint. */}
        <ItemDescription
          className={account.configured ? undefined : "line-clamp-none"}
        >
          {account.configured
            ? account.connected
              ? connectedDescription
              : disconnectedDescription
            : "Set COMPOSIO_API_KEY on this deployment. Without it there is no broker to reach, so this account can be neither connected nor ended from here. The app stays enabled and every grant on its tools still stands."}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {!account.configured ? (
          /*
           * A value and nothing to press, which is the layout's read-only row: the deployment has
           * no key, so Connect could only fail at the broker and Disconnect could only fail at it
           * twice. A button that cannot work is worse than no button — it invites the second press
           * that files a record of an act that did not happen.
           */
          <span className="text-muted-foreground text-xs">Key missing</span>
        ) : account.connected ? (
          <>
            {/* Decorative: the word beside it already says which. */}
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-emerald-500"
            />
            <span className="text-muted-foreground text-xs">Connected</span>
            <Button
              disabled={account.disconnecting}
              onClick={account.disconnect}
              size="sm"
              type="button"
              variant="outline"
            >
              Disconnect
            </Button>
          </>
        ) : (
          /* The arrow says this leaves OpenBot for the vendor's consent page. It does. */
          <Button
            disabled={account.connecting}
            onClick={account.connect}
            size="sm"
            type="button"
            variant="outline"
          >
            Connect
            <IconArrowUpRight />
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}
