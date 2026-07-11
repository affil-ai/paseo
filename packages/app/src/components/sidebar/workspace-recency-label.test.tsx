/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let appStateListener: ((state: string) => void) | null = null;
vi.mock("react-native", () => ({
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListener = listener;
      return { remove: () => (appStateListener = null) };
    },
  },
  Platform: { OS: "web" },
}));

import { WorkspaceRecencyLabel } from "./workspace-recency-label";

describe("WorkspaceRecencyLabel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("advances relative time without receiving new workspace data", () => {
    act(() => {
      root.render(
        <WorkspaceRecencyLabel timestampMs={new Date("2026-07-09T12:00:00.000Z").getTime()} />,
      );
    });
    expect(container.textContent).toBe("now");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(container.textContent).toBe("1m");
  });

  it("catches up immediately when the app resumes after timers were suspended", () => {
    act(() => {
      root.render(
        <WorkspaceRecencyLabel timestampMs={new Date("2026-07-09T12:00:00.000Z").getTime()} />,
      );
    });

    vi.setSystemTime(new Date("2026-07-09T12:12:00.000Z"));
    act(() => appStateListener?.("active"));

    expect(container.textContent).toBe("12m");
  });
});
