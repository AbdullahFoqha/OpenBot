import { expect } from "bun:test";

/**
 * What a failure must never read like: the name of a method that was not there.
 *
 * A guard that is missing does not answer politely, it reads a field off `undefined` and hands an
 * administrator a sentence naming a vendor method. "IS NOT AN OBJECT" IS ANCHORED TO `undefined`
 * AND `null` rather than left bare, because the adapter's own sentence for a malformed input schema
 * says "a thing that is not an object cannot be shown as one" — the correct refusal, which a
 * pattern looking for a fragment of a crash would otherwise flag as one.
 */
export const A_CRASH =
  /is not a function|(?:undefined|null) is not an object|is not iterable|cannot read propert/i;

/** Any row of the listing each family of refusals is written over, for the sibling sweep below. */
const CONFIG_ROW = "row \\d+ of Composio's authorization configs for [a-z]+";
const ACCOUNT_ROW = "row \\d+ of its [a-z]+ accounts for this person";
const CATALOGUE_ROW = "row \\d+ of Composio's app catalogue";
const APP = "[a-z]+";

/**
 * The refusal sentences this deployment writes, named, so a test can say WHICH one it expects.
 *
 * A REFUSAL ASSERTED BY A SUBSTRING IS A REFUSAL ASSERTED BY ITS FAMILY. The sentences below are
 * written by neighbouring guards over neighbouring fields, so they share almost all of their words:
 * the config-id refusal contains "names", the config-name refusal contains "id", the account-id
 * refusal contains both, and `/id/` is inside "invalid", "considered" and "identifier". A test
 * asking `toMatch(/name/)` of one of them therefore passes on every other one — which was measured
 * rather than supposed. Swapping which field the two guards in `readableConfigs` read left the pair
 * of tests over them green, and replacing `authorize`'s redirect-shape sentence with the no-page
 * sentence verbatim left its test green.
 *
 * WHAT DISCRIMINATES IS THE POSITION THE VALUE WAS SENT IN, which is the phrase each of these
 * refusals is built on and the only part of one that a swap moves. Every entry below is therefore
 * anchored to that phrase rather than to a word out of the prose around it.
 *
 * EACH ENTRY IS A FUNCTION OF WHERE, so one name covers every row a guard can be reached over and a
 * caller can still pin the exact row it arranged. Called with no argument an entry matches any row,
 * which is what {@link expectOnlyRefusal} uses to assert the SIBLINGS are absent: a test that knows
 * which sentence it wants does not know which row a wrong sentence would have named.
 */
