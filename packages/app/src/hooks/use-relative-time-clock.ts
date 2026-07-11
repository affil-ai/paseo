import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { isWeb } from "@/constants/platform";

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setTimeout> | null = null;
let removeResumeListeners: (() => void) | null = null;

function getMinuteSnapshot(): number {
  return Math.floor(Date.now() / MINUTE_MS);
}

function scheduleMinuteTick(): void {
  if (minuteTimer || listeners.size === 0) return;
  const now = Date.now();
  const nextMinute = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS;
  minuteTimer = setTimeout(
    () => {
      minuteTimer = null;
      for (const listener of listeners) {
        listener();
      }
      scheduleMinuteTick();
    },
    Math.max(1, nextMinute - now),
  );
}

function notifyAndReschedule(): void {
  if (minuteTimer) {
    clearTimeout(minuteTimer);
    minuteTimer = null;
  }
  for (const listener of listeners) {
    listener();
  }
  scheduleMinuteTick();
}

function addResumeListeners(): () => void {
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state === "active") notifyAndReschedule();
  });
  const handleWebResume = () => notifyAndReschedule();
  if (isWeb && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleWebResume);
    window.addEventListener("focus", handleWebResume);
  }
  return () => {
    appStateSubscription.remove();
    if (isWeb && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleWebResume);
      window.removeEventListener("focus", handleWebResume);
    }
  };
}

function subscribeToMinuteClock(listener: () => void): () => void {
  listeners.add(listener);
  if (!removeResumeListeners) removeResumeListeners = addResumeListeners();
  scheduleMinuteTick();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && minuteTimer) {
      clearTimeout(minuteTimer);
      minuteTimer = null;
    }
    if (listeners.size === 0 && removeResumeListeners) {
      removeResumeListeners();
      removeResumeListeners = null;
    }
  };
}

export function useRelativeTimeClock(): number {
  return useSyncExternalStore(subscribeToMinuteClock, getMinuteSnapshot, getMinuteSnapshot);
}
