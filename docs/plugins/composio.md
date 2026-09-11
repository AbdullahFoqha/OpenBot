# Composio

Composio is a broker. It holds people's accounts for a few hundred apps — Slack, Linear, Gmail,
HubSpot and the long tail behind them — and publishes each app's actions as tools this deployment
can call on somebody's behalf. There is no OAuth client to register, no secret to paste and no
redirect URI to match character for character, because the account does not live here: the person
consents to Composio, and Composio holds what comes back. A Bot with a brokered action granted
reaches the app **as the person asking**, the same as every other per-person connector here, so two
people asking the same question get the answers their own accounts can see.

Setting it up takes two people, and neither can do the other's half:

| Who              | Does                                              | Where                          |
| ---------------- | ------------------------------------------------- | ------------------------------ |
| An administrator | Sets one key, enables an app, grants its actions  | `/admin/plugins/composio`      |
| Each person      | Connects their own account to that app            | `/settings/connected-accounts` |

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

## The key

`COMPOSIO_API_KEY` is one key for the whole deployment, and it is optional. It is the only Composio
setting there is — nothing per app, nothing per person. One key does not mean one shared account:
Composio keeps people apart by a user id sent with every call, so one person's connections are never
reachable from another's.

Nothing validates the key at startup. There is no shape to check it against and no call worth making
at boot to find out, so the first real request is what says whether it works.

Unset is a supported, fully described state rather than a degraded one: it is what every deployment
is today. With no key, the only Composio surface anywhere in the product is one line where the app
directory would be, saying that adding a Composio key enables a catalogue of tools and naming
`COMPOSIO_API_KEY` as the setting to set. It names the setting rather than hiding the feature, so
somebody who has heard of Composio can find out what it wants. There is no directory to browse, no
picker, and no brokered app on anybody's connected-accounts page.

An app enabled while a key was set and then left without one keeps its row and its grants. Its page
says the key is missing, and its calls refuse with a sentence saying the same — distinguished, as
everywhere else here, from "the app advertises nothing".

## What an administrator does

### 1. Find the app, and read its action count

At `/admin/plugins/composio`, search Composio's directory. The whole directory is fetched in one
request and searched in this process rather than at the vendor, so what is on screen is the whole
listing and not a page of it.

Each row carries the app's **action count**, and that number is worth reading before pressing
**Add**. Slack publishes 167 actions, 73 of them reads — several times more than a model handles
well. There is no cap: grants remain the only ceiling, so a large app is possible and merely never
accidental.

### 2. Enable the app

**Add** takes the slug, which has to be one the directory itself answered with — a slug that arrived
from a caller and was written into a row's url would become the app every future call runs in.

**The authorization config is created here, not on somebody's first click, and it is created
first.** The SDK's own one-call shortcut would have made one on demand, at Composio's managed
defaults and under a name of its choosing, the first time any person pressed Connect. Creating it at
enable time, named for this deployment, makes it an object an operator can see in their Composio
dashboard from the moment the app exists — and tighten there, without a code change. It comes before
anything is written here, so a failure leaves no row behind and pressing the button again is the
whole recovery.

Connecting an account is then a link minted **against that config**, which is why nothing mints a
config later: an app whose config was deleted at the dashboard refuses at Connect, naming the
administrator's step, rather than quietly acquiring a second one that nobody here named or can find.

Then one ordinary `mcp_servers` row — id `composio-<slug>`, url `composio://<slug>`, provenance
`composio`, vendor Composio, title from the directory, and no credential of any kind — and then the
app's actions, recorded with each one's effect, destructive marker and version, so a bad key is
reported to the administrator who just pressed the button rather than the first time a Bot calls
something. The audit row is the existing `configuration.changed` / `mcp_server_added`, marked
`provenance: "composio"`.

Nothing arrives switched on. Enabling an app names no Bot, and a switch drawn in the on position for
a grant nobody made is the one thing this codebase is most consistently careful about.

### 3. Grant actions to a Bot

Enabling the app gives no Bot access to it. From the app's page at `/admin/plugins/composio-<slug>`,
open one Bot to get a screen listing every action with a switch each — searchable, split into reads
and writes, with *turn on every read-only action* as the one bulk action, which says how many tools
that Bot will then carry before it does it. Every call then checks the grant, evaluates the action
policy, and writes an audit row.

A destructive action renders as danger. Nothing renders as reassurance: an action that does not
claim to be destructive is not claiming to be safe, so the absence of the marker is drawn plain,
never as green.

## What each person does

At `/settings/connected-accounts`, a brokered app appears beside the OAuth connectors once an
administrator has enabled it. Open it and press **Connect**. That leaves OpenBot for Composio's
consent screen and returns to the same page — or, for an administrator who started from the app's
own page under `/admin/plugins`, back to that page, because leaving a page mid-task and being
returned to a different one is the round trip this exists to remove.

