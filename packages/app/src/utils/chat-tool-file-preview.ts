export type ChatToolFilePreviewKind = "image" | "video" | "file";

export function getChatToolFilePreviewKind(file: {
  filename: string;
  mimeType?: string;
}): ChatToolFilePreviewKind {
  if (file.mimeType?.startsWith("image/")) return "image";
  if (file.mimeType?.startsWith("video/")) return "video";
  if (/\.(?:avif|gif|jpe?g|png|webp)$/i.test(file.filename)) return "image";
  if (/\.(?:m4v|mov|mp4|webm)$/i.test(file.filename)) return "video";
  return "file";
}
