import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  buildExplorerCheckoutKey,
  coerceExplorerTabForCheckout,
  resolveExplorerTabForCheckout,
  type ExplorerTab,
} from "../explorer-tab-memory";
import { type ExplorerPrByCheckout } from "../explorer-pr-memory";
import { type ExplorerCheckoutContext } from "../explorer-checkout-context";
import {
  buildOpenFileExplorerPatch,
  buildToggleFileExplorerPatch,
  clampExplorerFilesSplitRatio,
  clampExplorerWidth,
  clampSidebarWidth,
  DEFAULT_EXPLORER_FILES_SPLIT_RATIO,
  DEFAULT_EXPLORER_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_EXPLORER_FILES_SPLIT_RATIO,
  MAX_EXPLORER_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_EXPLORER_FILES_SPLIT_RATIO,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  migratePanelState,
  selectIsAgentListOpen,
  selectIsFileExplorerOpen,
  selectPanelVisibility,
  type DesktopSidebarState,
  type ExplorerPanelIntent,
  type MobilePanelView,
  type PanelLayoutInput,
  type PanelVisibilityState,
  type SortOption,
} from "./state";
import { isWeb } from "@/constants/platform";
export type { ExplorerTab } from "../explorer-tab-memory";
export type { ExplorerCheckoutContext } from "../explorer-checkout-context";
export type {
  DesktopSidebarState,
  ExplorerPanelIntent,
  MobilePanelView,
  PanelLayoutInput,
  PanelVisibilityState,
  SortOption,
} from "./state";
export {
  DEFAULT_EXPLORER_FILES_SPLIT_RATIO,
  DEFAULT_EXPLORER_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_EXPLORER_FILES_SPLIT_RATIO,
  MAX_EXPLORER_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_EXPLORER_FILES_SPLIT_RATIO,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  selectIsAgentListOpen,
  selectIsFileExplorerOpen,
  selectPanelVisibility,
};

export interface PanelState {
  // Mobile: which panel is currently shown
  mobileView: MobilePanelView;

  // Desktop: independent sidebar toggles
  desktop: DesktopSidebarState;

  // File explorer settings (shared between mobile/desktop)
  explorerTab: ExplorerTab;
  explorerTabByCheckout: Record<string, ExplorerTab>;
  // Which checkout the PR pane points at while `explorerTab === "pr"`. `null`
  // means the workspace's own PR; otherwise a subagent's cwd. In-memory active
  // value; hydrated from `explorerPrByCheckout` on load.
  explorerPrCwd: string | null;
  // Per-checkout persisted PR selection keyed by stable PR identity. See
  // `explorer-pr-memory.ts`.
  explorerPrByCheckout: ExplorerPrByCheckout;
  expandedPathsByWorkspace: Record<string, string[]>;
  diffExpandedPathsByWorkspace: Record<string, string[]>;
  sidebarWidth: number;
  explorerWidth: number;
  explorerSortOption: SortOption;
  explorerShowHiddenFiles: boolean;
  explorerFilesSplitRatio: number;

  // Actions
  toggleFocusMode: () => void;
  showMobileAgent: () => void;
  showMobileAgentList: () => void;
  toggleMobileAgentList: () => void;
  openDesktopAgentList: () => void;
  closeDesktopAgentList: () => void;
  toggleDesktopAgentList: () => void;
  closeDesktopFileExplorer: () => void;
  openAgentListForLayout: (input: PanelLayoutInput) => void;
  closeAgentListForLayout: (input: PanelLayoutInput) => void;
  toggleAgentListForLayout: (input: PanelLayoutInput) => void;
  openFileExplorerForCheckout: (input: ExplorerPanelIntent) => void;
  toggleFileExplorerForCheckout: (input: ExplorerPanelIntent) => void;

  // File explorer settings actions
  setExplorerTab: (tab: ExplorerTab) => void;
  setExplorerTabForCheckout: (params: ExplorerCheckoutContext & { tab: ExplorerTab }) => void;
  // Select which PR the explorer PR pane shows: pass a subagent cwd, or `null`
  // for the workspace's own PR. Also switches the active tab to "pr" and
  // persists the selection by stable PR identity (`prIdentityKey`, `null` for
  // the workspace's own PR) so it survives a reload.
  selectExplorerPr: (
    params: ExplorerCheckoutContext & { prCwd: string | null; prIdentityKey: string | null },
  ) => void;
  // Hydrate the in-memory active PR selection for a checkout after reconciling
  // the persisted identity against the live PR set. `prCwd` is the resolved cwd
  // (a subagent cwd or the workspace cwd for its own PR).
  hydrateExplorerPrForCheckout: (params: { prCwd: string | null }) => void;
  setExpandedPathsForWorkspace: (workspaceKey: string, paths: string[]) => void;
  setDiffExpandedPathsForWorkspace: (workspaceKey: string, paths: string[]) => void;
  activateExplorerTabForCheckout: (checkout: ExplorerCheckoutContext) => void;
  setSidebarWidth: (width: number) => void;
  setExplorerWidth: (width: number) => void;
  setExplorerSortOption: (option: SortOption) => void;
  toggleExplorerShowHiddenFiles: () => void;
  setExplorerFilesSplitRatio: (ratio: number) => void;
}

