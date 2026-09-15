import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STUDIO_POLICY,
  ENFORCED_POLICY_FIELDS,
  loadStudioPolicy,
  parseStudioPolicy,
} from "../src/studio/policy";

/**
 * Reading the studio's rules from a file nobody validated before.
 *
 * `studio-policy.json` arrives as a specification — its own `kind` field says it is not an upstream
 * setting, and its `rulesEnforcedBy` field names the code that would have to exist. The risk in
 * turning it into configuration is not that somebody writes an invalid file; it is that an invalid
 * file quietly becomes the defaults and the deployment reports that it is enforcing what the file
 * says. So every test here is about a wrong value being REFUSED rather than tidied.
 */

describe("reading a policy", () => {
  test("no file at all is the shipped defaults, said out loud", async () => {
    const outcome = await loadStudioPolicy(undefined);
    expect(outcome).toEqual({
      ok: true,
      policy: DEFAULT_STUDIO_POLICY,
      source: "defaults",
    });
  });

  test("a partial file keeps the defaults for what it does not mention", () => {
    const outcome = parseStudioPolicy({ maxActiveExecutionTasks: 2 });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.policy).toEqual({
      ...DEFAULT_STUDIO_POLICY,
      maxActiveExecutionTasks: 2,
    });
  });

  test("a value of the wrong type is refused, not read as a default", () => {
    // The failure worth preventing: `"three"` silently becoming 3 means a cap nobody chose, reported
    // as the cap in the file.
    for (const bad of [
      { maxActiveExecutionTasks: "three" },
      { maxActiveExecutionTasks: 2.5 },
      { maxActiveExecutionTasks: -1 },
      { paidFallbackAllowed: "no" },
      { recurringSchedulesEnabled: 1 },
    ]) {
      const outcome = parseStudioPolicy(bad);
      expect(outcome.ok).toBe(false);
    }
  });

  test("every problem is reported at once rather than one run at a time", () => {
    const outcome = parseStudioPolicy({
      maxActiveExecutionTasks: "three",
      maxDelegationDepth: -4,
      automaticMerge: "yes",
    });
    expect(outcome.ok).toBe(false);
    expect(
      outcome.ok === false && outcome.problems.map((p) => p.field),
    ).toEqual([
      "maxActiveExecutionTasks",
      "maxDelegationDepth",
      "automaticMerge",
    ]);
  });

  test("a cap of zero is refused, because it is a broken deployment rather than a bounded one", () => {
    expect(parseStudioPolicy({ maxActiveExecutionTasks: 0 }).ok).toBe(false);
    expect(parseStudioPolicy({ maxPrimaryExecutionTasksPerBot: 0 }).ok).toBe(
      false,
    );
  });

  test("something that is not an object at all is refused", () => {
    for (const bad of [null, [], "policy", 42]) {
      expect(parseStudioPolicy(bad).ok).toBe(false);
    }
  });

  test("an unreadable file names the path and not its contents", async () => {
    const outcome = await loadStudioPolicy(
      "/etc/studio-policy.json",
      async () => "{ not json",
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.problems[0]?.reason).toContain(
      "/etc/studio-policy.json",
    );
    // A policy file sits beside configuration. Echoing its body into an error is a good way to
    // print something that should not be printed.
    expect(outcome.ok === false && outcome.problems[0]?.reason).not.toContain(
      "not json",
    );
  });

  test("the kit's own shipped policy is accepted unchanged", async () => {
    /*
     * The values in `studio-policy.json` as prepared, byte for byte. If the shipped specification
     * ever stopped parsing, the deployment reading it would be a deployment enforcing something
     * else — so the specification is a fixture here rather than a comment.
     */
    const shipped = {
      schemaVersion: 1,
      kind: "proposed-fork-policy-not-an-upstream-openbot-setting",
      activeProductId: null,
      maxActiveProducts: 1,
      maxActiveExecutionTasks: 3,
      maxPrimaryExecutionTasksPerBot: 1,
      maxDelegationDepth: 2,
      maxHandoffsPerRun: 3,
      waitingParentKeepsReservationUnlessCheckpointedAndSuspended: true,
      countChildTasksAndReviews: true,
      temporaryWorkersAreLeaves: true,
      sameFailureAttemptsBeforeReassessment: 2,
      initialPilotWallClockMinutes: 45,
      initialPilotMaxAgentTurns: 12,
      apiSpendingAuthorization: "existing-explicit-authorization-only",
      paidFallbackAllowed: false,
      recurringSchedulesEnabled: false,
      automaticMerge: false,
      automaticRelease: false,
      statuses: [
        "Backlog",
        "Ready",
        "In Progress",
        "In Review",
        "Ready to Integrate",
        "Integrated",
      ],
      blockedIsSeparateFlag: true,
      releaseInclusionTrackedSeparately: true,
      rulesEnforcedBy:
        "P3-scheduler-and-P5-delivery-state-machine-after-implementation-and-tests",
    };
    const outcome = parseStudioPolicy(shipped);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.policy).toEqual(DEFAULT_STUDIO_POLICY);
  });
});

describe("what is actually enforced", () => {
  test("the enforced list is a subset of the policy, not a copy of it", () => {
    /*
     * The distinction the whole setup turns on. A policy object with every field populated looks
     * identical whether a runtime holds those rules or merely carries them, so the list of the ones
     * something really checks is written down and asserted rather than implied.
     */
    for (const field of ENFORCED_POLICY_FIELDS) {
      expect(DEFAULT_STUDIO_POLICY).toHaveProperty(field);
    }
    const enforced = new Set<string>(ENFORCED_POLICY_FIELDS);
    const carried = Object.keys(DEFAULT_STUDIO_POLICY).filter(
      (field) => !enforced.has(field),
    );
    // These are parsed and carried, and are guidance for the roles rather than a boundary the
    // runtime holds. `maxHandoffsPerRun` is the queue's `atMost`, upstream, not this module's.
    expect(carried.sort()).toEqual([
      "automaticMerge",
      "automaticRelease",
      "maxHandoffsPerRun",
      "sameFailureAttemptsBeforeReassessment",
    ]);
  });
});
