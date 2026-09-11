import { IconPlug } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { enableComposioAppMutationOptions } from "@/lib/plugins/mutations";
import {
  type ComposioApp,
  composioAppsQueryOptions,
} from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";

/**
 * Composio's directory, searched rather than listed.
 *
 * The catalogue on the previous screen is a reviewed handful, and every entry there is a decision
 * somebody made about a vendor. This is a few hundred apps that nobody here has reviewed, which is
 * why it is a search field and not a list: the only sensible entry point into a directory that size
 * is the name of the app you already came looking for.
 *
 * Adding one is account-wide, and it still reads nothing. Every app here is reached as whoever is
 * asking, so a person's own connection is what makes their own mail or messages readable — which is
 * made on their settings page, not here.
 */
export const Route = createFileRoute("/_authed/admin/plugins/composio")({
  component: RouteComponent,
});

/**
 * The apps to draw, in the order to draw them.
 *
 * A function rather than a `.sort()` inside the map, so the two things a row is decided from — the
 * order, and the marker saying an app is already here — can be asserted without a DOM, a router and
 * a query client. See `tests/composio-picker.test.tsx`.
 *
 * A copy, because the array belongs to TanStack Query's cache and is the same object on every
 * render; sorting it in place would rewrite what the cache holds. By name rather than by the
 * vendor's own order, which is popularity — useful for a landing page, useless for finding the one
 * app somebody typed half the name of.
 */
export function matchingApps(apps: ComposioApp[]): ComposioApp[] {
  return [...apps].sort((left, right) => left.name.localeCompare(right.name));
}

function RouteComponent() {
  const [search, setSearch] = React.useState("");
  /*
   * Debounced, as on People, and for a stronger reason: every distinct term is a cache key of its
   * own and a request to the vendor, so typing a name un-debounced is a round trip per keystroke
   * against somebody else's rate limit.
   */
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const apps = useQuery(composioAppsQueryOptions(query));
  const enable = useMutation(enableComposioAppMutationOptions(queryClient));
  const listed = matchingApps(apps.data?.apps ?? []);

  return (
    <PageShell
      backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
      description="Composio's own directory. Adding an app makes its tools available to grant; each person still connects their own account before any of them reads anything."
      title="Browse Composio"
    >
      <PageSection
        description="Search by name. The directory is too long to read, and nothing here has been reviewed by this deployment."
        title="Apps"
      >
        {enable.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {enable.error.message}
          </p>
        ) : null}

        <Input
          aria-label="Search Composio apps"
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by app name"
          value={search}
        />

        {/* Pending, error, empty, rows — pending first, so no sentence asserts anything mid-fetch. */}
        {apps.isPending ? null : apps.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Composio's app directory could not be read.
          </p>
        ) : listed.length === 0 ? (
          <PageEmpty>
            {query
              ? `Nothing in Composio's directory matches "${query}".`
              : "Composio returned no apps."}
          </PageEmpty>
        ) : (
          <PageRows>
            {listed.map((entry, index) => {
              /*
               * One mutation serves every row, so the row being added is the one whose slug the
               * mutation is carrying. Without that, pressing Add on one app would put every other
               * row into Adding… at the same time.
               */
              const adding =
                enable.isPending && enable.variables?.slug === entry.slug;

              return (
                <React.Fragment key={entry.slug}>
                  <Item data-testid={`composio-${entry.slug}`} size="sm">
                    {/* The vendor's own mark where Composio supplies one, and a plug where it does
                        not, so a list of third parties still has a fixed left edge. */}
                    <ItemMedia variant={entry.logo ? "image" : "icon"}>
                      {entry.logo ? (
                        <img alt="" src={entry.logo} />
                      ) : (
                        <IconPlug />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{entry.name}</ItemTitle>
                      <ItemDescription>{entry.description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/* The size of the decision, stated before it is made: an app is not one
                          tool, and "167 actions" is what says so. */}
                      <span className="text-muted-foreground text-xs">
                        {entry.actionCount} actions
                      </span>
                      {/*
                       * An app this deployment already has says so rather than offering Add again.
                       * A second Add would ask the server to record a connector it already holds,
                       * and there is nothing on the row to suggest that would be harmless.
                       */}
                      {entry.enabled ? (
                        <span className="text-muted-foreground text-xs">
                          Added
                        </span>
                      ) : (
                        <Button
                          disabled={adding}
                          onClick={() => enable.mutate({ slug: entry.slug })}
                          size="sm"
                          variant="outline"
                        >
                          {adding ? "Adding…" : "Add"}
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                  {index !== listed.length - 1 && <Separator />}
                </React.Fragment>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