**The address they come back to is built here, and a caller has no say in it.** It is this
deployment's `OPENBOT_APP_URL` plus one of two known pages, so what a request can choose is which
page and never which site: an address taken from a body or a query would be an open redirect with a
consent screen in front of it, which is the same reason this deployment's own OAuth flow narrows its
`returnTo` to a name. A deployment with no app URL configured has no absolute address to hand over
— the consent screen is on Composio's origin, so a relative one resolves against theirs — and
**Connect** refuses there, naming the setting, rather than minting a link that would strand somebody
on Composio's page having just granted access to their mailbox.

**The link is yours alone.** It is minted for the session's own id and can be asked for on nobody
else's behalf. It is a bearer capability — whoever opens it binds *their* account to the id it was
minted for — so it is handed to the browser that asked and is never stored, logged, audited, or put
anywhere a second person could read it. Do not forward it.

Coming back does not by itself grant anything. The return trip is an ordinary redirect with nothing
signed in it, so the row that lets calls through is written only after Composio confirms the account
is live. The page asks on return, and asks again on load, so a row that drifted heals. Composio is
the source of truth and the row here is a cache of it.

**A failure at Composio arrives as Composio's own sentence.** A wrong key, a revoked one, an app
whose authorization config was deleted at the dashboard: each of those comes back as the one
sentence the vendor wrote — *Invalid API key provided.* — with everything that travelled beside it
left where it was. The key never appears anywhere, nor the connect link, nor the vendor's thrown
object, which is an entire HTTP response including headers and trace ids. Where the vendor reported
a failure and said nothing about it, the sentence is this deployment's own and names the step to
take rather than echoing a placeholder.

**One account per person per app, and the second is refused.** Composio would happily hold several
accounts for one person and one app, but the call that runs an action names the person and not the
account — so with two Gmail accounts connected, which mailbox a Bot reads would be Composio's
choice, and neither the table here nor the audit row could say which one it was. Connect therefore
refuses while a live connection for that app already exists, and names the way to switch: *You
already have an account connected to Slack. Disconnect it first if you want to connect a different
one.* The app's own title, never the row's id. It is per app and nothing more — Gmail and Linear and Notion connected alongside each other are untouched.

### Disconnecting

**Disconnect**, on the same page, revokes at Composio first and deletes the row second. The account
ends at Composio, not just here. Revoke-then-delete is the ordering everywhere in this connector, so
a failure between the two leaves access dead rather than live and unreachable; pressing Disconnect
again is the whole recovery. Audited as `mcp.account_disconnected`.

## The two paths that end somebody else's access

Both of these used to stop at this deployment's own tables, which was the only thing they could do
while there was nothing to revoke with. Both now reach the broker.

**Removing the app** revokes every person's connection to it at Composio, clears the rows, and then
deletes the authorization config that enabling created. Re-adding the app afterwards starts empty
rather than silently restoring everybody who had connected before.

**Removing the person** revokes each of their brokered connections at Composio before clearing the
rows, and reports what was revoked. The `composio_connections` table is keyed on
`(toolkit, user_id)` and outlives the user record for exactly this reason — so offboarding can still
find the connection after the person is gone.

## What the grants narrow, and what they do not

The authorization config keeps Composio's default scopes. Narrowing them properly would mean
choosing scopes before anybody has been granted anything, which is backwards, so it is not done
pre-emptively. Stated plainly, and stated in these words on the app's own page:

> **The vendor-side grant is as wide as Composio's own app asks for, and this deployment's grants
> are the entire narrowing.**

This is the position Notion is already in. What keeps a Bot's reach small is which actions are
switched on for it, and nothing at the vendor stands behind that.

## Blast radius

One vendor ends up holding every person's connection to every app — which is the deal any broker
offers, and should be chosen rather than discovered.

## Not built yet

**No approval step before a destructive action.** The destructive marker is recorded and now
visible, but it gates nothing: a Bot granted a destructive action performs it without anybody being
asked. That is the same position every other connector is in — but it is now a position reachable
through the UI rather than only through a database insert, which is a real change in exposure.

**No way to give a Bot a whole large app to search.** A Bot carries the actions somebody switched on
for it, one at a time. There is no search-and-run path for an app too large to tick through, which
is why an app's action count is worth reading before it is enabled rather than afterwards.

## See also

- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `COMPOSIO_API_KEY`, and that it is optional.
- [Notion](notion.md) and [Google Drive](google-drive.md) — the same per-person shape, with the
  OAuth client registered here instead of held by a broker.
