import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  useWindowDimensions,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatPrTabLabel,
  PullRequestPane,
  PullRequestPaneError,
  PullRequestPaneSkeleton,
  PullRequestTabIcon,
  usePrPaneData,
} from "@/git/pull-request-panel";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import type { UsePrPaneDataResult } from "@/git/pull-request-panel/use-data";
import {
  usePanelStore,
  selectIsFileExplorerOpen,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  MAX_EXPLORER_SIDEBAR_WIDTH,
  type ExplorerTab,
} from "@/stores/panel-store";
import { useExplorerSidebarAnimation } from "@/contexts/explorer-sidebar-animation-context";
import { useSidebarAnimation } from "@/contexts/sidebar-animation-context";
import { useToast } from "@/contexts/toast-context";
import { canCloseRightSidebarGesture } from "@/utils/sidebar-animation-state";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { GitDiffPane } from "@/git/diff-pane";
import { FileExplorerPane } from "./file-explorer-pane";
import { ExplorerSubagentsPane } from "./explorer-subagents-pane";
import { useSubagentPrTabsForWorkspace, useWorkspaceOwnPrIdentity } from "@/subagents";
import { buildSubagentPrTabs, type SubagentPrTab } from "@/git/explorer-pr-tabs";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { isWeb } from "@/constants/platform";
import { buildWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";

const MIN_CHAT_WIDTH = 400;
function logExplorerSidebar(_event: string, _details: Record<string, unknown>): void {}

interface ExplorerSidebarProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  onOpenFile?: (filePath: string) => void;
}

interface ExplorerSidebarSharedState {
  explorerTab: ExplorerTab;
  explorerPrCwd: string | null;
  handleTabPress: (tab: ExplorerTab) => void;
  handleSelectPr: (prCwd: string | null) => void;
}

export function useExplorerSidebarSharedState({
  serverId,
  workspaceRoot,
  isGit,
}: Pick<ExplorerSidebarProps, "serverId" | "workspaceRoot" | "isGit">): ExplorerSidebarSharedState {
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const explorerPrCwd = usePanelStore((state) => state.explorerPrCwd);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const selectExplorerPr = usePanelStore((state) => state.selectExplorerPr);
  const handleTabPress = useCallback(
    (tab: ExplorerTab) => {
      setExplorerTabForCheckout({ serverId, cwd: workspaceRoot, isGit, tab });
    },
    [isGit, serverId, setExplorerTabForCheckout, workspaceRoot],
  );
  const handleSelectPr = useCallback(
    (prCwd: string | null) => {
      selectExplorerPr({ serverId, cwd: workspaceRoot, isGit, prCwd });
    },
    [isGit, selectExplorerPr, serverId, workspaceRoot],
  );

  return { explorerTab, explorerPrCwd, handleTabPress, handleSelectPr };
}

