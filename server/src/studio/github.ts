/**
 * Opening and retargeting pull requests without ever opening two.
 *
 * THE FAILURE THIS IS BUILT AROUND is not an error, it is an ambiguous success. A create call times
 * out; the pull request exists; the retry opens a second one; two PRs now claim the same work and a
 * reviewer approves whichever they found first. Nothing in either response says anything is wrong.
 *
 * So every create is: write down that we are about to, ask GitHub whether the branch already has a
 * pull request, and only then create. The search is not an optimisation — it is the correctness
 * step, and it runs before the first attempt as well as before the retry, because a process that
 * died in the window left no memory of having tried.
 *
 * DRAFT, ALWAYS. Nothing here opens a pull request ready for review, and nothing here merges one.
 * Merging is the user's existing authorisation and the repository's own gates; a studio that merged
 * to unblock its own queue would be deciding something it was never given.
 *
 * GH RATHER THAN A TOKEN IN THIS PROCESS. The CLI holds the credential in the place the person put
 * it, and this passes structured arguments to it. Building an API client here would mean a token in
 * this deployment's configuration, which is a credential in a second place for no capability gained.
 */
import type { Database } from "../db/client";
import { eq, sql } from "drizzle-orm";
import { studioBranches, studioPullRequests } from "../db/schema";

