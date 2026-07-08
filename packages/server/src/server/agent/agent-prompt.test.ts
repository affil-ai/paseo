import { expect, it, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  ERRORED_FINISH_NOTIFICATION_GRACE_MS,
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
  setupFinishNotification,
  type FinishNotificationScheduler,
} from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";

type TestAgentLifecycle = "idle" | "running" | "error" | "closed";

interface ScheduledErroredNotification {
  callback: () => void;
  delayMs: number;
  canceled: boolean;
}

interface TestErroredNotificationScheduler {
  scheduled: ScheduledErroredNotification[];
  schedule: FinishNotificationScheduler;
  fire(index: number): void;
  fireAll(): void;
}

interface FinishNotificationScenarioOptions {
  childLastAssistantMessage?: string | null;
  scheduleErroredNotification?: FinishNotificationScheduler;
}

interface FinishNotificationScenario {
  parentPrompts: string[];
  startWatchingChild(): void;
  emitChildLifecycle(lifecycle: TestAgentLifecycle): void;
  emitChildPermissionRequest(): void;
  readNextParentPrompt(): Promise<string>;
  finishChildAndReadParentPrompt(): Promise<string>;
}

function createTestErroredNotificationScheduler(): TestErroredNotificationScheduler {
  const scheduled: ScheduledErroredNotification[] = [];

  return {
    scheduled,
    schedule(callback, delayMs) {
      const notification = { callback, delayMs, canceled: false };
      scheduled.push(notification);
      return () => {
        notification.canceled = true;
      };
    },
    fire(index) {
      const notification = scheduled[index];
      if (!notification) {
        throw new Error(`No scheduled errored notification at index ${index}`);
      }
      if (!notification.canceled) {
        notification.callback();
      }
    },
    fireAll() {
      for (const notification of scheduled) {
        if (!notification.canceled) {
          notification.callback();
        }
      }
    },
  };
}

function createFinishNotificationScenario(
  options?: FinishNotificationScenarioOptions,
): FinishNotificationScenario {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  let resolveParentPrompt: ((prompt: string) => void) | null = null;
  const parentPrompts: string[] = [];

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscriber = callback;
    return () => {
      subscriber = null;
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => false);
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompts.push(prompt);
    resolveParentPrompt?.(prompt);
    resolveParentPrompt = null;
    return (async function* noop() {})();
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      return { title: "Child Agent" };
    }
    return null;
  });

  return {
    parentPrompts,
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        logger: createTestLogger(),
        scheduleErroredNotification: options?.scheduleErroredNotification,
      });
    },
    emitChildLifecycle(lifecycle) {
      childAgent.lifecycle = lifecycle;
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
    },
    emitChildPermissionRequest() {
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_requested",
          provider: "codex",
          request: {
            id: "permission-1",
            provider: "codex",
            name: "shell",
            title: "Run command?",
            kind: "tool",
            input: {},
          },
        },
      });
    },
    readNextParentPrompt() {
      return new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });
    },
    async finishChildAndReadParentPrompt() {
      const parentPrompt = this.readNextParentPrompt();
      this.emitChildLifecycle("running");
      this.emitChildLifecycle("idle");
      return parentPrompt;
    },
  };
}

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("sendPromptToAgent forwards the client message id as run options", async () => {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-1");
  Reflect.set(agent, "provider", "codex");

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: "agent-1",
    prompt: "hello",
    messageId: "msg-client-1",
    runOptions: { outputSchema: { type: "object" } },
    logger: createTestLogger(),
  });

  expect(streamAgentSpy).toHaveBeenCalledWith("agent-1", "hello", {
    outputSchema: { type: "object" },
    messageId: "msg-client-1",
  });
});

test("finish notifications tell the parent the child's last assistant message", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt(
      "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
    ),
  );
});

test("finish notifications suppress transient errors that recover to running", async () => {
  const scheduler = createTestErroredNotificationScheduler();
  const scenario = createFinishNotificationScenario({
    scheduleErroredNotification: scheduler.schedule,
  });

  scenario.startWatchingChild();
  scenario.emitChildLifecycle("running");
  scenario.emitChildLifecycle("error");

  expect(scheduler.scheduled.map((notification) => notification.delayMs)).toEqual([
    ERRORED_FINISH_NOTIFICATION_GRACE_MS,
  ]);

  scenario.emitChildLifecycle("running");
  scheduler.fireAll();

  expect(scenario.parentPrompts).toEqual([]);

  const parentPrompt = scenario.readNextParentPrompt();
  scenario.emitChildLifecycle("error");
  scheduler.fire(1);

  await expect(parentPrompt).resolves.toEqual(
    formatSystemNotificationPrompt("Agent child-agent (Child Agent) errored."),
  );
});

test("finish notifications report terminal errors after the recovery grace window", async () => {
  const scheduler = createTestErroredNotificationScheduler();
  const scenario = createFinishNotificationScenario({
    scheduleErroredNotification: scheduler.schedule,
  });

  scenario.startWatchingChild();
  const parentPrompt = scenario.readNextParentPrompt();
  scenario.emitChildLifecycle("running");
  scenario.emitChildLifecycle("error");
  scheduler.fire(0);

  await expect(parentPrompt).resolves.toEqual(
    formatSystemNotificationPrompt("Agent child-agent (Child Agent) errored."),
  );
});

test("finish notifications still report permission requests immediately", async () => {
  const scheduler = createTestErroredNotificationScheduler();
  const scenario = createFinishNotificationScenario({
    scheduleErroredNotification: scheduler.schedule,
  });

  scenario.startWatchingChild();
  const parentPrompt = scenario.readNextParentPrompt();
  scenario.emitChildPermissionRequest();

  expect(scheduler.scheduled).toEqual([]);
  await expect(parentPrompt).resolves.toEqual(
    formatSystemNotificationPrompt("Agent child-agent (Child Agent) needs permission."),
  );
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === "child-agent") {
        return childAgent;
      }
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith("caller-agent");
  });

  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
});
