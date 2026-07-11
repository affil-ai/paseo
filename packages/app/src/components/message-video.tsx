import { useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { VideoView, useVideoPlayer } from "expo-video";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";

function ResolvedMessageVideo({ uri, label }: { uri: string; label: string }) {
  const player = useVideoPlayer(uri);
  return (
    <VideoView
      player={player}
      style={styles.video}
      nativeControls
      contentFit="contain"
      accessibilityLabel={label}
      testID="message-video-player"
    />
  );
}

export function MessageVideo({
  source,
  filename,
  mimeType,
  client,
  workspaceRoot,
  serverId,
}: {
  source: string;
  filename: string;
  mimeType?: string;
  client?: DaemonClient | null;
  workspaceRoot?: string;
  serverId?: string;
}) {
  const resolution = useMemo(
    () => resolveAssistantImageSource({ source, workspaceRoot }),
    [source, workspaceRoot],
  );
  const query = useQuery({
    queryKey: [
      "messageVideo",
      serverId ?? "unknown-server",
      resolution?.kind === "file_rpc" ? resolution.cwd : null,
      resolution?.kind === "file_rpc" ? resolution.path : null,
    ],
    enabled: Boolean(client && resolution?.kind === "file_rpc"),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client || !resolution || resolution.kind !== "file_rpc") return null;
      const file = await client.readFile(resolution.cwd, resolution.path);
      return await persistAttachmentFromBytes({
        id: createPreviewAttachmentId({
          mimeType: file.mime,
          path: file.path || resolution.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType: file.mime || mimeType || "video/mp4",
        fileName: getFileNameFromPath(file.path || filename),
      });
    },
  });
  const persistedUri = useAttachmentPreviewUrl(query.data);
  const directUri = resolution?.kind === "direct" ? resolution.uri : null;
  const uri = directUri ?? persistedUri;

  return (
    <View style={styles.frame} testID="message-video">
      {uri ? <ResolvedMessageVideo uri={uri} label={filename} /> : null}
      {!uri && query.isLoading ? <ActivityIndicator size="small" /> : null}
      {!uri && !query.isLoading ? (
        <Text style={styles.error} numberOfLines={2}>
          {query.isError ? "Video unavailable" : filename}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    width: 360,
    maxWidth: "100%",
    aspectRatio: 16 / 9,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  video: {
    width: "100%",
    height: "100%",
  },
  error: {
    padding: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
