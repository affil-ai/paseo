import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setTimeout> | null = null;

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

function subscribeToMinuteClock(listener: () => void): () => void {
  listeners.add(listener);
  scheduleMinuteTick();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && minuteTimer) {
      clearTimeout(minuteTimer);
      minuteTimer = null;
    }
  };
}

export function useRelativeTimeClock(): number {
  return useSyncExternalStore(subscribeToMinuteClock, getMinuteSnapshot, getMinuteSnapshot);
}
