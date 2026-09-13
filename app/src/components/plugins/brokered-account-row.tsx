import { IconArrowUpRight } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ConnectionFields } from "@/components/plugins/connection-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  recheckBrokeredConnectionMutationOptions,
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
   * Whether this deployment holds a verdict that the account works, which is a different fact for
   * each kind and is NOT "a real call was made with this key".
   *
   * A different fact from `connected`, and the reason both are here. Composio does not check a
   * submitted key: a connection created with an obviously wrong value comes back ACTIVE and stays
   * ACTIVE, so `connected` for a key app is only that the vendor accepted the row.
   *
   * ON A CONSENT APP THERE IS NO PROBE BEHIND THIS. The confirm writes it true off the vendor's own
   * answer that the account is attached — a consent screen somebody completed is the check — and
   * migration 0030 backfilled every consent row that came before. So nothing here may read `true`
   * as evidence that a call was spent, nor offer an act that needs one.
   *
   * AND `false` IS A PLACEHOLDER AS MUCH AS A VERDICT. The store writes it unconditionally on every
   * key connection, whether or not the app publishes anything to check a key against, so nothing
   * here may explain the `false` off this field. Three states share this one word — nothing to try,
   * tried and passed, tried and refused — and {@link BrokeredAccount.probe} is what tells them
   * apart. Read the two together or not at all.
   */
  verified: boolean;
  /**
   * When that call was made, as the recorded instant. Null where none ever has been.
   *
   * Carried beside `verified` rather than derived from it, because a verification is a past tense
   * and a screen that says so has to say when: "verified" on its own reads as a present-tense fact
   * about a key that may have been revoked at the vendor an hour ago.
   */
  verifiedAt: string | null;
  /**
   * The action that check was spent on, as the last answer named it.
   *
   * THE THREE STATES BEHIND `verified` ARE THIS FIELD'S DOING, and the sentences below are written
   * off it rather than off the flag:
   *
   *   `null`      — the answer said this app publishes nothing safe to spend a key on. Nothing was
   *                 tried and nothing can be, which is a fact about the app and not about the key.
   *   a name, verified — the action ran in this person's account and the vendor took the key.
   *   a name, NOT verified — it ran and the vendor refused the key, and the account it ran in is
   *                 still there: a connect leaves it because its withdrawal failed, a re-check
   *                 because it never withdraws one. The row exists, the key is bad, and something
   *                 of theirs is standing at Composio. This is the worst state the feature has.
   *   `undefined` — NOT A FOURTH VERDICT BUT THE ABSENCE OF ONE. Nothing has said anything about a
   *                 probe for this row: a held connection, whose rows carry none of this, or an app
   *                 nobody has connected. Nothing may read it as either of the two the server sends.
   *
   * CARRIED BY THE READ AS WELL AS BY THE ANSWERS, which is what keeps the three states apart after
   * a reload. A re-check and a key handed over both come back naming the action, and neither writes
   * the name down — so while this came only from an answer, a refresh collapsed the third state
   * into the first and told the one person with a refused key that nothing had been tried. The
   * connections read derives it instead, from the app's recorded actions and without asking the
   * vendor anything, and the freshest answer still wins over it.
   */
  probe: string | null | undefined;
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
   * Whether a disconnect from this screen landed, as opposed to an account that was never made.
   *
   * Both read as not connected and they are not the same sentence. For an app whose secret somebody
   * typed, what disconnecting did NOT do is the part worth saying — the key is still live at the
   * vendor — and there is nobody to say it to until they have actually pressed the button.
   */
  disconnected: boolean;
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
  /**
   * Why the last attempt to hand over what somebody typed was refused, or null.
   *
   * Carried out of the hook as well as reported to the screen's banner, because the form is a
   * modal. The banner is behind its backdrop, so Composio's own sentence — the one this path spends
   * a dropped `cause` to preserve — arrived where the person could not read it, over a form still
   * holding the key it was about.
   */
  submissionError: string | null;
  /** Spend one read-only call at the vendor to find out whether the key still works. */
  recheck: () => void;
  rechecking: boolean;
};

