/**
 * The studio's own rules, read from a file rather than compiled in.
 *
 * WHAT THIS IS NOT. `studio-policy.json` as it ships with the setup kit is a *specification*: a
 * description of the rules somebody wants, written before anything enforced them. Its own
 * `kind` field says so, and its `rulesEnforcedBy` field names this module and the delivery state
 * machine as the things that would have to exist. Parsing it here is what starts turning it into a
 * rule, and a parsed field is still only enforced where something reads it — `admission.ts` reads
 * the capacity and budget fields, and the fields it does not read are reported as not enforced
 * rather than assumed.
 *
 * EVERY FIELD IS VALIDATED, and an unreadable policy is refused rather than defaulted past. A
 * deployment that silently fell back to built-in numbers because a file had a typo would be
 * enforcing rules nobody chose, and reporting that it was enforcing the ones in the file.
 */

/** The statuses a task moves through. Blocked is a flag, and release inclusion is separate. */
export const STUDIO_STATUSES = [
  "Backlog",
  "Ready",
  "In Progress",
  "In Review",
  "Ready to Integrate",
  "Integrated",
] as const;

export type StudioPolicy = {
  /** One at a time. Retiring one is how another starts, rather than a second becoming active. */
  maxActiveProducts: number;
  /** Across every process, counting children and independent reviews. */
  maxActiveExecutionTasks: number;
  /** One primary piece of work per Bot: a Bot doing two things is doing neither. */
  maxPrimaryExecutionTasksPerBot: number;
  /** Lead -> Specialist -> temporary leaf, expressed as a number so the check can be arithmetic. */
  maxDelegationDepth: number;
  /** How many Bots one run may address. Enforced upstream by the queue's `atMost`. */
  maxHandoffsPerRun: number;
  /** A parent waiting on a child keeps its slot unless it suspends with a checkpoint. */
  waitingParentKeepsReservationUnlessCheckpointedAndSuspended: boolean;
  /** Children and reviews count against the cap. False would make the cap decorative. */
  countChildTasksAndReviews: boolean;
  /** A temporary worker may not delegate again. */
  temporaryWorkersAreLeaves: boolean;
  /** After this many failures at one problem, reassess rather than loop. */
  sameFailureAttemptsBeforeReassessment: number;
  /** The hard wall clock on one assignment. Renewal cannot move it. */
  initialPilotWallClockMinutes: number;
  /** The hard turn ceiling on one assignment. */
  initialPilotMaxAgentTurns: number;
  /** No unapproved paid fallback, ever, and never as a recovery from a rate limit. */
  paidFallbackAllowed: boolean;
  /** Nothing recurring is switched on by installing this. */
  recurringSchedulesEnabled: boolean;
  automaticMerge: boolean;
  automaticRelease: boolean;
};

/**
 * The kit's own values, used when no policy file is configured.
 *
 * Deliberately identical to `studio-policy.json` as shipped, so a deployment that configures no file
 * and one that configures the shipped file behave the same. Divergent defaults are how "it works on
 * mine" starts.
 */
export const DEFAULT_STUDIO_POLICY: StudioPolicy = {
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
  paidFallbackAllowed: false,
  recurringSchedulesEnabled: false,
  automaticMerge: false,
  automaticRelease: false,
};

const WHOLE_NUMBER_FIELDS = [
  "maxActiveProducts",
  "maxActiveExecutionTasks",
  "maxPrimaryExecutionTasksPerBot",
  "maxDelegationDepth",
  "maxHandoffsPerRun",
  "sameFailureAttemptsBeforeReassessment",
  "initialPilotWallClockMinutes",
  "initialPilotMaxAgentTurns",
] as const;

const BOOLEAN_FIELDS = [
  "waitingParentKeepsReservationUnlessCheckpointedAndSuspended",
  "countChildTasksAndReviews",
  "temporaryWorkersAreLeaves",
  "paidFallbackAllowed",
  "recurringSchedulesEnabled",
  "automaticMerge",
  "automaticRelease",
] as const;

