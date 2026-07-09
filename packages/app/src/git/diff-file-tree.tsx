import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SvgXml } from "react-native-svg";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { getFileIconSvg } from "@/components/material-file-icons";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const mutedIconUniProps = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface DiffFileTreeProps {
  files: ParsedDiffFile[];
  /** Path of the file the diff list is focused on; highlighted in the tree. */
  activePath: string | null;
  onSelectFile: (path: string) => void;
}

interface TreeDir {
  kind: "dir";
  /** Display label — single-child directory chains are compressed ("a/b/c"). */
  label: string;
  /** Full directory path from the repo root, for stable keys + collapse state. */
  path: string;
  children: TreeNode[];
}

interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  additions: number;
  deletions: number;
}

type TreeNode = TreeDir | TreeFile;

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: TreeFile[];
}

function insertFile(root: MutableDir, file: ParsedDiffFile): void {
  const segments = file.path.split("/");
  const fileName = segments.pop() ?? file.path;
  let node = root;
  for (const segment of segments) {
    let child = node.dirs.get(segment);
    if (!child) {
      child = { dirs: new Map(), files: [] };
      node.dirs.set(segment, child);
    }
    node = child;
  }
  node.files.push({
    kind: "file",
    name: fileName,
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
  });
}

// Collapse single-child directory chains (GitHub-style: "apps/web/src") so deep
// monorepo paths don't waste horizontal space on nesting.
function finalizeDir(label: string, path: string, node: MutableDir): TreeDir {
  let currentLabel = label;
  let currentPath = path;
  let current = node;
  while (current.files.length === 0 && current.dirs.size === 1) {
    const [childName, childNode] = current.dirs.entries().next().value as [string, MutableDir];
    currentLabel = currentLabel ? `${currentLabel}/${childName}` : childName;
    currentPath = currentPath ? `${currentPath}/${childName}` : childName;
    current = childNode;
  }
  const childDirs = Array.from(current.dirs.entries())
    .map(([name, child]) => finalizeDir(name, currentPath ? `${currentPath}/${name}` : name, child))
    .sort((a, b) => a.label.localeCompare(b.label));
  const childFiles = [...current.files].sort((a, b) => a.name.localeCompare(b.name));
  return {
    kind: "dir",
    label: currentLabel,
    path: currentPath,
    children: [...childDirs, ...childFiles],
  };
}

export function buildDiffFileTree(files: ParsedDiffFile[]): TreeNode[] {
  const root: MutableDir = { dirs: new Map(), files: [] };
  for (const file of files) {
    insertFile(root, file);
  }
  const dirs = Array.from(root.dirs.entries())
    .map(([name, node]) => finalizeDir(name, name, node))
    .sort((a, b) => a.label.localeCompare(b.label));
  const rootFiles = [...root.files].sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...rootFiles];
}

/**
 * Collapsible file tree for a diff, GitHub-PR style: directories (compressed
 * chains) with chevrons, files with material icons and +/- counts. Selecting a
 * file asks the parent to focus it in the diff list.
 */
export function DiffFileTree({ files, activePath, onSelectFile }: DiffFileTreeProps) {
  const tree = useMemo(() => buildDiffFileTree(files), [files]);
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(EMPTY_SET);

  const handleToggleDir = useCallback((path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <ScrollView
      style={styles.tree}
      contentContainerStyle={styles.treeContent}
      showsVerticalScrollIndicator={false}
      testID="diff-file-tree"
    >
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          collapsedDirs={collapsedDirs}
          onToggleDir={handleToggleDir}
          onSelectFile={onSelectFile}
        />
      ))}
    </ScrollView>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();

const TreeNodeRow = memo(function TreeNodeRow({
  node,
  depth,
  activePath,
  collapsedDirs,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  if (node.kind === "dir") {
    return (
      <DirRow
        node={node}
        depth={depth}
        activePath={activePath}
        collapsedDirs={collapsedDirs}
        onToggleDir={onToggleDir}
        onSelectFile={onSelectFile}
      />
    );
  }
  return (
    <FileRow
      node={node}
      depth={depth}
      isActive={node.path === activePath}
      onSelectFile={onSelectFile}
    />
  );
});

function DirRow({
  node,
  depth,
  activePath,
  collapsedDirs,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeDir;
  depth: number;
  activePath: string | null;
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const collapsed = collapsedDirs.has(node.path);
  const handleToggle = useCallback(() => onToggleDir(node.path), [node.path, onToggleDir]);
  const rowStyle = useCallback(
    ({ hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.row,
      { paddingLeft: rowIndent(depth) },
      hovered && styles.rowHovered,
    ],
    [depth],
  );

  return (
    <View>
      <Pressable
        style={rowStyle}
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityLabel={`Toggle ${node.label}`}
      >
        {collapsed ? (
          <ThemedChevronRight size={13} uniProps={mutedIconUniProps} />
        ) : (
          <ThemedChevronDown size={13} uniProps={mutedIconUniProps} />
        )}
        <Text style={styles.dirLabel} numberOfLines={1}>
          {node.label}
        </Text>
      </Pressable>
      {collapsed
        ? null
        : node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              collapsedDirs={collapsedDirs}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
    </View>
  );
}

const FileRow = memo(function FileRow({
  node,
  depth,
  isActive,
  onSelectFile,
}: {
  node: TreeFile;
  depth: number;
  isActive: boolean;
  onSelectFile: (path: string) => void;
}) {
  const handlePress = useCallback(() => onSelectFile(node.path), [node.path, onSelectFile]);
  const iconXml = useMemo(() => getFileIconSvg(node.name), [node.name]);
  const rowStyle = useCallback(
    ({ hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.row,
      { paddingLeft: rowIndent(depth) + FILE_EXTRA_INDENT },
      isActive && styles.rowActive,
      hovered && !isActive && styles.rowHovered,
    ],
    [depth, isActive],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Show diff for ${node.path}`}
    >
      <SvgXml xml={iconXml} width={14} height={14} />
      <Text style={isActive ? styles.fileNameActive : styles.fileName} numberOfLines={1}>
        {node.name}
      </Text>
      <View style={styles.counts}>
        {node.additions > 0 ? <Text style={styles.additions}>+{node.additions}</Text> : null}
        {node.deletions > 0 ? <Text style={styles.deletions}>−{node.deletions}</Text> : null}
      </View>
    </Pressable>
  );
});

const BASE_INDENT = 8;
const INDENT_PER_LEVEL = 14;
// Files sit one chevron-width deeper than their directory label.
const FILE_EXTRA_INDENT = 17;

function rowIndent(depth: number): number {
  return BASE_INDENT + depth * INDENT_PER_LEVEL;
}

const styles = StyleSheet.create((theme) => ({
  tree: {
    flex: 1,
    minHeight: 0,
  },
  treeContent: {
    paddingVertical: theme.spacing[2],
    paddingRight: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: 3,
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowActive: {
    backgroundColor: theme.colors.surface2,
  },
  dirLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  fileName: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  fileNameActive: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  counts: {
    flexDirection: "row",
    gap: theme.spacing[1],
    marginLeft: "auto",
    flexShrink: 0,
  },
  additions: {
    color: theme.colors.diffAddition,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
  deletions: {
    color: theme.colors.diffDeletion,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
}));