export function useBrokeredAccount(input: {
  serverId: string;
  /** Whether this row is about a brokered app at all. Asked of the recorded row by the caller. */
  brokered: boolean;
  /** See {@link BrokeredAccount.configured}. */
  configured: boolean;
  /** What this deployment recorded, which is what stands until the vendor has answered anything. */
  recorded: boolean;
  /** See {@link BrokeredAccount.verified}, as this deployment last wrote it down. */
  verified: boolean;
  /** See {@link BrokeredAccount.verifiedAt}, as this deployment last wrote it down. */
  verifiedAt: string | null;
  /**
   * Which action a check of this key WOULD be spent on, as the connections read derived it.
   *
   * The read's answer and not an answer to anything pressed here, which is exactly what makes it
   * worth passing: it is all the row has on a page that has only loaded. Undefined where the
   * recorded row carries no such field — a held connection, or an app nobody has connected — and
   * null where the app publishes nothing safe to spend a key on. See {@link BrokeredAccount.probe}
   * for what each of those means to the sentence the row draws.
   */
  probe: string | null | undefined;
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
    probe,
    report,
    returnTo,
    serverId,
    verified,
    verifiedAt,
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

  /*
   * Find out whether the key still works, when somebody presses for it and at no other time.
   *
   * Deliberately not a second effect beside the confirm above. Composio never re-checks a key once
   * it has taken it, so the only way to learn whether one works is to spend a real read-only call at
   * the vendor with it — and a verify-on-render would spend the person's own rate limit there, on
   * every mount of every screen that draws this row, to redraw a word that was already written down.
   * So the row says when it last checked, and the person decides when to check again.
   */
  const recheck = useMutation({
    ...recheckBrokeredConnectionMutationOptions(queryClient),
    onError: (thrown: Error) => report(thrown.message),
  });
  /*
   * The check's answer is thrown away whenever an action changes the account it was about.
   *
   * THE SAME DEFECT `forgetConfirmation` ABOVE EXISTS FOR, in the same shape and for the same
   * reason: a mutation's `data` is not query state, so invalidating the queries refetches the
   * recorded row and leaves this verdict exactly where it was. Disconnecting would leave the row
   * saying a key was "last checked" an hour ago about an account that no longer exists, and
   * connecting a fresh key would inherit the old key's verdict — a row reading "last checked"
   * about a value nothing has ever tried.
   *
   * RESET RATHER THAN A GUARD AT THE DRAWING. Hiding it behind `connected` in the render would fix
   * the disconnect and not the reconnect, and would leave the hook handing `verified: true` to any
   * other reader — the honest thing is for the answer to stop existing when the thing it answered
   * about does.
   */
  const forgetRecheck = recheck.reset;

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
      forgetRecheck();
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
      forgetRecheck();
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
      forgetRecheck();
      return submitOptions.onSuccess?.(...args);
    },
  });

  /*
   * The freshest thing either check has said about this key, or nothing at all.
   *
   * Two answers name a probe — a re-check, and a key just handed over — and the newer of the two
   * wins for the reason `verified` below gives: an answer beats the record, and these two cannot
   * both be new. A submission clears the re-check's answer as it lands, and opening the form clears
   * the submission's, so whichever is present is the one that was actually last said.
   */
  const answered = recheck.data ?? submission.data;

  return {
    /*
     * What the vendor last answered, and only our own record until it has answered anything. The
     * answer wins once there is one, in both directions — an account ended at Composio by somebody
     * else reads as not connected here too. A confirm still in flight, or one that could not be
     * made at all, leaves the recorded row standing rather than inventing either answer.
     */
    connected: confirmation.data?.connected ?? recorded,
    /*
     * What the last re-check found, and only our own record until one has been made here — the same
     * rule `connected` follows above: the answer wins once there is one.
     *
     * Both read off the one `recheck.data` rather than each falling back on its own, because
     * `verifiedAt` is legitimately null in a fresh answer — a check that came back not verified
     * records no time — and a `??` on it would pair that answer with the time of the check before,
     * leaving the row saying a key failed as of an hour before it was asked.
     */
    verified: recheck.data ? recheck.data.verified : verified,
    verifiedAt: recheck.data ? recheck.data.verifiedAt : verifiedAt,
    /*
     * The name off whichever answer is newest, and THE READ'S OWN ANSWER UNTIL THERE IS ONE — the
     * same rule `connected` and `verified` follow above, and for the same reason: an answer beats
     * the record, and a just-finished re-check must not be overruled by a read taken before it.
     *
     * WHAT IS PASSED IN IS NOT A GUESS THIS DEPLOYMENT IS MAKING. The connections read derives the
     * name from the app's recorded actions — which action a check WOULD be spent on — so its null
     * is the server saying there is nothing to spend one on, exactly as an answer's null is. That
     * is why it is passed straight through rather than flattened to undefined: undefined is the
     * absence of any answer at all, and it is what remains for a row whose read carried no such
     * field. See {@link BrokeredAccount.probe}.
     */
    probe: answered ? answered.probe : probe,
    recheck: () => {
      report(null);
      recheck.mutate(serverId);
    },
    rechecking: recheck.isPending,
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
    /*
     * A disconnect this person made, rather than an account that was never there. Held by the
     * mutation because that is where the fact is: the recorded row says only that there is nothing,
     * which is equally true of an app nobody ever connected.
     */
    disconnected: disconnect.isSuccess,
    kind: kindOf(authScheme),
    fields: fieldsRequest.data ?? null,
    requestFields: () => {
      report(null);
      /*
       * A fresh attempt, so the last one's refusal goes with it. This press is also what opens the
       * form, and a mutation's error outlives the dialog that showed it: without this, reopening
       * would present the sentence the previous key was refused with, above an empty field.
       */
      submission.reset();
      fieldsRequest.mutate(serverId);
    },
    requestingFields: fieldsRequest.isPending,
    submitFields: (values: Record<string, string>) => {
      report(null);
      submission.mutate({ serverId, values });
    },
    submittingFields: submission.isPending,
    submissionError: submission.error?.message ?? null,
  };
}

