import { IconArrowUpRight, IconChevronDown } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  confirmBrokeredConnectionMutationOptions,
  connectAccountMutationOptions,
  disconnectBrokeredMutationOptions,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One service, and whether a Bot may read it as you.
 *
 * Its own page rather than a switch on the list, because what a connector needs from a person is not
 * fixed. Drive needs one consent and nothing else; a vendor that scopes access per workspace, or per
 * folder, or asks which of several accounts to use, needs somewhere to ask. This is that somewhere,
 * before there is anything to put in it.
 */
export const Route = createFileRoute(
  "/_authed/settings/connected-accounts/$key",
)({ component: RouteComponent });

function RouteComponent() {
  const { key } = useParams({
    from: "/_authed/settings/connected-accounts/$key",
  });
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [notice, setNotice] = useState<string | null>(null);

  const connect = useMutation({
    ...connectAccountMutationOptions(),
    onError: (thrown: Error) => setNotice(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be shown
     * to you in your own browser; there is deliberately nothing here that could complete it for you.
     */
    onSuccess: (authorizationUrl) => {
      window.location.href = authorizationUrl;
    },
  });

  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const server = (plugins.data?.servers ?? []).find((s) => s.id === key);
  const enabled = server !== undefined;
  const connection = (connections.data?.connections ?? []).find(
    (row) => row.serverId === key,
  );
  /*
   * Asked of the row rather than the catalogue, because a brokered app has no catalogue entry at
   * all: the deployment recorded how it is reached when the app was enabled, and that record is the
   * only thing here that knows.
   */
  const brokered = server?.provenance === "composio";

  /*
   * Ask the vendor whether this brokered account is actually live, on arrival.
   *
   * The return trip from consent is an ordinary redirect with nothing signed in it, so being back
   * on this page proves nothing about what happened at the vendor. So the vendor is asked, and its
   * answer is what the row below is drawn from.
   *
   * Deliberately not wired into the banner. Somebody who abandoned the consent screen — or who has
   * simply never connected — has nothing at the vendor to confirm, and that is an ordinary state of
   * this page rather than a failure of it. It reads as not connected, which is what it is.
   */
  const confirmBrokered = useMutation(
    confirmBrokeredConnectionMutationOptions(queryClient),
  );
  const confirmBrokeredAccount = confirmBrokered.mutate;
  useEffect(() => {
    if (!brokered) return;
    confirmBrokeredAccount(key);
  }, [brokered, key, confirmBrokeredAccount]);
  const disconnectBrokered = useMutation({
    ...disconnectBrokeredMutationOptions(queryClient),
    onError: (thrown: Error) => setNotice(thrown.message),
  });

  if (plugins.isPending) {
    return <PageShell title="Account">{null}</PageShell>;
  }

  const back = {
    label: "Connected accounts",
    linkProps: { to: "/settings/connected-accounts" as const },
  };

  /*
   * A brokered app, before the catalogue is consulted at all.
   *
   * It has no catalogue entry, so the branch below would find no `entry`, decide the deployment has
   * no connector by that name, and say so under the raw id — about the one connector the list on the
   * way in demonstrably drew a row for. Falling through to the `user-oauth` branch instead is no
   * better: its title and summary are the catalogue's, and there is none.
   */
  if (brokered && server) {
    /*
     * What the vendor last answered, and only our own record until it has answered anything. The
     * answer wins once there is one, in both directions — an account ended at Composio by somebody
     * else reads as not connected here too. A confirm still in flight, or one that could not be
     * made at all, leaves whatever we recorded standing rather than inventing either answer.
     */
    const accountConnected =
      confirmBrokered.data?.connected ?? connection !== undefined;

    return (
      <PageShell
        backButton={back}
        description="Reached through Composio, which holds the account, so a Bot sees only what you can see."
        title={server.title}
      >
        {notice ? (
          <p className="text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : null}

        {/* One decision, so no heading: it would only repeat the row's own title. */}
        <PageSection>
          <PageRows className="mt-0">
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Your account</ItemTitle>
                <ItemDescription>
                  {accountConnected
                    ? /* Said beside the button rather than after it: disconnecting ends the account
                         at Composio, so what it undoes is not the row here but the grant on your own
                         mailbox, and connecting again is a fresh consent. */
                      `A Bot granted its tools reads your ${server.title} as you. Disconnecting ends the account at Composio, not just here.`
                    : "No Bot can read this as you. Connecting takes you to Composio and then to the vendor to consent."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {accountConnected ? (
                  <>
                    {/* Decorative: the word beside it already says which. */}
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-emerald-500"
                    />
                    <span className="text-muted-foreground text-xs">
                      Connected
                    </span>
                    <Button
                      disabled={disconnectBrokered.isPending}
                      onClick={() => {
                        setNotice(null);
                        disconnectBrokered.mutate(key);
                      }}
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
                    disabled={connect.isPending}
                    onClick={() => {
                      setNotice(null);
                      connect.mutate(key);
                    }}
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
          </PageRows>
        </PageSection>
      </PageShell>
    );
  }

  /*
   * A vendor that is not reached as a person has nothing here for anybody to decide, and one an
   * administrator has not enabled cannot be consented to — there is no OAuth client behind it. Both
   * say which it is rather than drawing a switch that cannot work.
   */
  if (entry?.auth !== "user-oauth") {
    return (
      <PageShell
        backButton={back}
        description="This is not a service you connect for yourself."
        title={entry?.title ?? key}
      >
        <PageEmpty>
          {entry
            ? "A Bot reaches this one with a credential the deployment holds, the same for everybody."
            : "This deployment has no connector by that name."}
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={back}
      description={entry.summary}
      title={entry.title}
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      {/* One decision, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          <Item size="sm">
            <ItemContent>
              {/* Not "Connect your account": the row is also the connected state, and a title has to
                  read for both. */}
              <ItemTitle>Your account</ItemTitle>
              <ItemDescription>
                {!enabled
                  ? "An administrator has not enabled this connector, so there is nothing to connect to yet."
                  : connection
                    ? "A Bot granted its tools reads this as you, and sees only what you can see."
                    : "No Bot can read this as you. Connecting takes you to the vendor to consent."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {connection ? (
                /*
                 * A state and a menu, not a switch. Connected is a fact about a grant that lives at
                 * the vendor, and withdrawing it is a deliberate act rather than the other half of a
                 * position — so it is named in a menu instead of being whatever happens when
                 * something slides back.
                 */
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="sm" type="button" variant="outline">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        Connected
                        <IconChevronDown />
                      </Button>
                    }
                  />
                  {/*
                   * `w-auto`, because the default is `w-(--anchor-width)` — the width of the trigger,
                   * which here is a small "Connected" button. Left alone, the one item inside wraps
                   * onto three lines and a destructive action becomes hard to read at the moment it
                   * most needs to be legible.
                   */}
                  <DropdownMenuContent align="end" className="w-auto">
                    <DropdownMenuItem
                      onClick={() =>
                        /*
                         * NOT BUILT YET, and it says so rather than appearing to work.
                         *
                         * Withdrawing is three acts — revoke at the vendor, revoke the vault
                         * credential, delete the row — and none exist. An item that closed the menu
                         * and changed nothing would report that access had been withdrawn when it
                         * had not, which is the one outcome worse than not offering it.
                         */
                        setNotice(
                          `Disconnecting is not built yet. Until it is, revoke it in your ${entry.vendor} account's third-party access settings — that stops this deployment reading anything immediately.`,
                        )
                      }
                      className="whitespace-nowrap"
                      variant="destructive"
                    >
                      Disconnect your {entry.title} account
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                /*
                 * The arrow says this leaves OpenBot. It does: the next thing on screen is the
                 * vendor's own consent page, and a control that navigates away should look like one.
                 */
                <Button
                  disabled={!enabled || connect.isPending}
                  onClick={() => {
                    setNotice(null);
                    connect.mutate(key);
                  }}
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
        </PageRows>
      </PageSection>

      {connection ? (
        <PageSection
          description="What you agreed to, as the vendor recorded it — not what was asked for. The two differ when a consent screen is only partly accepted."
          title="Access"
        >
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Granted</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.scope || "The vendor named no scope."}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Connected</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {new Date(connection.connectedAt).toLocaleString()}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
