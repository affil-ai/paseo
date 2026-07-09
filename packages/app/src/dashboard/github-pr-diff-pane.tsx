import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { DiffFilesPane } from "@/git/diff-pane";
import { usePrDiffQuery } from "@/git/use-pr-diff-query";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

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

const EMPTY_FILES: never[] = [];

/**
 * Read-only PR review pane fed by GitHub (`gh pr diff`) instead of a local
 * checkout. Used by the dashboard for PRs that have no Paseo workspace. The
 * diff body is the same DiffFilesPane as the workspace Changes tab, minus the
 * branch switcher and committed/uncommitted selector (there is no checkout to
 * switch) and the whitespace toggle (GitHub returns one fixed diff).
 */
export function GithubPrDiffPane({
  serverId,
  cwd,
  number,
  title,
  url,
  onClose,
}: GithubPrDiffPaneProps) {
  const { t } = useTranslation();
  const query = usePrDiffQuery({ serverId, cwd, number });

  const handleOpenOnGithub = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);

  // Expansion state persists per PR, mirroring the workspace pane's per-checkout key.
  const stateKey = `github-pr:${serverId}:${cwd}:${number}`;

  const files = query.data?.files ?? EMPTY_FILES;
  let errorMessage: string | null = null;
  if (query.isError) {
    errorMessage =
      query.error instanceof Error ? query.error.message : t("workspace.git.diff.failedRefresh");
  }

  const handleRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  const refresh = useMemo(
    () => ({ isRefreshing: query.isFetching, onRefresh: handleRefresh }),
    [handleRefresh, query.isFetching],
  );

  const truncated = query.data?.truncated === true;
  const truncatedBanner = useMemo(
    () =>
      truncated ? (
        <Text style={styles.truncatedText}>
          Diff truncated — open on GitHub for the full change
        </Text>
      ) : null,
    [truncated],
  );

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

      <DiffFilesPane
        files={files}
        stateKey={stateKey}
        isDiffLoading={query.isLoading}
        diffErrorMessage={errorMessage}
        emptyMessage={t("diffViewer.empty")}
        showToolbar
        showFileTree
        refresh={refresh}
        banner={truncatedBanner}
      />
    </View>
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
  truncatedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}));

function iconButtonStyle({ hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.iconButton, hovered && styles.iconButtonHovered];
}
