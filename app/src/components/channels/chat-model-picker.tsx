/**
 * Compact provider/model control for Studio channel chat.
 * Cursor (subscription) vs Claude (Claude Code OAuth), Apply + Restart session.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { channelKeys } from "@/lib/channels/queries";

type ListedModel = { id: string; label: string; provider: "cursor" | "claude" };

type ProvidersResponse = {
  providers: Array<{
    id: "cursor" | "claude";
    label: string;
    models: ListedModel[];
  }>;
};

type PreferenceResponse = {
  channelId: string;
  preference: {
    provider: "cursor" | "claude";
    modelId: string;
    encoded: string;
  } | null;
};

const pickerKeys = {
  models: ["studio", "chat-models"] as const,
  preference: (channelId: string) =>
    ["studio", "channel-chat-model", channelId] as const,
};

export function ChatModelPicker({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const modelsQuery = useQuery({
    queryKey: pickerKeys.models,
    queryFn: async (): Promise<ProvidersResponse> =>
      (await client("/api/studio/chat-models", { fallback: "Could not load models" })).json(),
    staleTime: 60_000,
  });
  const prefQuery = useQuery({
    queryKey: pickerKeys.preference(channelId),
    queryFn: async (): Promise<PreferenceResponse> =>
      (
        await client(`/api/studio/channels/${encodeURIComponent(channelId)}/chat-model`, {
          fallback: "Could not load chat model preference",
        })
      ).json(),
  });

  const providers = modelsQuery.data?.providers ?? [];
  const [provider, setProvider] = useState<"cursor" | "claude">("cursor");
  const [modelId, setModelId] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const pref = prefQuery.data?.preference;
    if (pref) {
      setProvider(pref.provider);
      setModelId(pref.modelId);
      return;
    }
    // No preference yet — seed from first provider list when available.
    if (providers.length > 0 && !modelId) {
      const first = providers[0];
      if (first) {
        setProvider(first.id);
        setModelId(first.models[0]?.id ?? "");
      }
    }
  }, [prefQuery.data, providers, modelId]);

  const modelOptions = useMemo(() => {
    const p = providers.find((x) => x.id === provider);
    return p?.models ?? [];
  }, [providers, provider]);

  useEffect(() => {
    if (modelOptions.length === 0) return;
    if (!modelOptions.some((m) => m.id === modelId)) {
      setModelId(modelOptions[0]?.id ?? "");
    }
  }, [modelOptions, modelId]);

  const apply = useMutation({
    mutationFn: async () =>
      (
        await client(`/api/studio/channels/${encodeURIComponent(channelId)}/chat-model`, {
          method: "PUT",
          body: { provider, modelId },
          fallback: "Could not apply chat model",
        })
      ).json() as Promise<{ preference: PreferenceResponse["preference"] }>,
    onSuccess: async () => {
      setStatus("Applied — next message uses this model.");
      await queryClient.invalidateQueries({
        queryKey: pickerKeys.preference(channelId),
      });
    },
    onError: (err: Error) => setStatus(err.message),
  });

  const restart = useMutation({
    mutationFn: async () =>
      (
        await client(
          `/api/studio/channels/${encodeURIComponent(channelId)}/chat-model/restart`,
          {
            method: "POST",
            body: { provider, modelId },
            fallback: "Could not restart session",
          },
        )
      ).json() as Promise<{ threadId: string; preference: PreferenceResponse["preference"] }>,
    onSuccess: async () => {
      setStatus("Session restarted — fresh thread under the new model.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pickerKeys.preference(channelId) }),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
        queryClient.invalidateQueries({ queryKey: channelKeys.detail(channelId) }),
      ]);
    },
    onError: (err: Error) => setStatus(err.message),
  });

  const busy = apply.isPending || restart.isPending;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs">
      <label className="flex items-center gap-1">
        <span className="text-muted-foreground">Provider</span>
        <select
          className="rounded border border-border bg-background px-1.5 py-0.5"
          disabled={busy || modelsQuery.isLoading}
          value={provider}
          onChange={(e) => setProvider(e.target.value as "cursor" | "claude")}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {providers.length === 0 ? (
            <>
              <option value="cursor">Cursor</option>
              <option value="claude">Claude</option>
            </>
          ) : null}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 items-center gap-1">
        <span className="shrink-0 text-muted-foreground">Model</span>
        <select
          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5"
          disabled={busy || modelOptions.length === 0}
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
        >
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-7 px-2"
        disabled={busy || !modelId}
        onClick={() => {
          setStatus(null);
          apply.mutate();
        }}
      >
        Apply
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2"
        disabled={busy || !modelId}
        onClick={() => {
          setStatus(null);
          restart.mutate();
        }}
      >
        Restart session
      </Button>
      {status ? (
        <span className="w-full text-[11px] text-muted-foreground">{status}</span>
      ) : null}
      {prefQuery.data?.preference ? (
        <span className="w-full font-mono text-[10px] text-muted-foreground">
          Active: {prefQuery.data.preference.encoded}
        </span>
      ) : (
        <span className="w-full text-[10px] text-muted-foreground">
          Using bot default until Apply
        </span>
      )}
    </div>
  );
}
