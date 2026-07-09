import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { usePrDiffQuery } from "@/git/use-pr-diff-query";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { Theme } from "@/styles/theme";
import type { DiffHunk, DiffLine, ParsedDiffFile } from "@/utils/diff-highlighter";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedX = withUnistyles(X);

const mutedIconUniProps = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface GithubPrDiffPaneProps {
  serverId: string;
  /** Project repo root on the host — where the daemon runs `gh pr diff`. */
  cwd: string;
  number: number;
  title: string;
  url: string;
  onClose: () => void;
}

/**
 * Read-only PR review pane fed by GitHub (`gh pr diff`) instead of a local
 * checkout. Used by the dashboard for PRs that have no Paseo workspace.
 */
export function GithubPrDiffPane({
  serverId,
  cwd,
  number,
  title,
  url,
  onClose,
}: GithubPrDiffPaneProps) {
  const query = usePrDiffQuery({ serverId, cwd, number });
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(EMPTY_PATH_SET);

  const handleOpenOnGithub = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);

  const handleToggleFile = useCallback((path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleRetry = useCallback(() => {
    void query.refetch();
  }, [query]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerNumber}>#{number}</Text>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        <Pressable
          style={iconButtonStyle}
          onPress={handleOpenOnGithub}
          accessibilityRole="link"
          accessibilityLabel="Open on GitHub"
        >
          <ThemedExternalLink size={14} uniProps={mutedIconUniProps} />
        </Pressable>
        <Pressable
          style={iconButtonStyle}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close review"
          testID="pr-diff-pane-close"
        >
          <ThemedX size={16} uniProps={mutedIconUniProps} />
        </Pressable>
      </View>

      <PaneBody
        query={query}
        collapsedPaths={collapsedPaths}
        onToggleFile={handleToggleFile}
        onRetry={handleRetry}
      />
    </View>
  );
}

function PaneBody({
  query,
  collapsedPaths,
  onToggleFile,
  onRetry,
}: {
  query: ReturnType<typeof usePrDiffQuery>;
  collapsedPaths: ReadonlySet<string>;
  onToggleFile: (path: string) => void;
  onRetry: () => void;
}) {
  if (query.isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }
  if (query.isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>
          {query.error instanceof Error ? query.error.message : "Unable to load pull request diff"}
        </Text>
        <Button size="sm" variant="outline" onPress={onRetry}>
          Retry
        </Button>
      </View>
    );
  }
  return (
    <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
      {query.data?.files.length === 0 ? (
        <Text style={styles.emptyText}>No changes</Text>
      ) : (
        query.data?.files.map((file) => (
          <DiffFileSection
            key={file.path}
            file={file}
            collapsed={collapsedPaths.has(file.path)}
            onToggle={onToggleFile}
          />
        ))
      )}
      {query.data?.truncated ? (
        <Text style={styles.truncatedText}>
          Diff truncated — open on GitHub for the full change
        </Text>
      ) : null}
    </ScrollView>
  );
}

const EMPTY_PATH_SET: ReadonlySet<string> = new Set();

const DiffFileSection = memo(function DiffFileSection({
  file,
  collapsed,
  onToggle,
}: {
  file: ParsedDiffFile;
  collapsed: boolean;
  onToggle: (path: string) => void;
}) {
  const handleToggle = useCallback(() => onToggle(file.path), [onToggle, file.path]);

  return (
    <View style={styles.fileSection}>
      <Pressable
        style={fileHeaderStyle}
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityLabel={`Toggle ${file.path}`}
      >
        {collapsed ? (
          <ThemedChevronRight size={13} uniProps={mutedIconUniProps} />
        ) : (
          <ThemedChevronDown size={13} uniProps={mutedIconUniProps} />
        )}
        <Text style={styles.filePath} numberOfLines={1}>
          {file.path}
        </Text>
        {file.isNew ? <Text style={styles.fileTagNew}>new</Text> : null}
        {file.isDeleted ? <Text style={styles.fileTagDeleted}>deleted</Text> : null}
        <Text style={styles.fileAdditions}>+{file.additions}</Text>
        <Text style={styles.fileDeletions}>−{file.deletions}</Text>
      </Pressable>
      {collapsed ? null : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            {file.hunks.map((hunk) => (
              <DiffHunkBlock key={`${hunk.oldStart}:${hunk.newStart}`} hunk={hunk} />
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
});

function DiffHunkBlock({ hunk }: { hunk: DiffHunk }) {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  const keyedLines = useMemo(() => {
    let offset = 0;
    return hunk.lines.map((line) => {
      const key = `${hunk.oldStart}:${hunk.newStart}:${offset}`;
      offset += 1;
      return { key, line };
    });
  }, [hunk]);
  return (
    <View>
      <Text style={styles.hunkHeader}>{header}</Text>
      {keyedLines.map(({ key, line }) => (
        <DiffLineRow key={key} lineKey={key} line={line} />
      ))}
    </View>
  );
}

function lineContainerStyle(type: DiffLine["type"]) {
  switch (type) {
    case "add":
      return styles.addLineContainer;
    case "remove":
      return styles.removeLineContainer;
    default:
      return styles.contextLineContainer;
  }
}

const LINE_MARKERS: Record<string, string> = { add: "+", remove: "−" };

function DiffLineRow({ line, lineKey }: { line: DiffLine; lineKey: string }) {
  if (line.type === "header") {
    return null;
  }
  return (
    <View style={lineContainerStyle(line.type)} testID={lineKey}>
      <Text style={styles.lineMarker}>{LINE_MARKERS[line.type] ?? " "}</Text>
      <LineContent line={line} />
    </View>
  );
}

function LineContent({ line }: { line: DiffLine }) {
  const keyedTokens = useMemo(
    () =>
      line.tokens?.map((token, index) => ({
        key: `${index}-${token.text}`,
        token,
      })) ?? null,
    [line.tokens],
  );

  if (!keyedTokens) {
    return <Text style={styles.lineText}>{line.content || " "}</Text>;
  }
  return (
    <Text style={styles.lineText}>
      {keyedTokens.map(({ key, token }) => (
        <Text key={key} style={syntaxTokenStyleFor(token.style)}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerNumber: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  iconButton: {
    padding: 2,
    borderRadius: 4,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
  truncatedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingBottom: theme.spacing[6],
  },
  fileSection: {
    marginTop: theme.spacing[2],
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  fileHeaderHovered: {
    backgroundColor: theme.colors.surface1,
  },
  filePath: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  fileTagNew: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.xs,
  },
  fileTagDeleted: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
  fileAdditions: {
    marginLeft: "auto",
    color: theme.colors.diffAddition,
    fontSize: theme.fontSize.xs,
  },
  fileDeletions: {
    color: theme.colors.diffDeletion,
    fontSize: theme.fontSize.xs,
  },
  hunkHeader: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    fontFamily: theme.fontFamily.mono,
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
  },
  addLineContainer: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[3],
    backgroundColor: "rgba(46, 160, 67, 0.15)",
  },
  removeLineContainer: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[3],
    backgroundColor: "rgba(248, 81, 73, 0.1)",
  },
  contextLineContainer: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[3],
  },
  lineMarker: {
    width: 14,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    fontFamily: theme.fontFamily.mono,
  },
  lineText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    fontFamily: theme.fontFamily.mono,
  },
}));

function iconButtonStyle({ hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.iconButton, hovered && styles.iconButtonHovered];
}

function fileHeaderStyle({ hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.fileHeader, hovered && styles.fileHeaderHovered];
}
