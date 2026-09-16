import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { studioKeys } from "./queries";

const FALLBACK = "Studio operation failed";

function invalidateStudio(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: studioKeys.all });
}

export function selectStudioProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (path: string): Promise<{ path: string; gitRoot: string }> =>
      (
        await client("/api/studio/project", {
          method: "POST",
          body: { path },
          fallback: FALLBACK,
        })
      ).json(),
    onSuccess: () => invalidateStudio(queryClient),
  });
}

export type RunTaskInput = {
  title: string;
  goal: string;
  acceptanceCriteria: string;
  idempotencyKey: string;
};

export function runStudioTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: RunTaskInput): Promise<{ taskId: string }> =>
      (
        await client("/api/studio/tasks", { method: "POST", body: input, fallback: FALLBACK })
      ).json(),
    onSuccess: () => invalidateStudio(queryClient),
  });
}

export function runCodingTestMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<{ taskId: string; model: string }> =>
      (
        await client("/api/studio/coding-test", { method: "POST", fallback: FALLBACK })
      ).json(),
    onSuccess: () => invalidateStudio(queryClient),
  });
}

export function stopStudioTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (taskId: string): Promise<{ status: string; note: string }> =>
      (
        await client(`/api/studio/tasks/${taskId}/stop`, { method: "POST", fallback: FALLBACK })
      ).json(),
    onSuccess: () => invalidateStudio(queryClient),
  });
}

export function continueStudioTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (taskId: string): Promise<{ status: string }> =>
      (
        await client(`/api/studio/tasks/${taskId}/continue`, {
          method: "POST",
          fallback: FALLBACK,
        })
      ).json(),
    onSuccess: () => invalidateStudio(queryClient),
  });
}

export function pauseStudioQueueMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<{ queuePaused: boolean }> =>
      (
        await client("/api/studio/queue/pause", { method: "POST", fallback: FALLBACK })
      ).json(),
    onSuccess: () => invalidateStudio(queryClient),
  });
}

export function resumeStudioQueueMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<{ queuePaused: boolean }> =>
      (
        await client("/api/studio/queue/resume", { method: "POST", fallback: FALLBACK })
      ).json(),
    onSuccess: () => invalidateStudio(queryClient),
  });
}
