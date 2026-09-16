import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type SetupCheck = "online" | "needs_login" | "not_tested" | "error";

export type SetupStatus = {
  server: "online";
  database: "online" | "error";
  cursorLogin: SetupCheck;
  project: { status: "online" | "not_tested"; detail: string; path: string | null };
  queuePaused: boolean;
  policy: { maxActiveExecutionTasks: number; maxPrimaryExecutionTasksPerBot: number };
  activeCount: number;
  nextAction: string;
};

export type ProjectInfo = {
  path: string;
  gitRoot: string | null;
  verified: boolean;
  reason?: string;
  productId?: string;
  name?: string;
};

export type StudioProduct = {
  id: string;
  name: string;
  localPath: string | null;
  isSelected: boolean;
  queuePaused: boolean;
  retiredAt: string | null;
};

export type ProjectStatus = {
  project: ProjectInfo | null;
  queuePaused?: boolean;
  products?: StudioProduct[];
};

export type TaskEvidence = {
  taskId: string;
  backend: string | null;
  requestedModel: string | null;
  reportedModel: string | null;
  sessionId: string | null;
  worktreePath: string | null;
  changedFiles: string[];
  diff: string | null;
  checkBefore: unknown;
  checkAfter: unknown;
  ok: boolean | null;
  blocker: string | null;
  createdAt: string;
};

export type TaskReservation = {
  taskId: string;
  botId: string;
  kind: string;
  state: string;
  owner: string;
  fence: number;
  leaseUntil: string;
  expiresAt: string;
  turns: number;
};

export type StudioPullRequest = {
  number: number;
  url: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
};

export type StudioTask = {
  id: string;
  title: string;
  state: string;
  goal: string | null;
  acceptanceCriteria: string | null;
  blockedReason: string | null;
  ownerBotId: string | null;
  updatedAt: string;
  reservation: TaskReservation | null;
  evidence: TaskEvidence | null;
  pullRequest: StudioPullRequest | null;
  running: boolean;
};

export type StudioTaskDetail = {
  task: {
    id: string;
    title: string;
    state: string;
    goal: string | null;
    acceptanceCriteria: string | null;
    blockedReason: string | null;
    ownerBotId: string | null;
  };
  evidence: TaskEvidence | null;
  reservation: TaskReservation | null;
  running: boolean;
};

export const studioKeys = {
  all: ["studio"] as const,
  setup: () => ["studio", "setup"] as const,
  project: () => ["studio", "project"] as const,
  products: () => ["studio", "products"] as const,
  tasks: () => ["studio", "tasks"] as const,
  task: (taskId: string) => ["studio", "task", taskId] as const,
};

export const studioSetupQueryOptions = () =>
  queryOptions({
    queryKey: studioKeys.setup(),
    queryFn: async (): Promise<SetupStatus> =>
      (
        await client("/api/studio/setup", { fallback: "Could not read setup status" })
      ).json(),
    // Re-checked on its own schedule rather than only on mutation, since login/usage state changes
    // outside this app (a terminal `cursor-agent login`, a subscription reset).
    refetchInterval: 15_000,
  });

export const studioProjectQueryOptions = () =>
  queryOptions({
    queryKey: studioKeys.project(),
    queryFn: async (): Promise<ProjectStatus> =>
      (
        await client("/api/studio/project", {
          fallback: "Could not read the selected project",
        })
      ).json(),
  });

export const studioTasksQueryOptions = (pollWhileActive: boolean) =>
  queryOptions({
    queryKey: studioKeys.tasks(),
    queryFn: async (): Promise<{ tasks: StudioTask[] }> =>
      (
        await client("/api/studio/tasks", { fallback: "Could not load studio tasks" })
      ).json(),
    refetchInterval: pollWhileActive ? 3_000 : false,
  });

export const studioTaskQueryOptions = (taskId: string, pollWhileRunning: boolean) =>
  queryOptions({
    queryKey: studioKeys.task(taskId),
    queryFn: async (): Promise<StudioTaskDetail> =>
      (
        await client(`/api/studio/tasks/${taskId}`, {
          fallback: "Could not load this task",
        })
      ).json(),
    refetchInterval: pollWhileRunning ? 2_000 : false,
  });

export const studioProductsQueryOptions = () =>
  queryOptions({
    queryKey: studioKeys.products(),
    queryFn: async (): Promise<{ products: StudioProduct[]; selectedProductId: string | null }> =>
      (
        await client("/api/studio/products", {
          fallback: "Could not list studio products",
        })
      ).json(),
  });
