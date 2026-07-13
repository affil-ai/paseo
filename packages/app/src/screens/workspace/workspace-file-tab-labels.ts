import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

function fileBasename(path: string): string {
  return path.split("/").findLast(Boolean) ?? path;
}

function parentFolderLabel(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(-2).join("/");
}

/**
 * When multiple open file tabs share the same file name, distinguishing them by
 * name alone is impossible. This computes disambiguated labels that prefix the
 * immediate parent folder (e.g. "folder/file.ts") — never the full path.
 * Returns a map from file path to its display label, containing only the paths
 * that actually need disambiguation.
 */
export function buildFileTabLabelOverrides(
  tabs: readonly WorkspaceTabDescriptor[],
): Map<string, string> {
  const pathsByName = new Map<string, string[]>();
  for (const tab of tabs) {
    if (tab.target.kind !== "file") {
      continue;
    }
    const { path } = tab.target;
    const name = fileBasename(path);
    const existing = pathsByName.get(name);
    if (existing) {
      if (!existing.includes(path)) {
        existing.push(path);
      }
    } else {
      pathsByName.set(name, [path]);
    }
  }

  const overrides = new Map<string, string>();
  for (const paths of pathsByName.values()) {
    if (paths.length < 2) {
      continue;
    }
    for (const path of paths) {
      overrides.set(path, parentFolderLabel(path));
    }
  }

  return overrides;
}