export function CompactExplorerSidebar({
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
}: ExplorerSidebarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: true }));
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const { explorerTab, explorerPrCwd, handleTabPress, handleSelectPr } =
    useExplorerSidebarSharedState({
      serverId,
      workspaceRoot,
      isGit,
    });
  const closeTouchStartX = useSharedValue(0);
  const closeTouchStartY = useSharedValue(0);
  const { mobilePanelState, gestureAnimatingRef: mobilePanelGestureAnimatingRef } =
    useSidebarAnimation();
  const { style: mobileKeyboardInsetStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: true,
  });
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    overlayVisible,
    isGesturing,
    gestureAnimatingRef,
    closeGestureRef,
  } = useExplorerSidebarAnimation();

  const handleClose = useCallback(
    (reason: string) => {
      logExplorerSidebar("handleClose", {
        reason,
        isOpen,
      });
      showMobileAgent();
    },
    [isOpen, showMobileAgent],
  );

  const handleCloseFromGesture = useCallback(() => {
    gestureAnimatingRef.current = true;
    mobilePanelGestureAnimatingRef.current = true;
    showMobileAgent();
  }, [gestureAnimatingRef, mobilePanelGestureAnimatingRef, showMobileAgent]);

  const handleHeaderClose = useCallback(() => handleClose("header-close-button"), [handleClose]);

  // Swipe gesture to close (swipe right on mobile)
  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(closeGestureRef)
        .enabled(true)
        // Use manual activation so child views keep touch streams
        // unless we detect an intentional right-swipe close.
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (!touch) {
            return;
          }
          closeTouchStartX.value = touch.absoluteX;
          closeTouchStartY.value = touch.absoluteY;
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }

          const deltaX = touch.absoluteX - closeTouchStartX.value;
          const deltaY = touch.absoluteY - closeTouchStartY.value;
          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);

          if (!canCloseRightSidebarGesture(mobilePanelState.value)) {
            stateManager.fail();
            return;
          }

          // Fail quickly on clear leftward or vertical intent so child views keep control.
          if (deltaX <= -10) {
            stateManager.fail();
            return;
          }
          if (absDeltaY > 10 && absDeltaY > absDeltaX) {
            stateManager.fail();
            return;
          }

          // Activate only on intentional rightward movement.
          if (deltaX >= 15 && absDeltaX > absDeltaY) {
            stateManager.activate();
          }
        })
        .onStart(() => {
          isGesturing.value = true;
        })
        .onUpdate((event) => {
          // Right sidebar: swipe right to close (positive translationX)
          const newTranslateX = Math.max(0, Math.min(windowWidth, event.translationX));
          translateX.value = newTranslateX;
          const progress = 1 - newTranslateX / windowWidth;
          backdropOpacity.value = Math.max(0, Math.min(1, progress));
        })
        .onEnd((event) => {
          isGesturing.value = false;
          const shouldClose = event.translationX > windowWidth / 3 || event.velocityX > 500;
          runOnJS(logExplorerSidebar)("closeGestureEnd", {
            translationX: event.translationX,
            velocityX: event.velocityX,
            shouldClose,
            windowWidth,
          });
          if (shouldClose) {
            animateToClose();
            runOnJS(handleCloseFromGesture)();
          } else {
            animateToOpen();
          }
        })
        .onFinalize(() => {
          isGesturing.value = false;
        }),
    [
      windowWidth,
      translateX,
      backdropOpacity,
      mobilePanelState,
      animateToOpen,
      animateToClose,
      handleCloseFromGesture,
      isGesturing,
      closeGestureRef,
      closeTouchStartX,
      closeTouchStartY,
    ],
  );

  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const backdropCombinedStyle = useMemo(
    () => [
      explorerStaticStyles.backdrop,
      backdropAnimatedStyle,
      // pointerEvents is React-owned, not worklet-owned: Reanimated never
      // touches it, so a stale animated-prop revert can't wedge an invisible
      // tap-eating backdrop.
      { pointerEvents: isOpen ? ("auto" as const) : ("none" as const) },
    ],
    [backdropAnimatedStyle, isOpen],
  );
  const mobileSidebarStyle = useMemo(
    () => [
      explorerStaticStyles.mobileSidebar,
      {
        width: windowWidth,
        paddingTop: insets.top,
        backgroundColor: theme.colors.surfaceSidebar,
      },
      sidebarAnimatedStyle,
      mobileKeyboardInsetStyle,
    ],
    [
      windowWidth,
      insets.top,
      theme.colors.surfaceSidebar,
      sidebarAnimatedStyle,
      mobileKeyboardInsetStyle,
    ],
  );
  // display is React-owned on the plain wrapper View (no animated styles), so
  // a hidden overlay stays hidden no matter what Reanimated's Fabric overlay
  // reverts the panel transform to after a heavy commit (reanimated#9635).
  const overlayStyle = useMemo(
    () => [
      StyleSheet.absoluteFillObject,
      { display: overlayVisible ? ("flex" as const) : ("none" as const) },
    ],
    [overlayVisible],
  );

  // Mobile: full-screen overlay with gesture.
  // On web, keep it interactive only while open so closed sidebars don't eat taps.
  let overlayPointerEvents: "auto" | "none" | "box-none";
  if (!isWeb) overlayPointerEvents = "box-none";
  else if (isOpen) overlayPointerEvents = "auto";
  else overlayPointerEvents = "none";

  return (
    <View style={overlayStyle} pointerEvents={overlayPointerEvents}>
      <Animated.View style={backdropCombinedStyle} />

      <GestureDetector gesture={closeGesture} touchAction="pan-y">
        <Animated.View style={mobileSidebarStyle} pointerEvents="auto">
          <ExplorerSidebarContent
            activeTab={explorerTab}
            prCwd={explorerPrCwd}
            onTabPress={handleTabPress}
            onSelectPr={handleSelectPr}
            onClose={handleHeaderClose}
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={workspaceRoot}
            isGit={isGit}
            isMobile
            isOpen={isOpen}
            onOpenFile={onOpenFile}
          />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export function ExplorerSidebar({
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
}: ExplorerSidebarProps) {
  const insets = useSafeAreaInsets();
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: false }));
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const { explorerTab, explorerPrCwd, handleTabPress, handleSelectPr } =
    useExplorerSidebarSharedState({
      serverId,
      workspaceRoot,
      isGit,
    });
  const { width: viewportWidth } = useWindowDimensions();
  const startWidthRef = useRef(explorerWidth);
  const resizeWidth = useSharedValue(explorerWidth);

  useEffect(() => {
    const maxWidth = Math.max(
      MIN_EXPLORER_SIDEBAR_WIDTH,
      Math.min(MAX_EXPLORER_SIDEBAR_WIDTH, viewportWidth - MIN_CHAT_WIDTH),
    );
    if (explorerWidth > maxWidth) {
      setExplorerWidth(maxWidth);
    }
  }, [explorerWidth, setExplorerWidth, viewportWidth]);

  const handleDesktopClose = useCallback(() => {
    logExplorerSidebar("handleClose", {
      reason: "desktop-close-button",
      isOpen,
    });
    closeDesktopFileExplorer();
  }, [closeDesktopFileExplorer, isOpen]);

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
            Math.min(MAX_EXPLORER_SIDEBAR_WIDTH, viewportWidth - MIN_CHAT_WIDTH),
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
  const desktopSidebarStyle = useMemo(
    () => [explorerStaticStyles.desktopSidebar, resizeAnimatedStyle, { paddingTop: insets.top }],
    [resizeAnimatedStyle, insets.top],
  );

  if (!isOpen) {
    return null;
  }

  return (
    <Animated.View style={desktopSidebarStyle}>
      <View style={DESKTOP_SIDEBAR_BORDER_STYLE}>
        <GestureDetector gesture={resizeGesture}>
          <View style={RESIZE_HANDLE_STYLE} />
        </GestureDetector>

        <ExplorerSidebarContent
          activeTab={explorerTab}
          prCwd={explorerPrCwd}
          onTabPress={handleTabPress}
          onSelectPr={handleSelectPr}
          onClose={handleDesktopClose}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot}
          isGit={isGit}
          isMobile={false}
          isOpen={isOpen}
          onOpenFile={onOpenFile}
        />
      </View>
    </Animated.View>
  );
}