export type GhRunner = (
  args: string[],
  options?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type PullRequest = {
  number: number;
  url: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  state: string;
};

export type GitHubDelivery = {
  /**
   * The pull request for this branch, if GitHub already has one.
   *
   * Asked of GITHUB, not of the local table. The table says what this deployment believes; the
   * question being answered is what actually exists, and those differ exactly when it matters.
   */
  findForBranch: (input: {
    repository: string;
    headBranch: string;
    cwd?: string;
  }) => Promise<PullRequest | null>;
  /** Open a draft pull request, or return the one that is already there. */
  openDraft: (input: {
    taskId: string;
    repository: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
    cwd?: string;
  }) => Promise<
    | { ok: true; pull: PullRequest; created: boolean }
    | { ok: false; reason: string }
  >;
  /**
   * Point a child's pull request at a new base after its parent merged.
   *
   * Retargeting alone is not enough and the function says so: the child branch still contains the
   * parent's commits, and after a SQUASH merge those commits are not in the trunk under any id the
   * child knows. The caller is told what the repository's merge strategy means for this child.
   */
  retarget: (input: {
    taskId: string;
    repository: string;
    newBase: string;
    mergeStrategy: "merge" | "squash" | "rebase";
    cwd?: string;
  }) => Promise<
    | { ok: true; needsRestack: boolean; reason: string }
    | { ok: false; reason: string }
  >;
};

/** Structured output only. Parsing human text would break on the next release of `gh`. */
const JSON_FIELDS = "number,url,baseRefName,headRefName,isDraft,state";

function asPullRequest(value: Record<string, unknown>): PullRequest {
  return {
    number: Number(value.number),
    url: String(value.url ?? ""),
    baseBranch: String(value.baseRefName ?? ""),
    headBranch: String(value.headRefName ?? ""),
    draft: value.isDraft === true,
    state: String(value.state ?? ""),
  };
}

export function createGitHubDelivery(
  database: Database,
  gh: GhRunner,
): GitHubDelivery {
  const delivery: GitHubDelivery = {
    async findForBranch({ repository, headBranch, cwd }) {
      const listed = await gh(
        [
          "pr",
          "list",
          "--repo",
          repository,
          "--head",
          headBranch,
          // Open and closed alike: a closed PR for this branch still means one was opened, and
          // opening another would be the duplicate this whole module exists to avoid.
          "--state",
          "all",
          "--json",
          JSON_FIELDS,
          "--limit",
          "10",
        ],
        cwd ? { cwd } : {},
      );
      if (listed.exitCode !== 0) return null;
      try {
        const rows = JSON.parse(listed.stdout || "[]") as Record<
          string,
          unknown
        >[];
        const match = rows.find((row) => row.headRefName === headBranch);
        return match ? asPullRequest(match) : null;
      } catch {
        return null;
      }
    },

    async openDraft(input) {
      /*
       * Marked as attempted BEFORE anything leaves this process.
       *
       * The window being closed is between the request leaving and the answer arriving. A process
       * that dies in it has no memory of having tried, and this row is the memory.
       */
      await database
        .insert(studioPullRequests)
        .values({
          taskId: input.taskId,
          repository: input.repository,
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          pendingSince: sql`now()`,
        })
        .onConflictDoUpdate({
          target: studioPullRequests.taskId,
          set: {
            repository: input.repository,
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            pendingSince: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      // The correctness step, run before the first attempt as well as before a retry.
      const existing = await delivery.findForBranch({
        repository: input.repository,
        headBranch: input.headBranch,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
      if (existing) {
        await database
          .update(studioPullRequests)
          .set({
            number: existing.number,
            url: existing.url,
            baseBranch: existing.baseBranch,
            draft: existing.draft,
            pendingSince: null,
            updatedAt: sql`now()`,
          })
          .where(eq(studioPullRequests.taskId, input.taskId));
        return { ok: true, pull: existing, created: false };
      }

      const created = await gh(
        [
          "pr",
          "create",
          "--repo",
          input.repository,
          "--head",
          input.headBranch,
          /*
           * The base is set EXPLICITLY, every time, and never left to the repository default.
           *
           * A stacked child defaulted to the trunk shows a diff containing its parent's changes as
           * if the child had written them, which is the review nobody can do properly.
           */
          "--base",
          input.baseBranch,
          "--draft",
          "--title",
          input.title,
          "--body",
          input.body,
        ],
        input.cwd ? { cwd: input.cwd } : {},
      );

      if (created.exitCode !== 0) {
        /*
         * An ambiguous failure is reconciled rather than reported.
         *
         * `gh` exits non-zero for a request that timed out after GitHub accepted it, and for one
         * GitHub refused, and the exit code does not distinguish them. So the same search runs
         * again: if the pull request is there, the call succeeded and the error was about the
         * answer, not the action.
         */
        const reconciled = await delivery.findForBranch({
          repository: input.repository,
          headBranch: input.headBranch,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        });
        if (reconciled) {
          await database
            .update(studioPullRequests)
            .set({
              number: reconciled.number,
              url: reconciled.url,
              pendingSince: null,
              updatedAt: sql`now()`,
            })
            .where(eq(studioPullRequests.taskId, input.taskId));
          return { ok: true, pull: reconciled, created: false };
        }
        return {
          ok: false,
          reason:
            created.stderr.trim() ||
            "The pull request could not be created, and none exists for this branch.",
        };
      }

      const opened = await delivery.findForBranch({
        repository: input.repository,
        headBranch: input.headBranch,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
      if (!opened) {
        return {
          ok: false,
          reason:
            "GitHub reported the pull request as created but it cannot be found, so this deployment will not record one that may not exist.",
        };
      }
      await database
        .update(studioPullRequests)
        .set({
          number: opened.number,
          url: opened.url,
          baseBranch: opened.baseBranch,
          draft: opened.draft,
          pendingSince: null,
          updatedAt: sql`now()`,
        })
        .where(eq(studioPullRequests.taskId, input.taskId));
      return { ok: true, pull: opened, created: true };
    },

    async retarget(input) {
      const [row] = await database
        .select()
        .from(studioPullRequests)
        .where(eq(studioPullRequests.taskId, input.taskId))
        .limit(1);
      if (!row?.number) {
        return {
          ok: false,
          reason: "This task has no pull request to retarget.",
        };
      }
      const result = await gh(
        [
          "pr",
          "edit",
          String(row.number),
          "--repo",
          input.repository,
          "--base",
          input.newBase,
        ],
        input.cwd ? { cwd: input.cwd } : {},
      );
      if (result.exitCode !== 0) {
        return {
          ok: false,
          reason: result.stderr.trim() || "The base could not be changed.",
        };
      }
      await database
        .update(studioPullRequests)
        .set({ baseBranch: input.newBase, updatedAt: sql`now()` })
        .where(eq(studioPullRequests.taskId, input.taskId));
      await database
        .update(studioBranches)
        .set({ baseBranch: input.newBase })
        .where(eq(studioBranches.taskId, input.taskId));

      /*
       * Retargeting is not restacking, and which one is needed depends on how the parent merged.
       *
       * After a MERGE the parent's commits are in the trunk under the same ids, so the child's diff
       * collapses to its own changes on its own. After a SQUASH they are not in the trunk under ANY
       * id the child knows, so the child still carries them and its diff shows the parent's work as
       * the child's — a review of a diff nobody wrote. Squash is the common default, which is why
       * this is the case that is said out loud rather than assumed away.
       */
      const needsRestack = input.mergeStrategy !== "merge";
      return {
        ok: true,
        needsRestack,
        reason: needsRestack
          ? `The parent was ${input.mergeStrategy}-merged, so its commits are not in ${input.newBase} under the ids this branch knows. Rebase this branch onto ${input.newBase} and rerun its checks: retargeting alone leaves the parent's changes showing as this task's.`
          : `The parent was merged, so ${input.newBase} already contains its commits and this branch's diff is now its own changes. Rerun the checks that depended on the parent.`,
      };
    },
  };

  return delivery;
}

/** Run `gh`, capturing output. Separate so tests never reach the network or somebody's account. */
export function ghRunner(execute: typeof Bun.spawn = Bun.spawn): GhRunner {
  return async (args, options) => {
    const child = execute(["gh", ...args], {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  };
}