const TABLE = {
  /** `readableConfigs`, first guard: the field a deletion names did not arrive. */
  configId: (at: string = CONFIG_ROW) =>
    new RegExp(`where the id of ${at} belongs`),
  /** `readableConfigs`, second guard: the field saying whose config it is did not arrive. */
  configName: (at: string = CONFIG_ROW) =>
    new RegExp(`where the name of ${at} belongs`),
  /** `withdrawableAccounts`: the field a withdrawal names did not arrive. */
  accountId: (at: string = ACCOUNT_ROW) =>
    new RegExp(`where the id of ${at} belongs`),
  /** `checkedApp`: the only name this deployment has for an app did not arrive. */
  catalogueSlug: (at: string = CATALOGUE_ROW) =>
    new RegExp(`where the slug of ${at} belongs`),
  /** `checkedApp`: the title an administrator chooses by did not arrive. */
  catalogueName: (at: string = CATALOGUE_ROW) =>
    new RegExp(`where the name of ${at} belongs`),
  /** `checkedApp`: the value this deployment puts in an image address is not one. */
  catalogueLogo: (at: string = APP) => new RegExp(`where ${at}'s logo belongs`),
  /** `checkedApp`: the prose shown under an app is not text. */
  catalogueDescription: (at: string = APP) =>
    new RegExp(`where ${at}'s description belongs`),
  /** `checkedApp`: one of the words a person picks an app by is blank. */
  catalogueCategoryName: (at: string = `${APP}'s category \\d+`) =>
    new RegExp(`where the name of ${at} belongs`),
  /** `checkedApp`: the figure shown before anybody enables an app is not a number. */
  catalogueActionCount: (at: string = APP) =>
    new RegExp(`where ${at}'s action count belongs`),
  /** `authorize`: the vendor's link is present, truthy, and not a url. */
  redirectPage: (at: string = APP) =>
    new RegExp(`where the page to send this person to for ${at} belongs`),
  /** `authorize`: this deployment holds no config for the app at all. */
  noConfigRemedy: () =>
    /removing the app on its Plugins page and adding it again creates one/,
  /** `authorize`: a config of this deployment's exists and Composio calls it disabled. */
  disabledRemedy: () => /can enable it in Composio's dashboard/,
  /** `authorize`: the app is connected by entering a credential, so there is no page to visit. */
  noPageRemedy: () =>
    /connected by entering a credential rather than by visiting a page/,
  /** `authorize`: rows nothing could sort, told beside the two remedies above rather than instead. */
  unreadableAmongEnabled: () =>
    /reading those rows in Composio's own dashboard is what says whether there is one here to connect against at all/,
  /*
   * THE FOUR CALLERS OPEN THE UNREADABLE-LISTING REFUSAL IN THE SAME WORDS AND END IT IN THEIR OWN.
   * "Composio described N of its authorization configs for X in a way this deployment cannot read
   * and none of the rest is one it made" is written at four sites, so a pattern taken off that
   * clause names all four; what tells them apart is the act each one says did not happen, which is
   * the only part a caller can do anything about and the only part a copy-paste between them moves.
   */
  /** `deleteAuthConfig`: nothing was deleted and the app has not been withdrawn. */
  unreadableNothingRemoved: () =>
    /reading those rows in Composio's own dashboard is what says whether anything this deployment made is still standing/,
  /** `authorize`: nobody was sent anywhere. */
  unreadableNobodySent: () =>
    /nothing it can show is its own to connect an account against and nobody was sent anywhere/,
  /** `revoke`: nothing was withdrawn and their access has not been shown to end. */
  unreadableNothingWithdrawn: () =>
    /whether this person holds a grant on one of this deployment's own could not be told and nothing was withdrawn/,
  /** `connectWithFields`: what was typed into the form was not sent anywhere. */
  unreadableNothingSubmitted: () =>
    /nothing it can show is its own to connect an account against and what was typed into the form was not sent anywhere/,
  /** `connectionFields`: a box this deployment cannot draw, told by the type it arrived as. */
  fieldTypeNotDrawable: () =>
    /under the name (?!nothing)[^,]+, which cannot be filled in here/,
  /** `connectionFields`: a box whose answer could not be sent back, because it has no name. */
  fieldNameMissing: () =>
    /under the name nothing, which cannot be filled in here/,
};

export type RefusalName = keyof typeof TABLE;

export const REFUSALS: Record<RefusalName, (at?: string) => RegExp> = TABLE;

/**
 * Assert a reader was told THIS refusal and no sibling of it.
 *
 * `expectOnlyRefusal(said, "configName", "row 2 of …")` asserts that `said` carries the config-name
 * sentence about row 2, that it carries none of the other sentences in {@link REFUSALS}, and that
 * it is not a crash wearing a refusal's clothes. The middle one is the whole point: a test that
 * asserts only its own pattern stays green when two guards are swapped, because each guard's
 * sentence contains the other's words.
 *
 * `alongside` names the siblings that legitimately travel WITH this one — a refusal that counts a
 * set hangs every reason it met on `cause`, so one chain can honestly carry two of these. Naming
 * them is deliberate work: a sibling nobody named fails here rather than passing unnoticed, which
 * is what stops this helper decaying into the substring match it replaces.
 */
export function expectOnlyRefusal(
  said: string,
  name: RefusalName,
  at?: string,
  alongside: readonly RefusalName[] = [],
): void {
  expect(said).not.toMatch(A_CRASH);
  expect(said).toMatch(REFUSALS[name](at));
  for (const other of Object.keys(REFUSALS) as RefusalName[]) {
    if (other === name || alongside.includes(other)) continue;
    expect(said).not.toMatch(REFUSALS[other]());
  }
}