/**
 * The day a check was made, in the reader's own locale.
 *
 * A day rather than "2 hours ago": the point of the sentence is that the check is a past tense that
 * keeps receding, and a relative phrase recomputed on every render reads as a fact about now.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * The line beneath the word, which is where the three kinds actually differ.
 *
 * THEY DO NOT DIFFER IN THE WORD. A consent screen and a key somebody typed both end in a live
 * account, and "Connected" is true of both; a second word for the second kind would invite a
 * distinction there is no fact behind. What differs is what that connection rests on, and how much
 * this deployment can honestly claim to know about it — which is a sentence, not a label.
 *
 * COMPOSIO NEVER RE-CHECKS A SUBMITTED KEY. It answers ACTIVE forever, so a key revoked at the
 * vendor last week still reads as connected here. The verification makes exactly one moment true,
 * so the row names that moment instead of asserting a present tense it does not hold.
 */
function accountSentence(input: {
  account: BrokeredAccount;
  /** The app's own name, as the screen drawing this row knows it. */
  title: string;
  connectedDescription: string;
  disconnectedDescription: string;
  disconnectedReassurance: string | undefined;
}): string {
  const {
    account,
    connectedDescription,
    disconnectedDescription,
    disconnectedReassurance,
    title,
  } = input;

  if (!account.configured) {
    return "Set COMPOSIO_API_KEY on this deployment. Without it there is no broker to reach, so this account can be neither connected nor ended from here. The app stays enabled and every grant on its tools still stands.";
  }

  if (account.kind === "no-auth") {
    /*
     * Neither screen's own sentence fits: both are about an account, and there is none to have.
     * Capitalised because this is the one position the name opens a sentence in.
     */
    return `${title.charAt(0).toUpperCase()}${title.slice(1)} needs no account. A Bot granted these tools can use it as it is.`;
  }

  if (account.kind === "fields") {
    if (account.connected) {
      if (account.verified && account.verifiedAt) {
        return `Connected with a key you provided, last checked ${formatDate(account.verifiedAt)}.`;
      }
      /*
       * THE KEY WAS CHECKED AND THE VENDOR REFUSED IT, and the account it was checked in is still
       * there — the one state where the sentence below was not vague but FALSE. Three facts are
       * this person's to act on and all three go in: their key is bad, an account of theirs is live
       * at Composio, and the row says which button ends which.
       *
       * WHY THE ACCOUNT STANDS IS NOT ASSERTED, because two paths reach this state and they stand
       * for different reasons. A connect whose probe failed tried to withdraw the account it had
       * just made and could not; a re-check that failed never tried, deliberately, because the
       * account predates the press and is the person's own. Naming a failed withdrawal would be
       * false on the second path, and the standing account is the actionable half either way.
       *
       * BOTH WAYS OUT ARE NAMED, because neither is obvious from a row that says "Connected": the
       * account ends with the button beside this line, and a key corrected at the vendor is worth a
       * second check rather than a second connection.
       */
      if (account.probe && !account.verified) {
        return `Your key was checked against ${title} and rejected, and the account it was checked in still stands at Composio, so disconnect it here, or fix the key at ${title} and press Re-check.`;
      }
      /*
       * NOTHING TO CHECK IT WITH, WHICH IS A FACT ABOUT THE APP. The answer named no probe at all:
       * this app publishes no action safe to spend somebody's key on, so the check was not skipped
       * and cannot be made. Said plainly because the alternative reading — that this deployment
       * doubts the key — is the one a person supplies for themselves when a row goes quiet.
       */
      if (account.probe === null) {
        return `Connected with a key you provided. It was accepted without being checked against ${title}, which publishes nothing safe to try a key on — that is about the app, not about your key.`;
      }
      /*
       * AND NOTHING HAS SAID WHICH, which is no longer the page load: the connections read derives
       * the probe now, so a reload lands on one of the two sentences above. What is left here is a
       * row nothing has told about a probe either way — a held connection, whose rows carry none of
       * this, or an answer that named none — and all it knows is that the key was taken. Those two
       * sentences are the two things a verdict can say; this is what stands where there is no
       * verdict, and it must not borrow either.
       */
      return `Connected with a key you provided. It was accepted without being checked against ${title}.`;
    }
    /*
     * WHAT DISCONNECTING DID NOT DO. The account ends at Composio and the key does not end
     * anywhere: it is still valid at the vendor and still works for anyone holding it. Saying
     * "disconnected" and stopping would leave somebody believing they had ended access they still
     * have live, so the row names the step this deployment cannot take for them.
     */
    if (account.disconnected) {
      return `Removed from Composio. Your key still works at ${title} — rotate it there if you meant to end its access.`;
    }
    /*
     * NOT THE SCREEN'S OWN SENTENCE, which is written for the kind that leaves: one of the two says
     * connecting takes you to Composio and then to the vendor to consent, and pressing Connect here
     * opens a form and asks for a secret instead. A sentence that promises a trip nobody is about to
     * take is a worse preparation for the dialog than no sentence at all.
     *
     * THE SCREEN'S REASSURANCE IS KEPT THOUGH ITS SENTENCE IS NOT. What an administrator needs to
     * read here — that finishing the connector does not wait on them connecting — is true whichever
     * way this app is connected, and a row that replaced the whole line took it away with the trip
     * it was right to drop.
     */
    const asked = `This app is connected with a key you already hold, not a trip to ${title}'s consent screen. Connect asks for it.`;
    return disconnectedReassurance
      ? `${asked} ${disconnectedReassurance}`
      : asked;
  }

  /*
   * A consent app keeps the screen's own sentence, prefixed by what the connection rests on. What
   * differs between an administrator checking their setup and a person checking who reads their
   * mail is an argument, not a branch — see this file's opening comment.
   */
  return account.connected
    ? `Connected through ${title}'s consent screen. ${connectedDescription}`
    : disconnectedDescription;
}