const DEFAULT_DESKTOP_OPEN = isWeb;

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      // Mobile always starts at agent view
      mobileView: "agent",

      // Desktop defaults based on platform
      desktop: {
        agentListOpen: DEFAULT_DESKTOP_OPEN,
        fileExplorerOpen: false,
        focusModeEnabled: false,
      },

      // File explorer defaults
      explorerTab: "changes",
      explorerTabByCheckout: {},
      explorerPrCwd: null,
      explorerPrByCheckout: {},
      expandedPathsByWorkspace: {},
      diffExpandedPathsByWorkspace: {},
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      explorerWidth: DEFAULT_EXPLORER_SIDEBAR_WIDTH,
      explorerSortOption: "name",
      explorerShowHiddenFiles: true,
      explorerFilesSplitRatio: DEFAULT_EXPLORER_FILES_SPLIT_RATIO,

      toggleFocusMode: () =>
        set((state) => ({
          desktop: { ...state.desktop, focusModeEnabled: !state.desktop.focusModeEnabled },
        })),

      showMobileAgent: () =>
        set((state) => {
          if (state.mobileView === "agent") {
            return state;
          }
          return { mobileView: "agent" as const };
        }),

      showMobileAgentList: () =>
        set((state) => {
          if (state.mobileView === "agent-list") {
            return state;
          }
          return { mobileView: "agent-list" as const };
        }),

      toggleMobileAgentList: () =>
        set((state) => ({
          mobileView: state.mobileView === "agent-list" ? "agent" : "agent-list",
        })),

      openDesktopAgentList: () =>
        set((state) => {
          if (state.desktop.agentListOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, agentListOpen: true } };
        }),

      closeDesktopAgentList: () =>
        set((state) => {
          if (!state.desktop.agentListOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, agentListOpen: false } };
        }),

      toggleDesktopAgentList: () =>
        set((state) => ({
          desktop: { ...state.desktop, agentListOpen: !state.desktop.agentListOpen },
        })),

      closeDesktopFileExplorer: () =>
        set((state) => {
          if (!state.desktop.fileExplorerOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, fileExplorerOpen: false } };
        }),

      openAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return state.mobileView === "agent-list"
              ? state
              : { mobileView: "agent-list" as const };
          }
          return state.desktop.agentListOpen
            ? state
            : { desktop: { ...state.desktop, agentListOpen: true } };
        }),

      closeAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return state.mobileView === "agent" ? state : { mobileView: "agent" as const };
          }
          return state.desktop.agentListOpen
            ? { desktop: { ...state.desktop, agentListOpen: false } }
            : state;
        }),

      toggleAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return { mobileView: state.mobileView === "agent-list" ? "agent" : "agent-list" };
          }
          return {
            desktop: { ...state.desktop, agentListOpen: !state.desktop.agentListOpen },
          };
        }),

      openFileExplorerForCheckout: (input) =>
        set((state) => buildOpenFileExplorerPatch(state, input)),

      toggleFileExplorerForCheckout: (input) =>
        set((state) => buildToggleFileExplorerPatch(state, input)),

      setExplorerTab: (tab) => set({ explorerTab: tab }),
      setExplorerTabForCheckout: ({ serverId, cwd, isGit, tab }) =>
        set((state) => {
          const resolvedTab = coerceExplorerTabForCheckout(tab, isGit);
          const key = buildExplorerCheckoutKey(serverId, cwd);
          // Pressing the header PR tab always targets the workspace's own PR;
          // any non-PR tab clears the PR pane target.
          const nextState: Partial<PanelState> = { explorerTab: resolvedTab, explorerPrCwd: null };
          if (key) {
            const current = state.explorerTabByCheckout[key];
            if (current !== resolvedTab) {
              nextState.explorerTabByCheckout = {
                ...state.explorerTabByCheckout,
                [key]: resolvedTab,
              };
            }
          }
          return nextState;
        }),
      selectExplorerPr: ({ serverId, cwd, isGit, prCwd, prIdentityKey }) =>
        set((state) => {
          const key = buildExplorerCheckoutKey(serverId, cwd);
          const nextState: Partial<PanelState> = {
            explorerTab: "pr",
            explorerPrCwd: prCwd,
          };
          if (key) {
            if (state.explorerTabByCheckout[key] !== "pr") {
              nextState.explorerTabByCheckout = {
                ...state.explorerTabByCheckout,
                [key]: coerceExplorerTabForCheckout("pr", isGit),
              };
            }
            if (state.explorerPrByCheckout[key] !== prIdentityKey) {
              nextState.explorerPrByCheckout = {
                ...state.explorerPrByCheckout,
                [key]: prIdentityKey,
              };
            }
          }
          return nextState;
        }),
      hydrateExplorerPrForCheckout: ({ prCwd }) =>
        set((state) => (state.explorerPrCwd === prCwd ? state : { explorerPrCwd: prCwd })),
      setExpandedPathsForWorkspace: (workspaceKey, paths) =>
        set((state) => ({
          expandedPathsByWorkspace: { ...state.expandedPathsByWorkspace, [workspaceKey]: paths },
        })),
      setDiffExpandedPathsForWorkspace: (workspaceKey, paths) =>
        set((state) => ({
          diffExpandedPathsByWorkspace: {
            ...state.diffExpandedPathsByWorkspace,
            [workspaceKey]: paths,
          },
        })),
      activateExplorerTabForCheckout: (checkout) =>
        set((state) => ({
          explorerTab: resolveExplorerTabForCheckout({
            serverId: checkout.serverId,
            cwd: checkout.cwd,
            isGit: checkout.isGit,
            explorerTabByCheckout: state.explorerTabByCheckout,
          }),
        })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      setExplorerWidth: (width) => set({ explorerWidth: clampExplorerWidth(width) }),
      setExplorerSortOption: (option) => set({ explorerSortOption: option }),
      toggleExplorerShowHiddenFiles: () =>
        set((state) => ({ explorerShowHiddenFiles: !state.explorerShowHiddenFiles })),
      setExplorerFilesSplitRatio: (ratio) =>
        set({
          explorerFilesSplitRatio: Number.isFinite(ratio)
            ? clampExplorerFilesSplitRatio(ratio)
            : DEFAULT_EXPLORER_FILES_SPLIT_RATIO,
        }),
    }),
    {
      name: "panel-state",
      version: 12,
      storage: createJSONStorage(() => AsyncStorage),
      migrate: (persistedState, version) =>
        migratePanelState(persistedState, version, { isWeb }) as unknown as PanelState,
      partialize: (state) => ({
        mobileView: state.mobileView,
        desktop: state.desktop,
        explorerTab: state.explorerTab,
        explorerTabByCheckout: state.explorerTabByCheckout,
        explorerPrByCheckout: state.explorerPrByCheckout,
        expandedPathsByWorkspace: state.expandedPathsByWorkspace,
        diffExpandedPathsByWorkspace: state.diffExpandedPathsByWorkspace,
        sidebarWidth: state.sidebarWidth,
        explorerWidth: state.explorerWidth,
        explorerSortOption: state.explorerSortOption,
        explorerShowHiddenFiles: state.explorerShowHiddenFiles,
        explorerFilesSplitRatio: state.explorerFilesSplitRatio,
      }),
    },
  ),
);

