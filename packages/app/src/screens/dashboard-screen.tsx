import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type PressableStateCallbackType,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  CircleX,
  Globe,
  GitPullRequest,
  MessageSquareText,
  TriangleAlert,
} from "lucide-react-native";
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
import { ProjectIconView } from "@/components/project-icon-view";
import {
  usePanelStore,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  MAX_EXPLORER_SIDEBAR_WIDTH,
  type ExplorerTab,
} from "@/stores/panel-store";
import {
  useDashboardPullRequests,
  type DashboardPrBadge,
  type DashboardPrColumn,
  type DashboardPreviewLink,
  type DashboardPullRequest,
  type DashboardRepoOption,
} from "@/dashboard/use-dashboard-pull-requests";
import { GithubPrDiffPane } from "@/dashboard/github-pr-diff-pane";
import { useProjectIconDataByProjectKey } from "@/projects/project-icons";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { openExternalUrl } from "@/utils/open-external-url";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { formatTimeAgo } from "@/utils/time";
import { isWeb } from "@/constants/platform";
import { SlackIcon } from "@/components/icons/slack-icon";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";

// Status dot accessibility labels, keyed by the PR's derived column.
const STATUS_LABELS: Record<DashboardPrColumn, string> = {
  review: "Ready for review",
  blocked: "Blocked",
  draft: "Draft",
};

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedGlobe = withUnistyles(Globe);
const ThemedMessageSquareText = withUnistyles(MessageSquareText);
const ThemedTriangleAlert = withUnistyles(TriangleAlert);
const ThemedCircleX = withUnistyles(CircleX);

const mutedIconUniProps = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerIconUniProps = (theme: Theme) => ({ color: theme.colors.statusDanger });
const blueIconUniProps = (theme: Theme) => ({ color: theme.colors.palette.blue[500] });

// Devin's GitHub App avatar; hoisted so the <Image> source is a stable reference.
const DEVIN_AVATAR_SOURCE = {
  uri: "https://avatars.githubusercontent.com/in/811515?s=80&v=4",
} as const;

type IconByProjectKey = Map<string, string | null>;