interface ExplorerTabButtonProps {
  tab: ExplorerTab;
  active: boolean;
  label?: string;
  onTabPress: (tab: ExplorerTab) => void;
  testID: string;
  children?: React.ReactNode;
}

function ExplorerTabButton({
  tab,
  active,
  label,
  onTabPress,
  testID,
  children,
}: ExplorerTabButtonProps) {
  const handlePress = useCallback(() => onTabPress(tab), [onTabPress, tab]);
  const tabStyle = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const tabTextStyle = useMemo(() => [styles.tabText, active && styles.tabTextActive], [active]);
  return (
    <Pressable testID={testID} style={tabStyle} onPress={handlePress}>
      {children}
      {label !== undefined ? <Text style={tabTextStyle}>{label}</Text> : null}
    </Pressable>
  );
}

interface SidebarContentProps {
  activeTab: ExplorerTab;
  // Which checkout the PR pane targets while the active tab is "pr": `null` =
  // the workspace's own PR, otherwise a subagent's cwd.
  prCwd: string | null;
  onTabPress: (tab: ExplorerTab) => void;
  onSelectPr: (prCwd: string | null) => void;
  onClose: () => void;
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  isMobile: boolean;
  isOpen: boolean;
  onOpenFile?: (filePath: string) => void;
}

