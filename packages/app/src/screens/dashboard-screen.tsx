import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ExternalLink, GitPullRequest, PanelRightOpen } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExplorerSidebarContent } from "@/components/explorer-sidebar";
import type { ExplorerTab } from "@/stores/panel-store";
import {
  useDashboardPullRequests,
  type DashboardPrColumn,
  type DashboardPullRequest,
  type DashboardRepoOption,
} from "@/dashboard/use-dashboard-pull-requests";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { openExternalUrl } from "@/utils/open-external-url";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";

const COLUMNS: Array<{ id: DashboardPrColumn; label: string }> = [
  { id: "review", label: "Ready for review" },
  { id: "draft", label: "Draft" },
  { id: "blocked", label: "Blocked" },
];

export function DashboardScreen() {
  const { t } = useTranslation();
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const { pullRequests, repos, isLoading, hasError, refetch } = useDashboardPullRequests({
    repoFilter,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isCompact = useIsCompactFormFactor();

  const selectedPr = pullRequests.find((pr) => pr.id === selectedId) ?? null;
  const reviewablePr = selectedPr?.workspace ? selectedPr : null;

  // Drop the selection if the PR disappears from the board (e.g. merged/closed).
  useEffect(() => {
    if (selectedId && !pullRequests.some((pr) => pr.id === selectedId)) {
      setSelectedId(null);
    }
  }, [pullRequests, selectedId]);

  // Clear a stale repo filter once its repo no longer has open PRs.
  useEffect(() => {
    if (repoFilter && !repos.some((repo) => repo.projectKey === repoFilter)) {
      setRepoFilter(null);
    }
  }, [repoFilter, repos]);

  const repoFilterControl = useMemo(
    () => <RepoFilter repos={repos} value={repoFilter} onChange={setRepoFilter} />,
    [repos, repoFilter],
  );

  const handleSelect = useCallback((pr: DashboardPullRequest) => {
    if (!pr.workspace) {
      return;
    }
    // Desktop has no in-pane close button, so re-selecting the open PR dismisses
    // the review pane.
    setSelectedId((current) => (current === pr.id ? null : pr.id));
  }, []);

  const handleCloseReview = useCallback(() => setSelectedId(null), []);

  if (isLoading && pullRequests.length === 0 && !repoFilter) {
    return (
      <View style={styles.container}>
        <MenuHeader title={t("sidebar.sections.dashboard")} />
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinnerColor.color} />
        </View>
      </View>
    );
  }

  const board = (
    <PullRequestBoard
      pullRequests={pullRequests}
      selectedId={selectedId}
      isCompact={isCompact}
      hasError={hasError}
      onSelect={handleSelect}
      onRefresh={refetch}
    />
  );

  // Compact: board is the full screen; selecting a PR overlays the Explorer
  // full-screen, mirroring how a workspace opens the explorer on mobile.
  if (isCompact) {
    return (
      <View style={styles.container}>
        <MenuHeader title={t("sidebar.sections.dashboard")} />
        {reviewablePr ? (
          <PullRequestReview pr={reviewablePr} isCompact onClose={handleCloseReview} />
        ) : (
          <View style={styles.mainColumn}>
            <View style={styles.filterBar}>{repoFilterControl}</View>
            {board}
          </View>
        )}
      </View>
    );
  }

  // Desktop: board is the main column (like chat); the Explorer opens to the
  // right when a PR with a workspace is selected.
  return (
    <View style={styles.container}>
      <MenuHeader title={t("sidebar.sections.dashboard")} rightContent={repoFilterControl} />
      <View style={styles.body}>
        <View style={styles.mainColumn}>{board}</View>
        {reviewablePr ? (
          <View style={styles.reviewPane}>
            <PullRequestReview pr={reviewablePr} isCompact={false} onClose={handleCloseReview} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function RepoFilter({
  repos,
  value,
  onChange,
}: {
  repos: DashboardRepoOption[];
  value: string | null;
  onChange: (projectKey: string | null) => void;
}) {
  const { theme } = useUnistyles();
  const selectedRepo = useMemo(
    () => (value ? (repos.find((repo) => repo.projectKey === value) ?? null) : null),
    [repos, value],
  );
  const handleSelectAll = useCallback(() => onChange(null), [onChange]);

  if (repos.length === 0) {
    return null;
  }

  const triggerLabel = selectedRepo ? selectedRepo.projectName : "All repos";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={`Filter by repo: ${triggerLabel}`}
        testID="dashboard-repo-filter"
      >
        <Text style={styles.filterTriggerText} numberOfLines={1}>
          {triggerLabel}
        </Text>
        <ChevronDown size={14} color={theme.colors.foregroundMuted} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={260}>
        <DropdownMenuItem selected={value === null} onSelect={handleSelectAll}>
          All repos
        </DropdownMenuItem>
        {repos.map((repo) => (
          <RepoFilterItem
            key={repo.projectKey}
            repo={repo}
            selected={value === repo.projectKey}
            onSelect={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RepoFilterItem({
  repo,
  selected,
  onSelect,
}: {
  repo: DashboardRepoOption;
  selected: boolean;
  onSelect: (projectKey: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(repo.projectKey), [onSelect, repo.projectKey]);
  return (
    <DropdownMenuItem
      selected={selected}
      description={`${repo.count} open`}
      onSelect={handleSelect}
    >
      {repo.projectName}
    </DropdownMenuItem>
  );
}

function PullRequestBoard({
  pullRequests,
  selectedId,
  isCompact,
  hasError,
  onSelect,
  onRefresh,
}: {
  pullRequests: DashboardPullRequest[];
  selectedId: string | null;
  isCompact: boolean;
  hasError: boolean;
  onSelect: (pr: DashboardPullRequest) => void;
  onRefresh: () => void;
}) {
  if (pullRequests.length === 0) {
    return (
      <View style={styles.emptyState}>
        <GitPullRequest size={28} color={styles.emptyIcon.color} />
        <Text style={styles.emptyTitle}>No open pull requests</Text>
        <Text style={styles.emptyText}>
          {hasError
            ? "Couldn't load pull requests from one or more projects"
            : "Open PRs across your projects will show up here"}
        </Text>
        <Button size="sm" variant="outline" onPress={onRefresh}>
          Refresh
        </Button>
      </View>
    );
  }

  return (
    <ScrollView horizontal={!isCompact} contentContainerStyle={styles.boardScroll}>
      {COLUMNS.map((column) => {
        const columnItems = pullRequests.filter((pr) => pr.column === column.id);
        return (
          <View key={column.id} style={isCompact ? styles.compactColumn : styles.column}>
            <View style={styles.columnHeader}>
              <Text style={styles.columnTitle}>{column.label}</Text>
              <Text style={styles.columnCount}>{columnItems.length}</Text>
            </View>
            <View style={styles.columnCards}>
              {columnItems.map((pr) => (
                <PullRequestCard
                  key={pr.id}
                  pr={pr}
                  isSelected={pr.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

function PullRequestCard({
  pr,
  isSelected,
  onSelect,
}: {
  pr: DashboardPullRequest;
  isSelected: boolean;
  onSelect: (pr: DashboardPullRequest) => void;
}) {
  const handlePress = useCallback(() => onSelect(pr), [pr, onSelect]);
  const openPr = useCallback(() => {
    void openExternalUrl(pr.url);
  }, [pr.url]);
  const workspaceId = pr.workspace?.workspaceId ?? null;
  const openWorkspace = useCallback(() => {
    if (!workspaceId) {
      return;
    }
    const route = buildHostWorkspaceRoute(pr.serverId, workspaceId);
    if (isWeb && route !== "/") {
      window.open(route, "_blank", "noopener,noreferrer");
      return;
    }
    router.navigate(route);
  }, [pr.serverId, workspaceId]);

  const isReviewable = pr.workspace !== null;
  const cardStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.card,
      isSelected && styles.cardSelected,
      hovered && !isSelected && styles.cardHovered,
      pressed && styles.cardPressed,
    ],
    [isSelected],
  );

  return (
    <Pressable
      style={cardStyle}
      onPress={isReviewable ? handlePress : undefined}
      accessibilityRole={isReviewable ? "button" : undefined}
    >
      <View style={styles.cardTopRow}>
        <Text style={styles.cardNumber}>#{pr.number}</Text>
        <StatusBadge label={pr.badge.label} variant={pr.badge.variant} />
      </View>
      <Text style={styles.cardTitle} numberOfLines={3}>
        {pr.title}
      </Text>
      <Text style={styles.cardMeta} numberOfLines={1}>
        {pr.projectName} · {pr.serverName}
      </Text>
      <Text style={styles.cardMeta} numberOfLines={1}>
        {pr.headRefName} → {pr.baseRefName}
      </Text>
      <View style={styles.cardActions}>
        <IconButton icon={ExternalLink} label="GitHub" onPress={openPr} />
        {pr.workspace ? (
          <IconButton icon={PanelRightOpen} label="Workspace" onPress={openWorkspace} />
        ) : null}
      </View>
      {!isReviewable ? (
        <Text style={styles.cardHint}>No workspace — open on GitHub to review</Text>
      ) : null}
    </Pressable>
  );
}

function IconButton({
  icon,
  label,
  onPress,
}: {
  icon: ComponentType<{ size: number; color: string }>;
  label: string;
  onPress: () => void;
}) {
  return (
    <Button size="xs" variant="ghost" leftIcon={icon} onPress={onPress}>
      {label}
    </Button>
  );
}

function PullRequestReview({
  pr,
  isCompact,
  onClose,
}: {
  pr: DashboardPullRequest;
  isCompact: boolean;
  onClose: () => void;
}) {
  const workspace = pr.workspace;
  const [activeTab, setActiveTab] = useState<ExplorerTab>("changes");
  const handleOpenFile = useCallback(
    (_filePath: string) => {
      if (!workspace) {
        return;
      }
      const route = buildHostWorkspaceRoute(pr.serverId, workspace.workspaceId);
      if (isWeb && route !== "/") {
        window.open(route, "_blank", "noopener,noreferrer");
        return;
      }
      router.navigate(route);
    },
    [pr.serverId, workspace],
  );

  if (!workspace) {
    return null;
  }

  return (
    <ExplorerSidebarContent
      activeTab={activeTab}
      onTabPress={setActiveTab}
      onClose={onClose}
      serverId={pr.serverId}
      workspaceId={workspace.workspaceId}
      workspaceRoot={workspace.workspaceDirectory}
      isGit
      isMobile={isCompact}
      isOpen
      onOpenFile={handleOpenFile}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  body: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  mainColumn: {
    flex: 1,
    minWidth: 0,
  },
  filterBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    maxWidth: 220,
  },
  filterTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  filterTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  reviewPane: {
    width: 480,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  boardScroll: {
    flexGrow: 1,
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  column: {
    width: 300,
    gap: theme.spacing[2],
  },
  compactColumn: {
    gap: theme.spacing[2],
  },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[1],
  },
  columnTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  columnCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  columnCards: {
    gap: theme.spacing[2],
  },
  card: {
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardSelected: {
    backgroundColor: theme.colors.surface2,
  },
  cardHovered: {
    backgroundColor: theme.colors.surface2,
  },
  cardPressed: {
    opacity: 0.8,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  cardNumber: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 20,
  },
  cardMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  cardHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

function triggerStyle({ hovered }: { pressed: boolean; hovered: boolean; open: boolean }) {
  return [styles.filterTrigger, hovered && styles.filterTriggerHovered];
}
