import { describe, it, expect } from "vitest";
import { formatCompactTimeAgo, formatDuration, formatMessageTimestamp } from "./time";

describe("formatCompactTimeAgo", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("renders 'now' for sub-minute deltas", () => {
    expect(formatCompactTimeAgo(ago(0), now)).toBe("now");
    expect(formatCompactTimeAgo(ago(59 * SECOND), now)).toBe("now");
  });

  it("renders minutes below one hour", () => {
    expect(formatCompactTimeAgo(ago(MINUTE), now)).toBe("1m");
    expect(formatCompactTimeAgo(ago(3 * MINUTE), now)).toBe("3m");
    expect(formatCompactTimeAgo(ago(59 * MINUTE), now)).toBe("59m");
  });

  it("renders hours below one day", () => {
    expect(formatCompactTimeAgo(ago(HOUR), now)).toBe("1h");
    expect(formatCompactTimeAgo(ago(17 * HOUR), now)).toBe("17h");
    expect(formatCompactTimeAgo(ago(23 * HOUR), now)).toBe("23h");
  });

  it("renders days below one week", () => {
    expect(formatCompactTimeAgo(ago(DAY), now)).toBe("1d");
    expect(formatCompactTimeAgo(ago(2 * DAY), now)).toBe("2d");
    expect(formatCompactTimeAgo(ago(6 * DAY), now)).toBe("6d");
  });

  it("renders weeks below ~5 weeks", () => {
    expect(formatCompactTimeAgo(ago(7 * DAY), now)).toBe("1w");
    expect(formatCompactTimeAgo(ago(28 * DAY), now)).toBe("4w");
  });

  it("renders months once past ~5 weeks", () => {
    expect(formatCompactTimeAgo(ago(35 * DAY), now)).toBe("1mo");
    expect(formatCompactTimeAgo(ago(90 * DAY), now)).toBe("3mo");
  });

  it("renders years once past 12 months", () => {
    expect(formatCompactTimeAgo(ago(365 * DAY), now)).toBe("1y");
    expect(formatCompactTimeAgo(ago(2 * 365 * DAY), now)).toBe("2y");
  });
});

describe("formatDuration", () => {
  it("renders sub-minute durations as whole seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5_600)).toBe("5s");
    expect(formatDuration(9_900)).toBe("9s");
    expect(formatDuration(10_400)).toBe("10s");
    expect(formatDuration(12_340)).toBe("12s");
    expect(formatDuration(47_000)).toBe("47s");
  });

  it("renders minutes and remainder seconds without decimals", () => {
    expect(formatDuration(75_230)).toBe("1m 15s");
    expect(formatDuration(132_000)).toBe("2m 12s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("renders hours and remainder minutes without decimals", () => {
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("guards against negative and NaN", () => {
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("formatMessageTimestamp", () => {
  it("shows only time for same-day timestamps", () => {
    const now = new Date(2026, 4, 14, 17, 30);
    const date = new Date(2026, 4, 14, 12, 23);
    const formatted = formatMessageTimestamp(date, now);
    expect(formatted).toMatch(/12:23/);
    expect(formatted).not.toMatch(/Thursday|Wednesday/);
  });

  it("includes weekday for timestamps within the last 6 days", () => {
    // 2026-05-14 is a Thursday. 2026-05-11 is a Monday.
    const now = new Date(2026, 4, 14, 17, 30);
    const date = new Date(2026, 4, 11, 22, 12);
    const formatted = formatMessageTimestamp(date, now);
    expect(formatted).toMatch(/Monday/);
    expect(formatted).toMatch(/10:12 PM|22:12/);
  });

  it("includes full date for older timestamps", () => {
    const now = new Date(2026, 4, 14, 17, 30);
    const date = new Date(2026, 3, 1, 9, 5);
    const formatted = formatMessageTimestamp(date, now);
    expect(formatted).toMatch(/Apr|April/);
    expect(formatted).toMatch(/2026/);
  });
});