/**
 * Which of a policy's fields something in this deployment actually enforces.
 *
 * REPORTED RATHER THAN IMPLIED, because the gap between a rule written down and a rule enforced is
 * the single thing the setup kit is most insistent about, and a policy object with every field
 * populated looks exactly the same either way. Anything not on this list is parsed, carried, and
 * honestly described as guidance for the roles rather than a boundary the runtime holds.
 */
export const ENFORCED_POLICY_FIELDS = [
  "maxActiveProducts",
  "maxActiveExecutionTasks",
  "maxPrimaryExecutionTasksPerBot",
  "maxDelegationDepth",
  "countChildTasksAndReviews",
  "temporaryWorkersAreLeaves",
  "waitingParentKeepsReservationUnlessCheckpointedAndSuspended",
  "initialPilotWallClockMinutes",
  "initialPilotMaxAgentTurns",
  "paidFallbackAllowed",
  "recurringSchedulesEnabled",
] as const;

export type PolicyProblem = { field: string; reason: string };

/**
 * Read a policy, or say exactly what is wrong with it.
 *
 * Every problem at once rather than the first: an operator fixing a configuration file should not
 * have to run the server seven times to find seven typos.
 */
export function parseStudioPolicy(
  value: unknown,
):
  | { ok: true; policy: StudioPolicy }
  | { ok: false; problems: PolicyProblem[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      problems: [{ field: "", reason: "A policy must be a JSON object." }],
    };
  }
  const raw = value as Record<string, unknown>;
  const problems: PolicyProblem[] = [];
  const policy = { ...DEFAULT_STUDIO_POLICY };

  for (const field of WHOLE_NUMBER_FIELDS) {
    const entry = raw[field];
    // Absent is the default, which is how a partial policy file stays usable. Present and wrong is
    // a refusal: a caps field of `"three"` read as a default is a cap nobody chose.
    if (entry === undefined || entry === null) continue;
    if (
      typeof entry !== "number" ||
      !Number.isInteger(entry) ||
      entry < 0 ||
      entry > 1_000_000
    ) {
      problems.push({
        field,
        reason: "must be a whole number between 0 and 1000000",
      });
      continue;
    }
    policy[field] = entry;
  }

  for (const field of BOOLEAN_FIELDS) {
    const entry = raw[field];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== "boolean") {
      problems.push({ field, reason: "must be true or false" });
      continue;
    }
    policy[field] = entry;
  }

  /*
   * Refused rather than corrected.
   *
   * A policy that allows a paid fallback, or turns recurring schedules on, is a decision with money
   * behind it. Quietly normalising either one would be this deployment deciding it on the operator's
   * behalf — so they are parsed exactly as written, and it is `admission.ts` that refuses to act on
   * them, where the refusal is visible.
   */
  if (policy.maxActiveExecutionTasks === 0) {
    problems.push({
      field: "maxActiveExecutionTasks",
      reason:
        "must be at least 1: zero admits nothing at all, which is a deployment that cannot work rather than one that is bounded",
    });
  }
  if (policy.maxPrimaryExecutionTasksPerBot === 0) {
    problems.push({
      field: "maxPrimaryExecutionTasksPerBot",
      reason: "must be at least 1: zero means no Bot may ever be given work",
    });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, policy };
}

/**
 * Read one from a file, when a deployment configured one.
 *
 * Returns the defaults with a note when no path is configured, so "no file" and "a broken file" are
 * different outcomes: the first is an ordinary deployment and the second is a misconfiguration
 * somebody needs to see.
 */
export async function loadStudioPolicy(
  path: string | undefined,
  readFile: (path: string) => Promise<string> = async (target) =>
    Bun.file(target).text(),
): Promise<
  | { ok: true; policy: StudioPolicy; source: "defaults" | "file" }
  | { ok: false; problems: PolicyProblem[] }
> {
  if (!path) {
    return { ok: true, policy: DEFAULT_STUDIO_POLICY, source: "defaults" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path));
  } catch (error) {
    return {
      ok: false,
      problems: [
        {
          field: "",
          // The path, never the contents: a policy file sits beside configuration and an error that
          // echoed it back would be a good way to print something that should not be printed.
          reason: `could not be read as JSON from ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      ],
    };
  }
  const outcome = parseStudioPolicy(parsed);
  return outcome.ok ? { ...outcome, source: "file" } : outcome;
}
