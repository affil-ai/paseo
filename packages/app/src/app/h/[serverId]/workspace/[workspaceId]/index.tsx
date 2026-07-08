import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { StyleSheet, View } from "react-native";
import { useGlobalSearchParams, useLocalSearchParams, useRootNavigationState } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import {
  type ActiveWorkspaceSelection,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useHasHydratedWorkspaces, useWorkspaceExists } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { resolveWorkspacePrCwdForIdentity } from "@/subagents";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useIsCompactFormFactor } from "@/constants/layout";
import { WorkspaceScreen } from "@/screens/workspace/workspace-screen";
import { useWorkspaceLayoutStoreHydrated } from "@/stores/workspace-layout-store";
import {
  areWorkspaceSelectionListsEqual,
  areWorkspaceSelectionsEqual,
  getWorkspaceSelectionKey,
  pruneMountedWorkspaceSelections,
  shouldKeepWorkspaceDeckEntryMounted,
  WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES,
} from "@/screens/workspace/workspace-deck-retention";
import {
  decodeWorkspaceIdFromPathSegment,
  parseWorkspaceOpenIntent,
  type WorkspaceOpenIntent,
} from "@/utils/host-routes";
import {
  replaceBrowserRouteWithCanonicalHostWorkspaceRoute,
  stripHostWorkspaceRouteEchoSearchFromBrowserUrlAfterCommit,
} from "@/utils/host-route-browser";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { isWeb } from "@/constants/platform";

function getParamValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue.trim() : "";
  }
  return "";
}

function getOpenIntentTarget(openIntent: WorkspaceOpenIntent): WorkspaceTabTarget {
  if (openIntent.kind === "agent") {
    return { kind: "agent", agentId: openIntent.agentId };
  }
  if (openIntent.kind === "terminal") {
    return { kind: "terminal", terminalId: openIntent.terminalId };
  }
  if (openIntent.kind === "file") {
    return { kind: "file", path: openIntent.path };
  }
  if (openIntent.kind === "setup") {
    return { kind: "setup", workspaceId: openIntent.workspaceId };
  }
  return { kind: "draft", draftId: openIntent.draftId };
}

