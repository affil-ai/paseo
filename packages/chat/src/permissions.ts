import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentPermissionRequestMessage } from "@getpaseo/protocol/messages";
import { Actions, Button, Card, CardText, type Chat, type Thread } from "chat";
import { getBindingOwnerAgentId, type ThreadSessionStore } from "./state/thread-session-store.js";

interface PermissionThread {
  post(message: Parameters<Thread["post"]>[0]): Promise<unknown>;
}

const ACTION_PREFIX = "paseo-permit:";

function buttonStyle(variant: "primary" | "secondary" | "danger" | undefined) {
  if (variant === "danger") return "danger";
  if (variant === "primary") return "primary";
  return "default";
}

function actionId(requestId: string, selectedActionId: string): string {
  return `${ACTION_PREFIX}${requestId}:${selectedActionId}`;
}

export class PermissionBridge {
  constructor(
    private readonly client: DaemonClient,
    private readonly store: ThreadSessionStore,
  ) {}

  register(chat: Chat): void {
    chat.onAction(async (event) => {
      if (!event.actionId.startsWith(ACTION_PREFIX)) return;
      const [, requestId = "", selectedActionId = ""] =
        event.actionId.match(/^paseo-permit:([^:]+):(.+)$/) ?? [];
      if (!requestId || !selectedActionId) return;
      const behavior = event.value === "deny" ? "deny" : "allow";
      const session = await this.store.getSession(event.threadId);
      if (!session) return;
      await this.client.respondToPermission(getBindingOwnerAgentId(session), requestId, {
        behavior,
        selectedActionId,
      });
      await event.thread?.post(`${behavior === "allow" ? "Approved" : "Denied"}.`);
    });
  }

  async handlePermission(
    message: AgentPermissionRequestMessage,
    thread: PermissionThread,
    externalThreadId: string,
  ): Promise<void> {
    const request = message.payload.request;
    const agentId = message.payload.agentId;
    if (request.kind === "question") {
      await this.store.setPendingQuestion(externalThreadId, agentId, request.id);
      await thread.post(
        `❓ ${request.title ?? request.name}\n\n${request.description ?? "Reply in this thread to answer."}`,
      );
      return;
    }

    const actions = request.actions?.length
      ? request.actions
      : [
          { id: "allow", label: "Allow", behavior: "allow" as const, variant: "primary" as const },
          { id: "deny", label: "Deny", behavior: "deny" as const, variant: "danger" as const },
        ];

    await thread.post(
      Card({
        title: request.title ?? request.name,
        children: [
          CardText(request.description ?? "The agent is requesting permission."),
          Actions(
            actions.map((action) =>
              Button({
                id: actionId(request.id, action.id),
                value: action.behavior,
                style: buttonStyle(action.variant),
                label: action.label,
              }),
            ),
          ),
        ],
      }),
    );
  }

  async answerPendingQuestion(externalThreadId: string, text: string): Promise<boolean> {
    const pending = await this.store.takePendingQuestion(externalThreadId);
    if (!pending) return false;
    await this.client.respondToPermission(pending.agentId, pending.requestId, {
      behavior: "allow",
      updatedInput: { answer: text },
    });
    return true;
  }
}
