import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { getProviderIcon } from "@/components/provider-icons";
import { WorkspaceTabIcon } from "@/screens/workspace/workspace-tab-presentation";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { AgentConversationPanel } from "@/panels/agent-panel";
import { buildSubagentRowPresentationData } from "@/subagents/track-presentation";
import { useSubagentsForWorkspace, type SubagentRow } from "@/subagents";
import type { WorkspaceTabPresentation } from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import type { Theme } from "@/styles/theme";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ExplorerSubagentsPaneProps {
  serverId: string;
  workspaceId?: string | null;
  onOpenFile?: (filePath: string) => void;
}

function buildRowPresentation(row: SubagentRow): WorkspaceTabPresentation {
  return {
    ...buildSubagentRowPresentationData(row),
    icon: getProviderIcon(row.provider),
  };
}

export function ExplorerSubagentsPane({
  serverId,
  workspaceId,
  onOpenFile,
}: ExplorerSubagentsPaneProps) {
  const { t } = useTranslation();
  const rows = useSubagentsForWorkspace({
    serverId,
    workspaceId: workspaceId ?? "",
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedAgentId) ?? null,
    [rows, selectedAgentId],
  );

  const handleBack = useCallback(() => setSelectedAgentId(null), []);

  if (selectedRow) {
    return (
      <View style={styles.container}>
        <Pressable
          style={styles.backRow}
          onPress={handleBack}
          testID="explorer-subagents-back"
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.back")}
        >
          <ThemedChevronLeft size={16} uniProps={mutedColorMapping} />
          <Text style={styles.backLabel} numberOfLines={1}>
            {t("workspace.tabs.explorer.subagents")}
          </Text>
        </Pressable>
        <View style={styles.conversation}>
          <ExplorerSubagentConversation
            serverId={serverId}
            workspaceId={workspaceId ?? ""}
            agentId={selectedRow.id}
            onOpenFile={onOpenFile}
          />
        </View>
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{t("workspace.tabs.explorer.subagentsEmpty")}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      testID="explorer-subagents-list"
    >
      {rows.map((row) => (
        <ExplorerSubagentRow key={row.id} row={row} onSelect={setSelectedAgentId} />
      ))}
    </ScrollView>
  );
}

function ExplorerSubagentRow({
  row,
  onSelect,
}: {
  row: SubagentRow;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const presentation = useMemo(() => buildRowPresentation(row), [row]);
  const displayLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(() => onSelect(row.id), [onSelect, row.id]);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={displayLabel}
        testID={`explorer-subagents-row-${row.id}`}
        onPress={handlePress}
      >
        {({ pressed }) => (
          <View style={hovered || pressed ? styles.rowActive : styles.row}>
            <WorkspaceTabIcon presentation={presentation} />
            <Text style={styles.rowLabel} numberOfLines={1}>
              {displayLabel}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function ExplorerSubagentConversation({
  serverId,
  workspaceId,
  agentId,
  onOpenFile,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  onOpenFile?: (filePath: string) => void;
}) {
  const handleOpenFileInWorkspace = useCallback(
    (request: WorkspaceFileOpenRequest) => {
      onOpenFile?.(request.location.path);
    },
    [onOpenFile],
  );

  const paneContextValue = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId,
      tabId: `explorer-subagent:${agentId}`,
      target: { kind: "agent", agentId },
      openTab: () => {},
      closeCurrentTab: () => {},
      retargetCurrentTab: () => {},
      openFileInWorkspace: handleOpenFileInWorkspace,
      openImportSheet: () => {},
    }),
    [agentId, handleOpenFileInWorkspace, serverId, workspaceId],
  );

  const paneFocusValue = useMemo(
    () =>
      createPaneFocusContextValue({
        isWorkspaceFocused: true,
        isPaneFocused: true,
      }),
    [],
  );

  return (
    <PaneProvider value={paneContextValue}>
      <PaneFocusProvider value={paneFocusValue}>
        <AgentConversationPanel />
      </PaneFocusProvider>
    </PaneProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  backLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  conversation: {
    flex: 1,
    minHeight: 0,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
