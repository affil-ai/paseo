import { Buffer } from "node:buffer";

function encodeWorkspaceIdForPathSegment(workspaceId: string): string {
  const id = workspaceId.trim();
  if (/^[A-Za-z0-9._~-]+$/.test(id)) return id;
  const encoded = Buffer.from(id, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `b64_${encoded}`;
}

export function buildPaseoAgentUrl(input: {
  baseUrl: string;
  serverId: string;
  workspaceId: string;
  agentId: string;
}): string {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/g, "");
  const serverId = encodeURIComponent(input.serverId.trim());
  const workspaceId = encodeURIComponent(encodeWorkspaceIdForPathSegment(input.workspaceId));
  const openIntent = encodeURIComponent(`agent:${input.agentId.trim()}`);
  return `${baseUrl}/h/${serverId}/workspace/${workspaceId}?open=${openIntent}`;
}