// Resolve which explorer tab actually renders given the checkout's capabilities.
// A non-git checkout has no Changes/PR tabs; the PR tab disappears once there is
// no pull request to show. Falls back to the checkout's default tab.
function resolveVisibleExplorerTab(input: {
  activeTab: ExplorerTab;
  isGit: boolean;
  showPrTab: boolean;
}): ExplorerTab {
  const { activeTab, isGit, showPrTab } = input;
  const defaultTab: ExplorerTab = isGit ? "changes" : "files";
  if (!isGit && (activeTab === "changes" || activeTab === "pr")) {
    return "files";
  }
  if (activeTab === "pr" && !showPrTab) {
    return defaultTab;
  }
  return activeTab;
}

interface ExplorerPrTabState {
  inlineSubagentPrTabs: SubagentPrTab[];
  workspacePrPane: UsePrPaneDataResult;
  showWorkspacePrTab: boolean;
  resolvedTab: ExplorerTab;
  workspacePrTabLabel: string;
  activeSubagentPrTab: SubagentPrTab | null;
  isWorkspacePrActive: boolean;
}

// Derives the PR-tab strip state: the workspace's own PR pane/tab plus the
// de-duped, capped subagent PR tabs, and which PR (if any) is currently active.
// Subagent PR identity comes from each subagent's own workspace descriptor in
// the store, so this fires no new requests; the live PR query only runs for the
// workspace's own PR and the one open subagent PR pane.
function useExplorerPrTabState(input: {
  activeTab: ExplorerTab;
  prCwd: string | null;
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  isOpen: boolean;
}): ExplorerPrTabState {
  const { activeTab, prCwd, serverId, workspaceId, workspaceRoot, isGit, isOpen } = input;
  const canQueryPullRequest = isGit && Boolean(workspaceRoot);

  const workspaceOwnPr = useWorkspaceOwnPrIdentity({ serverId, workspaceId: workspaceId ?? "" });
  const subagentPrInputs = useSubagentPrTabsForWorkspace({
    serverId,
    workspaceId: workspaceId ?? "",
  });
  const inlineSubagentPrTabs = useMemo(
    () =>
      buildSubagentPrTabs({
        workspacePr: workspaceOwnPr,
        workspaceCwd: workspaceRoot,
        subagentPrs: subagentPrInputs,
      }).inline,
    [subagentPrInputs, workspaceOwnPr, workspaceRoot],
  );

  const workspacePrPane = usePrPaneData({
    serverId,
    cwd: workspaceRoot,
    enabled: canQueryPullRequest && isOpen,
    timelineEnabled: activeTab === "pr" && prCwd === null && canQueryPullRequest && isOpen,
  });
  const hasPullRequest = workspacePrPane.prNumber !== null;
  const showWorkspacePrTab =
    hasPullRequest || (activeTab === "pr" && prCwd === null && workspacePrPane.isLoading);
  const showAnyPrTab = showWorkspacePrTab || inlineSubagentPrTabs.length > 0;
  const resolvedTab = resolveVisibleExplorerTab({ activeTab, isGit, showPrTab: showAnyPrTab });

  const activeSubagentPrTab =
    resolvedTab === "pr" && prCwd !== null
      ? (inlineSubagentPrTabs.find((tab) => tab.cwd === prCwd) ?? null)
      : null;

  return {
    inlineSubagentPrTabs,
    workspacePrPane,
    showWorkspacePrTab,
    resolvedTab,
    workspacePrTabLabel: formatPrTabLabel(workspacePrPane.prNumber),
    activeSubagentPrTab,
    isWorkspacePrActive: resolvedTab === "pr" && activeSubagentPrTab === null,
  };
}