/**
 * Hook that provides platform-aware panel state.
 *
 * On mobile, uses the state machine (mobileView).
 * On desktop, uses independent booleans (desktop.agentListOpen, desktop.fileExplorerOpen).
 *
 * @param isMobile - Whether the current breakpoint is mobile
 */
export function usePanelState(isMobile: boolean) {
  const isAgentListOpen = usePanelStore((state) =>
    selectIsAgentListOpen(state, { isCompact: isMobile }),
  );
  const isFileExplorerOpen = usePanelStore((state) =>
    selectIsFileExplorerOpen(state, { isCompact: isMobile }),
  );
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const openAgentListForLayout = usePanelStore((state) => state.openAgentListForLayout);
  const closeAgentListForLayout = usePanelStore((state) => state.closeAgentListForLayout);
  const toggleAgentListForLayout = usePanelStore((state) => state.toggleAgentListForLayout);
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const explorerTabByCheckout = usePanelStore((state) => state.explorerTabByCheckout);
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const explorerSortOption = usePanelStore((state) => state.explorerSortOption);
  const explorerFilesSplitRatio = usePanelStore((state) => state.explorerFilesSplitRatio);
  const setExplorerTab = usePanelStore((state) => state.setExplorerTab);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const activateExplorerTabForCheckout = usePanelStore(
    (state) => state.activateExplorerTabForCheckout,
  );
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const setExplorerSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const setExplorerFilesSplitRatio = usePanelStore((state) => state.setExplorerFilesSplitRatio);

  return {
    isAgentListOpen,
    isFileExplorerOpen,
    openAgentList: () => openAgentListForLayout({ isCompact: isMobile }),
    closeAgentList: () => closeAgentListForLayout({ isCompact: isMobile }),
    closeFileExplorer: isMobile ? showMobileAgent : closeDesktopFileExplorer,
    toggleAgentList: () => toggleAgentListForLayout({ isCompact: isMobile }),
    explorerTab,
    explorerTabByCheckout,
    explorerWidth,
    explorerSortOption,
    explorerFilesSplitRatio,
    setExplorerTab,
    setExplorerTabForCheckout,
    activateExplorerTabForCheckout,
    setExplorerWidth,
    setExplorerSortOption,
    setExplorerFilesSplitRatio,
  };
}