export function DashboardScreen() {
  const { t } = useTranslation();
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const { pullRequests, repos, iconTargets, isLoading, isFetching, hasError, refetch } =
    useDashboardPullRequests({ repoFilter });
  const iconByProjectKey = useProjectIconDataByProjectKey({ projects: iconTargets });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isCompact = useIsCompactFormFactor();

  const selectedPr = pullRequests.find((pr) => pr.id === selectedId) ?? null;

  // Drop the selection once the PR is truly gone from the board (merged/closed).
  // Never drop while loading or refetching — mid-refresh the list can be
  // transiently empty/partial and closing the review pane then feels like a bug.
  useEffect(() => {
    if (isLoading || isFetching) {
      return;
    }
    if (selectedId && !pullRequests.some((pr) => pr.id === selectedId)) {
      setSelectedId(null);
    }
  }, [isFetching, isLoading, pullRequests, selectedId]);

  // Clear a stale repo filter once its repo no longer has open PRs.
  useEffect(() => {
    if (isLoading || isFetching) {
      return;
    }
    if (repoFilter && !repos.some((repo) => repo.projectKey === repoFilter)) {
      setRepoFilter(null);
    }
  }, [isFetching, isLoading, repoFilter, repos]);

  const repoFilterControl = useMemo(
    () => <RepoFilter repos={repos} value={repoFilter} onChange={setRepoFilter} />,
    [repos, repoFilter],
  );

  // Re-selecting the open PR dismisses the review pane.
  const handleSelect = useCallback((pr: DashboardPullRequest) => {
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
      iconByProjectKey={iconByProjectKey}
      selectedId={selectedId}
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
        {selectedPr ? (
          <PullRequestReviewPane pr={selectedPr} isCompact onClose={handleCloseReview} />
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
        {selectedPr ? (
          <ResizableReviewPane>
            <PullRequestReviewPane pr={selectedPr} isCompact={false} onClose={handleCloseReview} />
          </ResizableReviewPane>
        ) : null}
      </View>
    </View>
  );
}

// Minimum width the PR board keeps when the review pane is resized wider.
const MIN_BOARD_WIDTH = 400;

/**
 * Desktop review pane wrapper with a draggable left-edge resize handle. Width
 * is the shared `explorerWidth` (same store as the workspace explorer
 * sidebar), so resizing here and in a workspace feels like one surface.
 */
function ResizableReviewPane({ children }: { children: React.ReactNode }) {
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const startWidthRef = useRef(explorerWidth);
  const resizeWidth = useSharedValue(explorerWidth);

  useEffect(() => {
    resizeWidth.value = explorerWidth;
  }, [explorerWidth, resizeWidth]);

  useEffect(() => {
    const maxWidth = Math.max(
      MIN_EXPLORER_SIDEBAR_WIDTH,
      Math.min(MAX_EXPLORER_SIDEBAR_WIDTH, viewportWidth - MIN_BOARD_WIDTH),
    );
    if (explorerWidth > maxWidth) {
      setExplorerWidth(maxWidth);
    }
  }, [explorerWidth, setExplorerWidth, viewportWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = explorerWidth;
          resizeWidth.value = explorerWidth;
        })
        .onUpdate((event) => {
          const newWidth = startWidthRef.current - event.translationX;
          const maxWidth = Math.max(
            MIN_EXPLORER_SIDEBAR_WIDTH,
            Math.min(MAX_EXPLORER_SIDEBAR_WIDTH, viewportWidth - MIN_BOARD_WIDTH),
          );
          const clampedWidth = Math.max(MIN_EXPLORER_SIDEBAR_WIDTH, Math.min(maxWidth, newWidth));
          resizeWidth.value = clampedWidth;
        })
        .onEnd(() => {
          runOnJS(setExplorerWidth)(resizeWidth.value);
        }),
    [explorerWidth, resizeWidth, setExplorerWidth, viewportWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));
  const paneStyle = useMemo(() => [styles.reviewPane, resizeAnimatedStyle], [resizeAnimatedStyle]);

  return (
    <Animated.View style={paneStyle}>
      <GestureDetector gesture={resizeGesture}>
        <View style={reviewResizeHandleStyle} />
      </GestureDetector>
      {children}
    </Animated.View>
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
        <ThemedChevronDown size={14} uniProps={mutedIconUniProps} />
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
  iconByProjectKey,
  selectedId,
  hasError,
  onSelect,
  onRefresh,
}: {
  pullRequests: DashboardPullRequest[];
  iconByProjectKey: IconByProjectKey;
  selectedId: string | null;
  hasError: boolean;
  onSelect: (pr: DashboardPullRequest) => void;
  onRefresh: () => void;
}) {
  if (pullRequests.length === 0) {
    return (
      <View style={styles.emptyState}>
        <ThemedGitPullRequest size={28} uniProps={mutedIconUniProps} />
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
    <ScrollView contentContainerStyle={styles.listScroll}>
      <View style={styles.listContent}>
        {pullRequests.map((pr) => (
          <PullRequestCard
            key={pr.id}
            pr={pr}
            iconDataUri={iconByProjectKey.get(pr.projectKey) ?? null}
            isSelected={pr.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function PullRequestCard({
  pr,
  iconDataUri,
  isSelected,
  onSelect,
}: {
  pr: DashboardPullRequest;
  iconDataUri: string | null;
  isSelected: boolean;
  onSelect: (pr: DashboardPullRequest) => void;
}) {
  const handlePress = useCallback(() => onSelect(pr), [pr, onSelect]);
  const workspaceId = pr.workspace?.workspaceId ?? null;
  const handleWorkspacePress = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      if (!workspaceId) {
        return;
      }
      const route = buildHostWorkspaceRoute(pr.serverId, workspaceId);
      if (isWeb && route !== "/") {
        window.open(route, "_blank", "noopener,noreferrer");
        return;
      }
      router.navigate(route);
    },
    [pr.serverId, workspaceId],
  );

  const cardStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.card,
      isSelected && styles.cardSelected,
      hovered && !isSelected && styles.cardHovered,
      pressed && styles.cardPressed,
    ],
    [isSelected],
  );

  const recencyLabel = useMemo(() => {
    const raw = pr.lastCommitAt ?? pr.createdAt;
    if (!raw) {
      return null;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : formatTimeAgo(date);
  }, [pr.lastCommitAt, pr.createdAt]);

  const hasChipsRow = pr.workspace !== null;

  return (
    <Pressable style={cardStyle} onPress={handlePress} accessibilityRole="button">
      <View style={styles.cardTopRow}>
        <ProjectIconView
          iconDataUri={iconDataUri}
          initial={projectIconPlaceholderLabelFromDisplayName(pr.projectName)}
          projectKey={pr.projectKey}
          imageStyle={styles.projectIconImage}
          fallbackStyle={styles.projectIconFallback}
          textStyle={styles.projectIconText}
        />
        <Text style={styles.cardProject} numberOfLines={1}>
          {pr.projectName}
        </Text>
        {pr.origin ? <SlackOriginIcon origin={pr.origin} /> : null}
        {pr.devin ? <DevinAvatar devin={pr.devin} /> : null}
        <View style={styles.cardTopSpacer} />
        {pr.badge ? <PullRequestBadge badge={pr.badge} /> : null}
        {recencyLabel ? <Text style={styles.cardRecency}>{recencyLabel}</Text> : null}
      </View>
      <Text style={styles.cardTitle} numberOfLines={3}>
        {pr.title}
      </Text>
      <View style={styles.cardMetaRow}>
        <View
          style={columnDotStyle(pr.column)}
          accessibilityRole="image"
          accessibilityLabel={STATUS_LABELS[pr.column]}
        />
        <PullRequestNumberLink number={pr.number} url={pr.url} />
        <Text style={styles.cardMeta} numberOfLines={1}>
          {pr.headRefName} → {pr.baseRefName}
        </Text>
        <DiffCounts additions={pr.additions} deletions={pr.deletions} />
      </View>
      {hasChipsRow ? (
        <View style={styles.cardChipsRow}>
          <View style={styles.cardChipsSpacer} />
          {pr.workspace ? (
            <Pressable
              style={iconButtonStyle}
              onPress={handleWorkspacePress}
              accessibilityRole="button"
              accessibilityLabel="Open workspace"
            >
              <ThemedMessageSquareText size={14} uniProps={blueIconUniProps} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {pr.previewLinks.map((link) => (
        <PreviewLinkRow key={link.url} link={link} />
      ))}
    </Pressable>
  );
}

function SlackOriginIcon({ origin }: { origin: NonNullable<DashboardPullRequest["origin"]> }) {
  const handlePress = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      if (origin.url) {
        void openExternalUrl(origin.url);
      }
    },
    [origin.url],
  );
  if (!origin.url) {
    return (
      <View accessibilityRole="image" accessibilityLabel="Started in Slack">
        <SlackIcon size={14} />
      </View>
    );
  }
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel="Open Slack thread"
    >
      <SlackIcon size={14} />
    </Pressable>
  );
}

function DevinAvatar({ devin }: { devin: NonNullable<DashboardPullRequest["devin"]> }) {
  const url = devin.url;
  const handlePress = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      if (url) {
        void openExternalUrl(url);
      }
    },
    [url],
  );
  if (!url) {
    return (
      <Image
        source={DEVIN_AVATAR_SOURCE}
        style={styles.devinAvatar}
        resizeMode="contain"
        accessibilityLabel="Authored by Devin"
      />
    );
  }
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel="Open Devin session"
    >
      <Image source={DEVIN_AVATAR_SOURCE} style={styles.devinAvatar} resizeMode="contain" />
    </Pressable>
  );
}

function PullRequestBadge({ badge }: { badge: DashboardPrBadge }) {
  if (badge.display === "pill") {
    return <StatusBadge label={badge.label} variant={badge.variant} />;
  }
  const Icon = badge.icon === "conflicts" ? ThemedTriangleAlert : ThemedCircleX;
  return (
    <View accessibilityRole="image" accessibilityLabel={badge.label}>
      <Icon size={15} uniProps={dangerIconUniProps} />
    </View>
  );
}

function DiffCounts({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  if (additions === null && deletions === null) {
    return null;
  }
  return (
    <View style={styles.diffCounts}>
      {additions !== null ? <Text style={styles.diffAddition}>+{additions}</Text> : null}
      {deletions !== null ? <Text style={styles.diffDeletion}>−{deletions}</Text> : null}
    </View>
  );
}

function previewLinkLabel(link: DashboardPreviewLink): string {
  if (link.projectName) {
    return link.projectName;
  }
  try {
    return new URL(link.url).hostname;
  } catch {
    return link.url;
  }
}

function PreviewLinkRow({ link }: { link: DashboardPreviewLink }) {
  const url = link.url;
  const handlePress = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      void openExternalUrl(url);
    },
    [url],
  );
  return (
    <Pressable
      style={previewLinkStyle}
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel={`Open preview ${previewLinkLabel(link)}`}
    >
      <ThemedGlobe size={12} uniProps={mutedIconUniProps} />
      <Text style={styles.previewLinkText} numberOfLines={1}>
        {previewLinkLabel(link)}
      </Text>
    </Pressable>
  );
}

function PullRequestNumberLink({ number, url }: { number: number; url: string }) {
  const handlePress = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      void openExternalUrl(url);
    },
    [url],
  );
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel={`Open pull request #${number} on GitHub`}
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <Text style={hovered ? styles.cardNumberHovered : styles.cardNumber}>#{number}</Text>
      )}
    </Pressable>
  );
}

