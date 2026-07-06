import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Modal, View, Text, TextInput, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { GitBranch, FolderOpen, Inbox, Plug, Smartphone } from "lucide-react-native";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { CommunityLinks } from "@/components/community-links";
import { MenuHeader } from "@/components/headers/menu-header";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";
import { useHostChooser } from "@/hosts/host-chooser";
import { usePanelStore } from "@/stores/panel-store";
import {
  useIsCompactFormFactor,
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { PairDeviceModal } from "@/desktop/components/pair-device-modal";
import { buildHostAgentDetailRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useCloneProject, useOpenProject } from "@/hooks/use-open-project";
import type { Href } from "expo-router";

export function OpenProjectScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const openDesktopAgentList = usePanelStore((s) => s.openDesktopAgentList);
  const openProjectPicker = useOpenProjectPicker();
  const chooseHost = useHostChooser();
  const localServerId = useLocalDaemonServerId();
  const [importServerId, setImportServerId] = useState<string | null>(null);
  const importClient = useHostRuntimeClient(importServerId ?? "");
  const openImportedProject = useOpenProject(importServerId);
  const [isPairDeviceOpen, setIsPairDeviceOpen] = useState(false);
  const [isImportSheetOpen, setIsImportSheetOpen] = useState(false);
  const [cloneServerId, setCloneServerId] = useState<string | null>(null);
  const [isCloneModalOpen, setIsCloneModalOpen] = useState(false);

  const isCompactLayout = useIsCompactFormFactor();

  useEffect(() => {
    if (!isCompactLayout) {
      openDesktopAgentList();
    }
  }, [isCompactLayout, openDesktopAgentList]);

  const handleOpenPicker = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleOpenClone = useCallback(() => {
    chooseHost({
      title: "Clone to host",
      onChooseHost: (serverId) => {
        setCloneServerId(serverId);
        setIsCloneModalOpen(true);
      },
    });
  }, [chooseHost]);

  const handleCloseClone = useCallback(() => setIsCloneModalOpen(false), []);

  const handleOpenPairDevice = useCallback(() => setIsPairDeviceOpen(true), []);
  const handleClosePairDevice = useCallback(() => setIsPairDeviceOpen(false), []);

  const handleOpenImportSession = useCallback(() => {
    chooseHost({
      title: "Import from host",
      onChooseHost: (serverId) => {
        setImportServerId(serverId);
        setIsImportSheetOpen(true);
      },
    });
  }, [chooseHost]);
  const handleCloseImportSession = useCallback(() => setIsImportSheetOpen(false), []);

  const handleImported = useCallback(
    (agent: { id: string; cwd: string }) => {
      if (!importServerId) return;
      void (async () => {
        const result = await openImportedProject(agent.cwd);
        if (result.ok) {
          router.push(buildHostAgentDetailRoute(importServerId, agent.id) as Href);
        }
      })();
    },
    [importServerId, openImportedProject, router],
  );

  const handleOpenProviders = useCallback(() => {
    chooseHost({
      title: "Choose host",
      onChooseHost: (serverId) => {
        router.push(buildSettingsHostSectionRoute(serverId, "providers"));
      },
    });
  }, [chooseHost, router]);

  return (
    <View style={styles.container}>
      <MenuHeader borderless />
      <View style={styles.content}>
        <TitlebarDragRegion />
        <View style={styles.logo}>
          <PaseoLogo size={52} />
        </View>
        <View style={styles.tiles}>
          <HomeTile
            icon={FolderOpen}
            title={t("openProject.tiles.addProject.title")}
            description={t("openProject.tiles.addProject.description")}
            onPress={handleOpenPicker}
            testID="open-project-submit"
            accent
          />
          <HomeTile
            icon={GitBranch}
            title={t("openProject.tiles.cloneRepository.title", {
              defaultValue: "Clone repository",
            })}
            description={t("openProject.tiles.cloneRepository.description", {
              defaultValue: "Pull a Git repo onto this host",
            })}
            onPress={handleOpenClone}
            testID="open-project-clone-repository"
            accent
          />
          <HomeTile
            icon={Inbox}
            title={t("openProject.tiles.importSession.title")}
            description={t("openProject.tiles.importSession.description")}
            onPress={handleOpenImportSession}
            testID="open-project-import-session"
          />
          <HomeTile
            icon={Plug}
            title={t("openProject.tiles.setupProviders.title")}
            description={t("openProject.tiles.setupProviders.description")}
            onPress={handleOpenProviders}
            testID="open-project-setup-providers"
          />
          {localServerId ? (
            <HomeTile
              icon={Smartphone}
              title={t("openProject.tiles.pairDevice.title")}
              description={t("openProject.tiles.pairDevice.description")}
              onPress={handleOpenPairDevice}
              testID="open-project-pair-device"
            />
          ) : null}
        </View>
      </View>
      <View style={styles.communityRow}>
        <CommunityLinks />
      </View>
      <PairDeviceModal
        visible={isPairDeviceOpen}
        onClose={handleClosePairDevice}
        testID="open-project-pair-device-modal"
      />
      <ImportSessionSheet
        visible={isImportSheetOpen}
        client={importClient}
        serverId={importServerId}
        onClose={handleCloseImportSession}
        onImported={handleImported}
      />
      <CloneRepositoryModal
        visible={isCloneModalOpen}
        serverId={cloneServerId}
        onClose={handleCloseClone}
      />
    </View>
  );
}

