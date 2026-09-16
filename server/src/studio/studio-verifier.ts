/**
 * P1.5 — in-studio Verifier bot (Ultra Verifier pattern).
 * Checks claims with Mac evidence only; does not implement product features.
 */
import type { Database } from "../db/client";
import { createDynamicBot, getCatalogBot } from "./bot-catalog";

export const STUDIO_VERIFIER_BOT_ID = "studio-verifier";

export const STUDIO_VERIFIER_SYSTEM_PROMPT = `# Studio Verifier

You independently verify claims about the product and Studio runs on this Mac.

## Hard rules
- You do **not** implement product features, open feature PRs, or expand scope.
- You gather **Mac evidence only**: run listed checks, read files/logs/screenshots under the worktree or studio-local paths, quote exit codes and paths.
- Never invent green results. Untested stays untested.
- Hand back with: **Verdict** (PASS|FAIL|BLOCKED), **Evidence**, **Untested**, **Next**.

## How you work
When given a claim / acceptance criteria via studio_run_task (ownerBotId=studio-verifier) or studio_verify_claim:
1. Inspect the selected product worktree / paths named in the claim.
2. Run only verification commands (typecheck/tests/maestro if requested) — no feature coding.
3. Report verdict with concrete evidence.
`;

export function isStudioVerifierBot(botId: string): boolean {
  return botId === STUDIO_VERIFIER_BOT_ID;
}

/** Cursor worker prompt: evidence-only, no feature implementation. */
export function buildVerifierWorkerPrompt(input: {
  goal: string;
  acceptanceCriteria: string;
  verifyHint: string;
}): string {
  return `You are the Studio Verifier on this Mac worktree. You do NOT implement product features, do NOT open feature PRs, and do NOT expand scope.

Claim / goal to verify:
${input.goal}

Acceptance criteria / checks:
${input.acceptanceCriteria}
${input.verifyHint}

Instructions:
1. Inspect only what is needed to verify the claim (files, logs, existing screenshots under studio-local if referenced).
2. Run the verification commands listed above if any; capture exit codes and output tails.
3. Leave the tree unchanged except for optional evidence notes you must not commit as product features.
4. Finish with an explicit Verdict: PASS, FAIL, or BLOCKED, plus Evidence paths/commands and Untested gaps.
5. Do not invent results. If you cannot run a check, mark it Untested/BLOCKED.`;
}

export async function ensureStudioVerifierBot(
  database: Database,
): Promise<{ ok: true; botId: string; created: boolean } | { ok: false; error: string }> {
  const existing = await getCatalogBot(database, STUDIO_VERIFIER_BOT_ID);
  if (existing && !existing.archivedAt) {
    return { ok: true, botId: STUDIO_VERIFIER_BOT_ID, created: false };
  }
  const result = await createDynamicBot(database, {
    id: STUDIO_VERIFIER_BOT_ID,
    name: "Studio Verifier",
    title: "Verifier",
    systemPrompt: STUDIO_VERIFIER_SYSTEM_PROMPT,
    capabilities: ["cursor_execute"],
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, botId: STUDIO_VERIFIER_BOT_ID, created: result.created };
}