/**
 * The row itself, for a `PageRows` card on either screen.
 *
 * The `Item` and, for an app whose secret a person types, the dialog that takes it. Where the row
 * sits in the card, and whether a `Separator` precedes it, is the screen's business and differs
 * between the two; the dialog is portalled to the body and so sits nowhere at all.
 */
export function BrokeredAccountRow({
  account,
  connectedDescription,
  disconnectedDescription,
  disconnectedReassurance,
  title,
}: {
  account: BrokeredAccount;
  /** What being connected means on this screen, said beside the button rather than after it. */
  connectedDescription: string;
  /** What connecting would do, in the voice of whoever is reading. */
  disconnectedDescription: string;
  /**
   * What stays true whether or not this person ever connects, in that same voice.
   *
   * Separate from `disconnectedDescription` because only part of a screen's line survives the kind
   * that does not leave: the half describing the trip to a consent screen is wrong for an app whose
   * key somebody types, and the half telling an administrator their setup is already complete is
   * right for both. A screen with nothing of the second kind to say passes nothing.
   */
  disconnectedReassurance?: string;
  /**
   * The app's own name, for the sentences that name it.
   *
   * Required, because the sentences it appears in are the ones whose whole job is to name a place:
   * where a key still works after a disconnect, whose consent screen a connection rests on, which
   * app needs no account at all. "Your key still works at the app" tells somebody nothing they can
   * act on, so a screen that cannot name the app has no business drawing this row.
   */
  title: string;
}) {
  /*
   * Whether the form is on screen, which is the whole of what this row holds.
   *
   * An app nobody consents to is connected by typing a key rather than by leaving for a consent
   * screen, and the layout's answer to more than one value is a dialog rather than fields wedged
   * into the row. What goes in those fields is asked for when this opens and is held by the form
   * itself — see `connection-fields.tsx` — so closing this forgets it.
   */
  const [asking, setAsking] = useState(false);

  /*
   * A connection that landed takes its own form off the screen.
   *
   * The row behind redraws as connected on the refetch either way; without this the person is left
   * reading the form they just submitted, over a row that says it worked.
   */
  useEffect(() => {
    if (account.connected) setAsking(false);
  }, [account.connected]);

  return (
    <>
      <Item size="sm">
        <ItemContent>
          {/* Not "Connect your account": the row is also the connected state, and a title has to
              read for both. */}
          <ItemTitle>Your account</ItemTitle>
          {/* Unclamped where the key is missing: that sentence is the only place the setting is
              named, so it is the point rather than a hint. */}
          <ItemDescription
            className={account.configured ? undefined : "line-clamp-none"}
          >
            {accountSentence({
              account,
              connectedDescription,
              disconnectedDescription,
              disconnectedReassurance,
              title,
            })}
          </ItemDescription>
        </ItemContent>
        {/*
         * AN APP THAT NEEDS NO ACCOUNT HAS NOTHING HERE AT ALL — no Connect, and not a disabled one
         * either. There is no account to make and none to end, so a button would offer an act with
         * no effect and a greyed one would announce a step somebody is missing when they are not.
         * The sentence above already says the app works as it is.
         *
         * Still drawn where the key is missing, because then nothing works, this app included.
         */}
        {account.configured && account.kind === "no-auth" ? null : (
          <ItemActions>
            {!account.configured ? (
              /*
               * A value and nothing to press, which is the layout's read-only row: the deployment
               * has no key, so Connect could only fail at the broker and Disconnect could only fail
               * at it twice. A button that cannot work is worse than no button — it invites the
               * second press that files a record of an act that did not happen.
               */
              <span className="text-muted-foreground text-xs">Key missing</span>
            ) : account.connected ? (
              <>
                {/* Decorative: the word beside it already says which. */}
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-emerald-500"
                />
                {/* The same word for both kinds. The line beneath says what it rests on. */}
                <span className="text-muted-foreground text-xs">Connected</span>
                {/*
                 * OFFERED ONLY ON A KEY APP, BECAUSE THAT IS THE ONLY KIND A RE-CHECK IS AN ACT ON.
                 * A consent connection is written verified by the confirm, with no probe behind it,
                 * and migration 0030 backfilled every consent row that came before — see
                 * {@link BrokeredAccount.verified} — so a gate that asked only about a check would
                 * draw Re-check on every connected Gmail a deployment already had, where pressing it
                 * could only fail.
                 *
                 * AND THE SECOND HALF ASKS WHETHER THERE IS ANYTHING TO CHECK WITH, WHICH IS NOT
                 * "HAS A CHECK PASSED". Gating on `verified` withheld the button in the one state
                 * somebody reaches for it hardest: a key the vendor has just rejected, which they
                 * have gone and corrected and now want tried again. A null probe is the only state
                 * with nothing to press — the app publishes nothing to spend the key on, so the
                 * button could only ask for the same answer again.
                 */}
                {account.kind === "fields" && account.probe !== null ? (
                  <Button
                    disabled={account.rechecking}
                    onClick={account.recheck}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {account.rechecking ? "Checking…" : "Re-check"}
                  </Button>
                ) : null}
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
                onClick={() => {
                  /*
                   * A key app goes nowhere: it opens the form below and asks the app what belongs in
                   * it. The question is asked on every open rather than once, because what an app
                   * publishes is the vendor's and may differ from what it published last time.
                   */
                  if (account.kind === "fields") {
                    setAsking(true);
                    account.requestFields();
                    return;
                  }
                  account.connect();
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
        )}
      </Item>

      <Dialog onOpenChange={setAsking} open={asking}>
        <DialogContent>
          <DialogHeader>
            {/* The title the row above cannot have: this exists only while the account is not
                connected, so it is free to name the act rather than the subject. */}
            <DialogTitle>Connect your account</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4">
            {account.fields ? (
              <ConnectionFields
                busy={account.submittingFields}
                fields={account.fields}
                onSubmit={account.submitFields}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                {account.requestingFields
                  ? "Asking the app what it needs…"
                  : "That app could not be asked what it needs. Close this and try again."}
              </p>
            )}
            {/*
             * THE REFUSAL WHERE THE PERSON IS LOOKING. It reaches the screen's banner too, and that
             * banner is behind this dialog's own backdrop: a key Composio would not take said so in
             * the vendor's words, at the top of a page nobody could see, while the form sat open as
             * though nothing had been answered.
             *
             * Under the form rather than over it, beside the button that was just pressed, and the
             * form stays up holding what was typed — a key is corrected, not retyped.
             */}
            {account.submissionError ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {account.submissionError}
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
