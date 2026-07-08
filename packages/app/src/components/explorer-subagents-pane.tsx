import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronLeft, GitPullRequest, Link2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { getProviderIcon } from "@/components/provider-icons";
import { WorkspaceTabIcon } from "@/screens/workspace/workspace-tab-presentation";
import { useToast } from "@/contexts/toast-context";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { buildHostWorkspacePrShareUrl } from "@/utils/host-routes";
import { prIdentityKey } from "@/git/explorer-pr-tabs";
import { isWeb } from "@/constants/platform";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { AgentConversationPanel } from "@/panels/agent-panel";
import { buildSubagentRowPresentationData } from "@/subagents/track-presentation";
import {
  useSubagentsForWorkspace,
  useSubagentPrTabsForWorkspace,
  type SubagentRow,
} from "@/subagents";
import { formatPrTabLabel } from "@/git/pull-request-panel";
import type { WorkspaceTabPresentation } from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import type { Theme } from "@/styles/theme";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedLink2 = withUnistyles(Link2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// PR affordance shown on a subagent row: opens that subagent's PR review pane
// and offers a copy-link (deep-link) affordance keyed by stable PR identity.
interface SubagentRowPr {
  cwd: string;
  prNumber: number;
  prIdentityKey: string;
}

interface ExplorerSubagentsPaneProps {
  serverId: string;
  workspaceId?: string | null;
  onOpenFile?: (filePath: string) => void;
  // Open a subagent's PR review pane (switches the explorer to that PR tab).
  // Undefined in surfaces that don't host explorer PR tabs (e.g. dashboard).
  onSelectSubagentPr?: (prCwd: string) => void;
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
  onSelectSubagentPr,
}: ExplorerSubagentsPaneProps) {
  const { t } = useTranslation();
  const rows = useSubagentsForWorkspace({
    serverId,
    workspaceId: workspaceId ?? "",
  });
  const prTabInputs = useSubagentPrTabsForWorkspace({
    serverId,
    workspaceId: workspaceId ?? "",
  });
  // Map subagent id -> its PR affordance, so every row that has a PR can open it
  // (covers overflow PRs beyond the inline header cap).
  const prBySubagentId = useMemo(() => {
    const map = new Map<string, SubagentRowPr>();
    for (const input of prTabInputs) {
      map.set(input.subagentId, {
        cwd: input.cwd,
        prNumber: input.prNumber,
        prIdentityKey: prIdentityKey(input, input.cwd),
      });
    }
    return map;
  }, [prTabInputs]);
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
        <ExplorerSubagentRow
          key={row.id}
          row={row}
          pr={prBySubagentId.get(row.id) ?? null}
          serverId={serverId}
          workspaceId={workspaceId ?? null}
          onSelect={setSelectedAgentId}
          onSelectPr={onSelectSubagentPr}
        />
      ))}
    </ScrollView>
  );
}

function ExplorerSubagentRow({
  row,
  pr,
  serverId,
  workspaceId,
  onSelect,
  onSelectPr,
}: {
  row: SubagentRow;
  pr: SubagentRowPr | null;
  serverId: string;
  workspaceId: string | null;
  onSelect: (id: string) => void;
  onSelectPr?: (prCwd: string) => void;
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
            {pr && onSelectPr ? (
              <SubagentRowPrBadge prNumber={pr.prNumber} cwd={pr.cwd} onSelectPr={onSelectPr} />
            ) : null}
            {pr && workspaceId ? (
              <SubagentPrCopyLinkButton
                serverId={serverId}
                workspaceId={workspaceId}
                prNumber={pr.prNumber}
                prIdentityKey={pr.prIdentityKey}
              />
            ) : null}
          </View>
        )}
      </Pressable>
    </View>
  );
}

function prBadgeStyle({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) {
  return [styles.prBadge, (hovered || pressed) && styles.prBadgeActive];
}

function copyLinkButtonStyle({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) {
  return [styles.prBadge, (hovered || pressed) && styles.prBadgeActive];
}

// Copy a shareable deep-link URL (?pr=<identity>) for a subagent PR to the
// clipboard. On web the URL is origin-qualified; elsewhere it is the app route.
function SubagentPrCopyLinkButton({
  serverId,
  workspaceId,
  prNumber,
  prIdentityKey: identityKey,
}: {
  serverId: string;
  workspaceId: string;
  prNumber: number;
  prIdentityKey: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const handlePress = useCallback(() => {
    const origin =
      isWeb && typeof window !== "undefined" && window.location ? window.location.origin : null;
    const url = buildHostWorkspacePrShareUrl({
      serverId,
      workspaceId,
      prIdentityKey: identityKey,
      origin,
    });
    void copyToClipboard(url).then(
      () => toast.copied(t("workspace.tabs.explorer.copyPrLinkLabel")),
      () => toast.error(t("workspace.tabs.explorer.copyPrLinkFailed")),
    );
  }, [identityKey, serverId, t, toast, workspaceId]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("workspace.tabs.explorer.copyPrLink", { number: prNumber })}
      testID={`explorer-subagents-pr-copy-${prNumber}`}
      onPress={handlePress}
      hitSlop={6}
      style={copyLinkButtonStyle}
    >
      <ThemedLink2 size={12} uniProps={mutedColorMapping} />
    </Pressable>
  );
}

function SubagentRowPrBadge({
  prNumber,
  cwd,
  onSelectPr,
}: {
  prNumber: number;
  cwd: string;
  onSelectPr: (prCwd: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelectPr(cwd), [cwd, onSelectPr]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("workspace.tabs.explorer.openSubagentPr", { number: prNumber })}
      testID={`explorer-subagents-pr-${prNumber}`}
      onPress={handlePress}
      hitSlop={6}
      style={prBadgeStyle}
    >
      <ThemedGitPullRequest size={12} uniProps={mutedColorMapping} />
      <Text style={styles.prBadgeText} numberOfLines={1}>
        {formatPrTabLabel(prNumber)}
      </Text>
    </Pressable>
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
  prBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  prBadgeActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  prBadgeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
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