export function ExplorerSidebarContent({
  activeTab,
  prCwd,
  onTabPress,
  onSelectPr,
  onClose,
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  isMobile,
  isOpen,
  onOpenFile,
}: SidebarContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const toast = useToast();
  const padding = useWindowControlsPadding("explorerSidebar");

  const {
    inlineSubagentPrTabs,
    workspacePrPane,
    showWorkspacePrTab,
    resolvedTab,
    workspacePrTabLabel,
    activeSubagentPrTab,
    isWorkspacePrActive,
  } = useExplorerPrTabState({
    activeTab,
    prCwd,
    serverId,
    workspaceId,
    workspaceRoot,
    isGit,
    isOpen,
  });

  const workspaceAttachmentScopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd: workspaceRoot }),
    [serverId, workspaceId, workspaceRoot],
  );

  const headerStyle = useMemo(
    () => [styles.header, { paddingRight: padding.right }],
    [padding.right],
  );

  const handleWorkspacePrPress = useCallback(() => onSelectPr(null), [onSelectPr]);
  const refreshGitActions = useCheckoutGitActionsStore((s) => s.refresh);
  const handleWorkspacePrRetry = useCallback(() => {
    refreshGitActions({ serverId, cwd: workspaceRoot }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [refreshGitActions, serverId, t, toast, workspaceRoot]);

  return (
    <View style={styles.sidebarContent} pointerEvents="auto">
      {/* Header with tabs and close button */}
      <View style={headerStyle} testID="explorer-header">
        <TitlebarDragRegion />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsContainer}
        >
          {isGit && (
            <ExplorerTabButton
              tab="changes"
              active={resolvedTab === "changes"}
              label={t("workspace.tabs.explorer.changes")}
              onTabPress={onTabPress}
              testID="explorer-tab-changes"
            />
          )}
          <ExplorerTabButton
            tab="files"
            active={resolvedTab === "files"}
            label={t("workspace.tabs.explorer.files")}
            onTabPress={onTabPress}
            testID="explorer-tab-files"
          />
          <ExplorerTabButton
            tab="subagents"
            active={resolvedTab === "subagents"}
            label={t("workspace.tabs.explorer.subagents")}
            onTabPress={onTabPress}
            testID="explorer-tab-subagents"
          />
          {isGit && showWorkspacePrTab && (
            <ExplorerPrTabButton
              active={isWorkspacePrActive}
              label={workspacePrTabLabel}
              activeColor={theme.colors.foreground}
              inactiveColor={theme.colors.foregroundMuted}
              onPress={handleWorkspacePrPress}
              testID="explorer-tab-pr"
            />
          )}
          {isGit &&
            inlineSubagentPrTabs.map((prTab) => (
              <SubagentPrTabButton
                key={prTab.key}
                prTab={prTab}
                active={activeSubagentPrTab?.cwd === prTab.cwd}
                activeColor={theme.colors.foreground}
                inactiveColor={theme.colors.foregroundMuted}
                onSelectPr={onSelectPr}
              />
            ))}
        </ScrollView>
        <View style={styles.headerRightSection}>
          {isMobile && (
            <Pressable onPress={onClose} style={styles.closeButton}>
              <X size={18} color={theme.colors.foregroundMuted} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Content based on active tab */}
      <View style={styles.contentArea} testID="explorer-content-area">
        {resolvedTab === "changes" && (
          <GitDiffPane
            serverId={serverId}
            workspaceId={workspaceId}
            cwd={workspaceRoot}
            enabled={isOpen}
          />
        )}
        {resolvedTab === "files" && (
          <FileExplorerPane
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={workspaceRoot}
            onOpenFile={onOpenFile}
          />
        )}
        {resolvedTab === "subagents" && (
          <ExplorerSubagentsPane
            serverId={serverId}
            workspaceId={workspaceId}
            onOpenFile={onOpenFile}
            onSelectSubagentPr={onSelectPr}
          />
        )}
        {resolvedTab === "pr" && activeSubagentPrTab && (
          <PrPaneForCheckout
            serverId={serverId}
            cwd={activeSubagentPrTab.cwd}
            workspaceId={workspaceId}
            isOpen={isOpen}
          />
        )}
        {resolvedTab === "pr" && !activeSubagentPrTab && (
          <PrTabContent
            serverId={serverId}
            cwd={workspaceRoot}
            prPane={workspacePrPane}
            workspaceAttachmentScopeKey={workspaceAttachmentScopeKey}
            onRetry={handleWorkspacePrRetry}
          />
        )}
      </View>
    </View>
  );
}

// A header PR tab button with the PR icon + number label.
function ExplorerPrTabButton({
  active,
  label,
  activeColor,
  inactiveColor,
  onPress,
  testID,
}: {
  active: boolean;
  label: string;
  activeColor: string;
  inactiveColor: string;
  onPress: () => void;
  testID: string;
}) {
  const tabStyle = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const tabTextStyle = useMemo(() => [styles.tabText, active && styles.tabTextActive], [active]);
  return (
    <Pressable testID={testID} style={tabStyle} onPress={onPress}>
      <PullRequestTabIcon size={13} color={active ? activeColor : inactiveColor} />
      <Text style={tabTextStyle}>{label}</Text>
    </Pressable>
  );
}

function SubagentPrTabButton({
  prTab,
  active,
  activeColor,
  inactiveColor,
  onSelectPr,
}: {
  prTab: SubagentPrTab;
  active: boolean;
  activeColor: string;
  inactiveColor: string;
  onSelectPr: (prCwd: string | null) => void;
}) {
  const handlePress = useCallback(() => onSelectPr(prTab.cwd), [onSelectPr, prTab.cwd]);
  return (
    <ExplorerPrTabButton
      active={active}
      label={formatPrTabLabel(prTab.prNumber)}
      activeColor={activeColor}
      inactiveColor={inactiveColor}
      onPress={handlePress}
      testID={`explorer-tab-subagent-pr-${prTab.subagentId}`}
    />
  );
}

// Renders the PR review pane for an arbitrary checkout cwd (a subagent's
// worktree). Owns its own PR data query so the pane can point anywhere.
function PrPaneForCheckout({
  serverId,
  cwd,
  workspaceId,
  isOpen,
}: {
  serverId: string;
  cwd: string;
  workspaceId?: string | null;
  isOpen: boolean;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const prPane = usePrPaneData({
    serverId,
    cwd,
    enabled: isOpen,
    timelineEnabled: isOpen,
  });
  const refreshGitActions = useCheckoutGitActionsStore((s) => s.refresh);
  const handleRetry = useCallback(() => {
    refreshGitActions({ serverId, cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [cwd, refreshGitActions, serverId, t, toast]);
  const attachmentScopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  return (
    <PrTabContent
      serverId={serverId}
      cwd={cwd}
      prPane={prPane}
      workspaceAttachmentScopeKey={attachmentScopeKey}
      onRetry={handleRetry}
    />
  );
}

interface PrTabContentProps {
  serverId: string;
  cwd: string;
  prPane: UsePrPaneDataResult;
  workspaceAttachmentScopeKey: string;
  onRetry: () => void;
}

function PrTabContent({
  serverId,
  cwd,
  prPane,
  workspaceAttachmentScopeKey,
  onRetry,
}: PrTabContentProps) {
  if (prPane.data) {
    return (
      <PullRequestPane
        serverId={serverId}
        cwd={cwd}
        data={prPane.data}
        activityLoading={prPane.activityLoading}
        workspaceAttachmentScopeKey={workspaceAttachmentScopeKey}
      />
    );
  }
  if (prPane.error) {
    return <PullRequestPaneError onRetry={onRetry} />;
  }
  return <PullRequestPaneSkeleton />;
}

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const explorerStaticStyles = RNStyleSheet.create({
  backdrop: {
    ...RNStyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  mobileSidebar: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden" as const,
  },
  desktopSidebar: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  desktopSidebarBorder: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  resizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 10,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tabsContainer: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tabText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    color: theme.colors.foreground,
  },
  tabTextMuted: {
    opacity: 0.8,
  },
  headerRightSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  contentArea: {
    flex: 1,
    minHeight: 0,
  },
}));

const DESKTOP_SIDEBAR_BORDER_STYLE = [styles.desktopSidebarBorder, { flex: 1 }];
const RESIZE_HANDLE_STYLE = [styles.resizeHandle, isWeb && ({ cursor: "col-resize" } as object)];
