import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectAddResponse, ProjectCloneResponse } from "@getpaseo/protocol/messages";
import {
  normalizeEmptyProjectDescriptor as normalizeProjectWithoutWorkspacesDescriptor,
  type EmptyProjectDescriptor as ProjectWithoutWorkspacesDescriptor,
} from "@/stores/session-store";

type OpenProjectPayload = ProjectAddResponse["payload"];
type OpenProjectErrorCode = NonNullable<OpenProjectPayload["errorCode"]>;
type CloneProjectPayload = ProjectCloneResponse["payload"];
type CloneProjectErrorCode = NonNullable<CloneProjectPayload["errorCode"]>;

export interface OpenProjectSuccess {
  ok: true;
}

export interface OpenProjectFailure {
  ok: false;
  errorCode: OpenProjectErrorCode | CloneProjectErrorCode | null;
  error: string | null;
  clonedPath?: string | null;
}

export type OpenProjectResult = OpenProjectSuccess | OpenProjectFailure;
export type OpenProjectFailureReason = "directory_not_found" | "open_failed";

export function getOpenProjectFailureReason(
  result: OpenProjectResult,
): OpenProjectFailureReason | null {
  if (result.ok) {
    return null;
  }

  if (result.errorCode === "directory_not_found") {
    return "directory_not_found";
  }

  return "open_failed";
}

export interface OpenProjectDirectlyInput {
  serverId: string;
  projectPath: string;
  isConnected: boolean;
  canAddProject: boolean;
  client: Pick<DaemonClient, "addProject"> | null;
  addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

export interface CloneProjectDirectlyInput {
  serverId: string;
  repoUrl: string;
  destinationParent: string;
  directoryName?: string;
  isConnected: boolean;
  canCloneProject: boolean;
  client: Pick<DaemonClient, "cloneProject"> | null;
  addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

export async function openProjectDirectly(
  input: OpenProjectDirectlyInput,
): Promise<OpenProjectResult> {
  const normalizedServerId = input.serverId.trim();
  const trimmedPath = input.projectPath.trim();
  if (!normalizedServerId || !trimmedPath || !input.client || !input.isConnected) {
    return { ok: false, errorCode: null, error: null };
  }

  if (!input.canAddProject) {
    return {
      ok: false,
      errorCode: null,
      error: "Update the host to add projects without creating a workspace.",
    };
  }

  const payload = await input.client.addProject(trimmedPath);
  if (payload.error || !payload.project) {
    return {
      ok: false,
      errorCode: payload.errorCode ?? null,
      error: payload.error,
    };
  }

  input.addEmptyProject(
    normalizedServerId,
    normalizeProjectWithoutWorkspacesDescriptor(payload.project),
  );
  input.setHasHydratedWorkspaces(normalizedServerId, true);
  return { ok: true };
}

export async function cloneProjectDirectly(
  input: CloneProjectDirectlyInput,
): Promise<OpenProjectResult> {
  const normalizedServerId = input.serverId.trim();
  const repoUrl = input.repoUrl.trim();
  const destinationParent = input.destinationParent.trim();
  const directoryName = input.directoryName?.trim();
  if (
    !normalizedServerId ||
    !repoUrl ||
    !destinationParent ||
    !input.client ||
    !input.isConnected
  ) {
    return { ok: false, errorCode: null, error: null };
  }

  if (!input.canCloneProject) {
    return {
      ok: false,
      errorCode: null,
      error: "Update the host to clone repositories from Paseo.",
    };
  }

  const payload = await input.client.cloneProject({
    repoUrl,
    destinationParent,
    ...(directoryName ? { directoryName } : {}),
  });
  if (payload.error || !payload.project) {
    return {
      ok: false,
      errorCode: payload.errorCode ?? null,
      error: payload.error,
      clonedPath: payload.clonedPath,
    };
  }

  input.addEmptyProject(
    normalizedServerId,
    normalizeProjectWithoutWorkspacesDescriptor(payload.project),
  );
  input.setHasHydratedWorkspaces(normalizedServerId, true);
  return { ok: true };
}
