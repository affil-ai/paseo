import type { AgentAttachment } from "@getpaseo/protocol/messages";

export function stripStructuredAttachmentMetadata(
  message: string,
  attachments: readonly AgentAttachment[],
): string {
  const uploadedFileBlocks = attachments.flatMap((attachment) =>
    attachment.type === "uploaded_file" ? [renderUploadedFileMetadata(attachment)] : [],
  );
  if (uploadedFileBlocks.length === 0) return message;

  let visibleMessage = message.trimEnd();
  let removedBlock = false;
  let foundSuffix = true;
  while (foundSuffix) {
    foundSuffix = false;
    for (const block of uploadedFileBlocks) {
      if (!visibleMessage.endsWith(block)) continue;
      visibleMessage = visibleMessage.slice(0, -block.length).trimEnd();
      removedBlock = true;
      foundSuffix = true;
      break;
    }
  }

  return removedBlock ? visibleMessage : message;
}

function renderUploadedFileMetadata(
  attachment: Extract<AgentAttachment, { type: "uploaded_file" }>,
): string {
  return [
    `Uploaded file: ${attachment.fileName}`,
    `Path: ${attachment.path}`,
    `MIME: ${attachment.mimeType}`,
    `Size: ${attachment.size} bytes`,
  ].join("\n");
}
