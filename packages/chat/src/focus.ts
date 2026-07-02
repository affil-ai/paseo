import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Thread } from "chat";
import type { ThreadSessionStore } from "./state/thread-session-store.js";

export class FocusRelay {
  constructor(_client: DaemonClient, _store: ThreadSessionStore) {
    void _client;
    void _store;
  }

  async maybeFocusChild(
    _externalThreadId: string,
    _agent: AgentSnapshotPayload,
    _thread?: Thread,
  ): Promise<boolean> {
    return false;
  }

  async returnToRoot(
    _externalThreadId: string,
    _childAgentId: string,
    _thread?: Thread,
  ): Promise<void> {}

  async escapeToRoot(_externalThreadId: string): Promise<void> {}
}