function stripOpenSearchParamFromBrowserUrl() {
  if (!isWeb || typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (!url.searchParams.has("open")) {
    return;
  }
  url.searchParams.delete("open");
  replaceBrowserRouteWithCanonicalHostWorkspaceRoute(`${url.pathname}${url.search}${url.hash}`);
}

function stripPrSearchParamFromBrowserUrl() {
  if (!isWeb || typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (!url.searchParams.has("pr")) {
    return;
  }
  url.searchParams.delete("pr");
  replaceBrowserRouteWithCanonicalHostWorkspaceRoute(`${url.pathname}${url.search}${url.hash}`);
}

function clearConsumedPrIntent(input: {
  navigation: { setParams: (params: { pr?: string | undefined }) => void };
}) {
  input.navigation.setParams({ pr: undefined });
  if (isWeb) {
    stripPrSearchParamFromBrowserUrl();
  }
}

// Resolve the `?pr=` deep-link identity against the live store and, if it maps
// to a PR (the workspace's own or a subagent's), open the explorer PR pane at
// it. Returns true once the intent has been handled (resolved or definitively
// absent after hydration) so the caller can consume it.
function applyWorkspacePrDeepLink(input: {
  serverId: string;
  workspaceId: string;
  prIdentityKey: string;
  isCompact: boolean;
}): boolean {
  const state = useSessionStore.getState();
  const workspaces = state.sessions[input.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: input.workspaceId,
  });
  const descriptor = workspaceKey ? workspaces?.get(workspaceKey) : null;
  const cwd = descriptor?.workspaceDirectory;
  if (!descriptor || !cwd) {
    // Workspace not hydrated yet — let the caller retry.
    return false;
  }
  const resolved = resolveWorkspacePrCwdForIdentity(
    state,
    {
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      prIdentityKey: input.prIdentityKey,
    },
    new Set(),
  );
  if (!resolved) {
    // PR not in the live set (not yet loaded, or genuinely gone). Consume
    // silently and leave the default PR pane behavior.
    return true;
  }
  const isGit = descriptor.projectKind === "git";
  const panel = usePanelStore.getState();
  panel.openFileExplorerForCheckout({
    checkout: { serverId: input.serverId, cwd, isGit },
    isCompact: input.isCompact,
  });
  panel.selectExplorerPr({
    serverId: input.serverId,
    cwd,
    isGit,
    prCwd: resolved.prCwd,
    prIdentityKey: input.prIdentityKey,
  });
  return true;
}

function clearConsumedOpenIntent(input: {
  navigation: { setParams: (params: { open?: string | undefined }) => void };
}) {
  input.navigation.setParams({ open: undefined });
  if (isWeb) {
    stripOpenSearchParamFromBrowserUrl();
  }
}

export default function HostWorkspaceIndexRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostWorkspaceRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostWorkspaceRouteContent() {
  const navigation = useNavigation();
  const rootNavigationState = useRootNavigationState();
  const hasHydratedWorkspaceLayoutStore = useWorkspaceLayoutStoreHydrated();
  const isCompact = useIsCompactFormFactor();
  const consumedIntentRef = useRef<string | null>(null);
  const consumedPrIntentRef = useRef<string | null>(null);
  const [intentConsumed, setIntentConsumed] = useState(false);
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const globalParams = useGlobalSearchParams<{
    open?: string | string[];
    pr?: string | string[];
  }>();
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue
    ? (decodeWorkspaceIdFromPathSegment(workspaceValue) ?? "")
    : "";
  const openValue = getParamValue(globalParams.open);
  const prValue = getParamValue(globalParams.pr);
  const hasHydratedWorkspaces = useHasHydratedWorkspaces(serverId || null);
  useEffect(() => {
    if (!serverId || !workspaceId) {
      return;
    }
    stripHostWorkspaceRouteEchoSearchFromBrowserUrlAfterCommit();
  }, [serverId, workspaceId]);

  useEffect(() => {
    if (!openValue) {
      return;
    }
    if (!rootNavigationState?.key) {
      return;
    }
    if (!hasHydratedWorkspaceLayoutStore) {
      return;
    }

    const consumptionKey = `${serverId}:${workspaceId}:${openValue}`;
    if (consumedIntentRef.current === consumptionKey) {
      clearConsumedOpenIntent({
        navigation: navigation as unknown as {
          setParams: (params: { open?: string | undefined }) => void;
        },
      });
      setIntentConsumed(true);
      return;
    }
    consumedIntentRef.current = consumptionKey;

    const openIntent = parseWorkspaceOpenIntent(openValue);
    if (openIntent) {
      prepareWorkspaceTab({
        serverId,
        workspaceId,
        target: getOpenIntentTarget(openIntent),
        pin: openIntent.kind === "agent",
      });
    }

    // Expo Router's replace ignores query-param-only changes (findDivergentState
    // skips search params). Strip ?open from the browser URL directly so the
    // address bar reflects the clean workspace route.
    clearConsumedOpenIntent({
      navigation: navigation as unknown as {
        setParams: (params: { open?: string | undefined }) => void;
      },
    });

    setIntentConsumed(true);
  }, [
    hasHydratedWorkspaceLayoutStore,
    navigation,
    openValue,
    rootNavigationState?.key,
    serverId,
    workspaceId,
  ]);

  // Deep-link: open a specific PR in the explorer once workspaces hydrate.
  // Consume-once guarded by serverId+workspaceId+pr; clears the param after.
  useEffect(() => {
    if (!prValue || !serverId || !workspaceId) {
      return;
    }
    if (!rootNavigationState?.key || !hasHydratedWorkspaceLayoutStore || !hasHydratedWorkspaces) {
      return;
    }
    const consumptionKey = `${serverId}:${workspaceId}:${prValue}`;
    if (consumedPrIntentRef.current === consumptionKey) {
      return;
    }
    const handled = applyWorkspacePrDeepLink({
      serverId,
      workspaceId,
      prIdentityKey: prValue,
      isCompact,
    });
    if (!handled) {
      // Workspace descriptor not hydrated yet; retry on the next store update.
      return;
    }
    consumedPrIntentRef.current = consumptionKey;
    clearConsumedPrIntent({
      navigation: navigation as unknown as {
        setParams: (params: { pr?: string | undefined }) => void;
      },
    });
  }, [
    hasHydratedWorkspaceLayoutStore,
    hasHydratedWorkspaces,
    isCompact,
    navigation,
    prValue,
    rootNavigationState?.key,
    serverId,
    workspaceId,
  ]);

  if (openValue && (!intentConsumed || !hasHydratedWorkspaceLayoutStore)) {
    return null;
  }

  return <WorkspaceDeck />;
}

function WorkspaceDeck() {
  const activeSelection = useActiveWorkspaceSelection();
  const [mountedSelections, setMountedSelections] = useState<ActiveWorkspaceSelection[]>(() =>
    activeSelection ? [activeSelection] : [],
  );
  const unmountWorkspaceSelection = useCallback((selection: ActiveWorkspaceSelection) => {
    setMountedSelections((current) =>
      current.filter(
        (mountedSelection) => !areWorkspaceSelectionsEqual(mountedSelection, selection),
      ),
    );
  }, []);

  useEffect(() => {
    if (!activeSelection) {
      return;
    }
    setMountedSelections((current) => {
      const next = pruneMountedWorkspaceSelections({
        currentSelections: current,
        activeSelection,
        maxMountedWorkspaces: WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES,
      });
      if (areWorkspaceSelectionListsEqual(current, next)) {
        return current;
      }
      return next;
    });
  }, [activeSelection]);

  if (!activeSelection) {
    return null;
  }

  return (
    <View style={styles.deck}>
      {mountedSelections.map((selection) => {
        return (
          <WorkspaceDeckEntry
            key={getWorkspaceSelectionKey(selection)}
            selection={selection}
            activeSelection={activeSelection}
            onUnmountInactive={unmountWorkspaceSelection}
          />
        );
      })}
    </View>
  );
}

function WorkspaceDeckEntry({
  selection,
  activeSelection,
  onUnmountInactive,
}: {
  selection: ActiveWorkspaceSelection;
  activeSelection: ActiveWorkspaceSelection;
  onUnmountInactive: (selection: ActiveWorkspaceSelection) => void;
}) {
  const isActive = areWorkspaceSelectionsEqual(selection, activeSelection);
  const hasHydratedWorkspaces = useHasHydratedWorkspaces(selection.serverId);
  const workspaceExists = useWorkspaceExists(selection.serverId, selection.workspaceId);
  const shouldKeepMounted = shouldKeepWorkspaceDeckEntryMounted({
    isActive,
    hasHydratedWorkspaces,
    workspaceExists,
  });

  useEffect(() => {
    if (!shouldKeepMounted) {
      onUnmountInactive(selection);
    }
  }, [onUnmountInactive, selection, shouldKeepMounted]);

  if (!shouldKeepMounted) {
    return null;
  }

  return (
    <View
      style={isActive ? styles.activeDeckEntry : styles.inactiveDeckEntry}
      testID={`workspace-deck-entry-${selection.serverId}:${selection.workspaceId}`}
    >
      <WorkspaceScreen
        serverId={selection.serverId}
        workspaceId={selection.workspaceId}
        isRouteFocused={isActive}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  deck: {
    flex: 1,
  },
  activeDeckEntry: {
    flex: 1,
  },
  inactiveDeckEntry: {
    display: "none",
    flex: 1,
  },
});