function CloneRepositoryModal({
  visible,
  serverId,
  onClose,
}: {
  visible: boolean;
  serverId: string | null;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const cloneProject = useCloneProject(serverId);
  const [repoUrl, setRepoUrl] = useState("");
  const [destinationParent, setDestinationParent] = useState("/workspace");
  const [directoryName, setDirectoryName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setRepoUrl("");
    setDestinationParent("/workspace");
    setDirectoryName("");
    setIsSubmitting(false);
    setErrorMessage(null);
  }, [visible]);

  const handleSubmit = useCallback(() => {
    if (!serverId || isSubmitting) return;
    const trimmedRepoUrl = repoUrl.trim();
    const trimmedDestinationParent = destinationParent.trim();
    if (!trimmedRepoUrl || !trimmedDestinationParent) {
      setErrorMessage(
        t("openProject.clone.errors.required", {
          defaultValue: "Enter a repository URL and destination path.",
        }),
      );
      return;
    }

    void (async () => {
      setErrorMessage(null);
      setIsSubmitting(true);
      try {
        const result = await cloneProject({
          repoUrl: trimmedRepoUrl,
          destinationParent: trimmedDestinationParent,
          ...(directoryName.trim() ? { directoryName: directoryName.trim() } : {}),
        });
        if (result.ok) {
          onClose();
          return;
        }
        setErrorMessage(result.error ?? "Unable to clone repository.");
      } finally {
        setIsSubmitting(false);
      }
    })();
  }, [cloneProject, destinationParent, directoryName, isSubmitting, onClose, repoUrl, serverId, t]);

  const panelStyle = useMemo(
    () => [
      styles.clonePanel,
      { backgroundColor: theme.colors.surface0, borderColor: theme.colors.border },
    ],
    [theme.colors.border, theme.colors.surface0],
  );
  const inputStyle = useMemo(
    () => [
      styles.cloneInput,
      {
        color: theme.colors.foreground,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
    ],
    [theme.colors.border, theme.colors.foreground, theme.colors.surface1],
  );
  const errorStyle = useMemo(
    () => [styles.cloneError, { color: theme.colors.destructive }],
    [theme.colors.destructive],
  );
  const secondaryActionTextStyle = useMemo(
    () => [styles.cloneSecondaryActionText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const primaryActionStyle = useMemo(
    () => [
      styles.clonePrimaryAction,
      { backgroundColor: theme.colors.accent },
      isSubmitting && styles.cloneActionDisabled,
    ],
    [isSubmitting, theme.colors.accent],
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.cloneOverlay}>
        <Pressable style={styles.cloneBackdrop} onPress={onClose} />
        <View style={panelStyle}>
          <Text style={styles.cloneTitle}>
            {t("openProject.clone.title", { defaultValue: "Clone repository" })}
          </Text>
          <Text style={styles.cloneLabel}>
            {t("openProject.clone.repoUrl", { defaultValue: "Git repository URL" })}
          </Text>
          <TextInput
            value={repoUrl}
            onChangeText={setRepoUrl}
            placeholder="https://github.com/affil-ai/paseo.git"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={inputStyle}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isSubmitting}
          />
          <Text style={styles.cloneLabel}>
            {t("openProject.clone.destinationParent", { defaultValue: "Destination parent" })}
          </Text>
          <TextInput
            value={destinationParent}
            onChangeText={setDestinationParent}
            placeholder="/workspace"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={inputStyle}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isSubmitting}
          />
          <Text style={styles.cloneLabel}>
            {t("openProject.clone.directoryName", { defaultValue: "Folder name (optional)" })}
          </Text>
          <TextInput
            value={directoryName}
            onChangeText={setDirectoryName}
            placeholder="paseo"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={inputStyle}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isSubmitting}
            onSubmitEditing={handleSubmit}
          />
          {errorMessage ? <Text style={errorStyle}>{errorMessage}</Text> : null}
          <View style={styles.cloneActions}>
            <Pressable
              style={styles.cloneSecondaryAction}
              onPress={onClose}
              disabled={isSubmitting}
            >
              <Text style={secondaryActionTextStyle}>
                {t("common.actions.cancel", { defaultValue: "Cancel" })}
              </Text>
            </Pressable>
            <Pressable style={primaryActionStyle} onPress={handleSubmit} disabled={isSubmitting}>
              <Text style={styles.clonePrimaryActionText}>
                {isSubmitting
                  ? t("openProject.clone.cloning", { defaultValue: "Cloning..." })
                  : t("openProject.clone.submit", { defaultValue: "Clone" })}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface HomeTileProps {
  icon: ComponentType<{ size: number; color: string }>;
  title: string;
  description: string;
  onPress: () => void;
  testID?: string;
  accent?: boolean;
}

function HomeTile({ icon: Icon, title, description, onPress, testID, accent }: HomeTileProps) {
  // useUnistyles is acceptable here: leaf component, off the hot path (home screen renders once).
  const { theme } = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const iconColor = accent ? theme.colors.accent : theme.colors.foregroundMuted;

  const pressableStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.tile,
      hovered && styles.tileHovered,
      pressed && styles.tilePressed,
    ],
    [hovered],
  );

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      testID={testID}
      style={pressableStyle}
    >
      <Icon size={20} color={iconColor} />
      <View style={styles.tileText}>
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileDescription}>{description}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  content: {
    position: "relative",
    flex: 1,
    justifyContent: { xs: "flex-start", md: "center" },
    alignItems: "center",
    gap: 0,
    padding: theme.spacing[6],
    paddingTop: { xs: theme.spacing[12], md: theme.spacing[6] },
    paddingBottom: {
      xs: HEADER_INNER_HEIGHT_MOBILE + HEADER_TOP_PADDING_MOBILE + theme.spacing[6],
      md: HEADER_INNER_HEIGHT + theme.spacing[6],
    },
  },
  logo: {
    marginBottom: theme.spacing[8],
  },
  tiles: {
    marginTop: { xs: theme.spacing[6], md: theme.spacing[12] },
    width: "100%",
    maxWidth: 452,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  tile: {
    width: { xs: "100%", md: 220 },
    minHeight: { xs: 0, md: 132 },
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    gap: theme.spacing[3],
  },
  tileHovered: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  tilePressed: {
    opacity: 0.85,
  },
  tileText: {
    gap: theme.spacing[1],
  },
  tileTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tileDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  communityRow: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: {
      xs: HEADER_INNER_HEIGHT_MOBILE + HEADER_TOP_PADDING_MOBILE + theme.spacing[2],
      md: HEADER_INNER_HEIGHT + theme.spacing[2],
    },
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 0,
  },
  cloneOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[4],
  },
  cloneBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  clonePanel: {
    width: 480,
    maxWidth: "100%",
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    ...theme.shadow.lg,
  },
  cloneTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  cloneLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  cloneInput: {
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.base,
    outlineStyle: "none",
  } as object,
  cloneError: {
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  cloneActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  cloneSecondaryAction: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  cloneSecondaryActionText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  clonePrimaryAction: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
  },
  cloneActionDisabled: {
    opacity: 0.6,
  },
  clonePrimaryActionText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