// Routes a selected PR to the right review surface: PRs with a local Paseo
// checkout get the full explorer (diff + PR tabs); everything else gets the
// read-only GitHub-sourced diff pane, so no checkout is ever required.
function PullRequestReviewPane({
  pr,
  isCompact,
  onClose,
}: {
  pr: DashboardPullRequest;
  isCompact: boolean;
  onClose: () => void;
}) {
  if (pr.workspace) {
    return <PullRequestReview pr={pr} isCompact={isCompact} onClose={onClose} />;
  }
  return (
    <GithubPrDiffPane
      serverId={pr.serverId}
      cwd={pr.projectCwd}
      number={pr.number}
      title={pr.title}
      url={pr.url}
      onClose={onClose}
    />
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
  const [prCwd, setPrCwd] = useState<string | null>(null);
  const handleTabPress = useCallback((tab: ExplorerTab) => {
    setActiveTab(tab);
    setPrCwd(null);
  }, []);
  const handleSelectPr = useCallback((nextPrCwd: string | null) => {
    setActiveTab("pr");
    setPrCwd(nextPrCwd);
  }, []);
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
      prCwd={prCwd}
      onTabPress={handleTabPress}
      onSelectPr={handleSelectPr}
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
    position: "relative",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  reviewResizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 10,
  },
  listScroll: {
    padding: theme.spacing[3],
    paddingBottom: theme.spacing[8],
  },
  listContent: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    gap: theme.spacing[2],
  },
  columnDotDraft: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  columnDotReview: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccess,
  },
  columnDotBlocked: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
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
    gap: theme.spacing[2],
  },
  projectIconImage: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
  },
  projectIconFallback: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconText: {
    fontSize: 9,
    fontWeight: theme.fontWeight.medium,
  },
  cardProject: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  cardTopSpacer: {
    flexGrow: 1,
  },
  cardRecency: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  devinAvatar: {
    width: 16,
    height: 14,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 20,
  },
  cardMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardNumber: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  cardNumberHovered: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    textDecorationLine: "underline",
  },
  cardMeta: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  diffCounts: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[1],
    marginLeft: "auto",
    paddingLeft: theme.spacing[2],
  },
  diffAddition: {
    color: theme.colors.diffAddition,
    fontSize: theme.fontSize.xs,
  },
  diffDeletion: {
    color: theme.colors.diffDeletion,
    fontSize: theme.fontSize.xs,
  },
  cardChipsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingTop: theme.spacing[1],
  },
  cardChipsSpacer: {
    flexGrow: 1,
  },
  previewLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    alignSelf: "flex-start",
    maxWidth: "100%",
    borderRadius: theme.borderRadius.sm,
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[1],
    marginHorizontal: -theme.spacing[1],
  },
  previewLinkHovered: {
    backgroundColor: theme.colors.surface2,
  },
  previewLinkText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  iconButton: {
    padding: 2,
    borderRadius: 4,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
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

function columnDotStyle(column: DashboardPrColumn) {
  switch (column) {
    case "draft":
      return styles.columnDotDraft;
    case "review":
      return styles.columnDotReview;
    case "blocked":
      return styles.columnDotBlocked;
  }
}

function triggerStyle({ hovered }: { pressed: boolean; hovered: boolean; open: boolean }) {
  return [styles.filterTrigger, hovered && styles.filterTriggerHovered];
}

function previewLinkStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.previewLink, hovered && styles.previewLinkHovered];
}

function iconButtonStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.iconButton, hovered && styles.iconButtonHovered];
}

const reviewResizeHandleStyle = [
  styles.reviewResizeHandle,
  isWeb && ({ cursor: "col-resize" } as object),
];
