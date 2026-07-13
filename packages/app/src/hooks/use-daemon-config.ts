import { useCallback, useEffect, useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { useReplicaQuery } from "@/data/query";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";

interface UseDaemonConfigResult {
  config: MutableDaemonConfig | null;
  isLoading: boolean;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
}

export function useDaemonConfig(serverId: string | null): UseDaemonConfigResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => daemonConfigQueryKey(serverId), [serverId]);

  const configQuery = useReplicaQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.getDaemonConfig();
      return result.config;
    },
  });

  const patchConfig = useCallback(
    async (patch: MutableDaemonConfigPatch) => {
      if (!client) {
        return undefined;
      }
      const result = await client.patchDaemonConfig(patch);
      queryClient.setQueryData(queryKey, result.config);
      return result.config;
    },
    [client, queryClient, queryKey],
  );

  return {
    config: configQuery.data ?? null,
    isLoading: configQuery.isLoading,
    patchConfig,
  };
}

export function useDaemonConfigs(
  serverIds: readonly string[],
): ReadonlyMap<string, MutableDaemonConfig> {
  const queryClient = useQueryClient();
  const runtime = getHostRuntimeStore();
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const configQueries = useQueries({
    queries: serverIds.map((serverId) => {
      const client = runtime.getSnapshot(serverId)?.client ?? null;
      return {
        queryKey: daemonConfigQueryKey(serverId),
        enabled: Boolean(client && connectionStatuses.get(serverId) === "online"),
        staleTime: Infinity,
        queryFn: async () => {
          if (!client) {
            throw new Error("Host disconnected");
          }
          const result = await client.getDaemonConfig();
          return result.config;
        },
      };
    }),
  });

  useEffect(() => {
    const unsubscribes = serverIds.flatMap((serverId) => {
      const client = runtime.getSnapshot(serverId)?.client;
      if (!client) return [];
      return [
        client.on("status", (message) => {
          if (message.type === "status" && message.payload.status === "daemon_config_changed") {
            queryClient.setQueryData(
              daemonConfigQueryKey(serverId),
              message.payload.config as MutableDaemonConfig,
            );
          }
        }),
      ];
    });
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [connectionStatuses, queryClient, runtime, serverIds]);

  return useMemo(() => {
    const configs = new Map<string, MutableDaemonConfig>();
    for (const [index, serverId] of serverIds.entries()) {
      const config = configQueries[index]?.data;
      if (config) {
        configs.set(serverId, config);
      }
    }
    return configs;
  }, [configQueries, serverIds]);
}
