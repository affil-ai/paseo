import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, MessageSquare } from "lucide-react-native";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import {
  useWorkspaceStructure,
  type WorkspaceStructureProject,
} from "@/stores/session-store-hooks";

interface ChatOfficePageProps {
  serverId: string;
}

interface ChatDefaultsDraft extends Record<string, unknown> {
  provider: string;
  model: string;
  modeId: string;
  thinkingOptionId: string;
}

interface ChatEmailDraft extends Record<string, unknown> {
  resendApiKey: string;
  resendWebhookSecret: string;
  channel: string;
  supportAddress: string;
}

interface ChatRepositoryDraft extends Record<string, unknown> {
  projectId: string;
  projectRootPath: string;
  projectDisplayName: string;
}

interface ChatDefaultOption {
  id: string;
  label: string;
}

const ROW_WITH_BORDER_STYLE = [settingsStyles.row, settingsStyles.rowBorder];

function triggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

function defaultsFromConfig(config: MutableDaemonConfig | null): ChatDefaultsDraft {
  const defaults = config?.chat.defaults ?? {};
  return {
    provider: typeof defaults.provider === "string" ? defaults.provider : "",
    model: typeof defaults.model === "string" ? defaults.model : "",
    modeId: typeof defaults.modeId === "string" ? defaults.modeId : "",
    thinkingOptionId:
      typeof defaults.thinkingOptionId === "string" ? defaults.thinkingOptionId : "",
  };
}

function normalizeDraft(draft: ChatDefaultsDraft): ChatDefaultsDraft {
  return {
    provider: draft.provider.trim(),
    model: draft.model.trim(),
    modeId: draft.modeId.trim(),
    thinkingOptionId: draft.thinkingOptionId.trim(),
  };
}

function emailFromConfig(config: MutableDaemonConfig | null): ChatEmailDraft {
  const email = config?.chat.email ?? {};
  return {
    resendApiKey: typeof email.resendApiKey === "string" ? email.resendApiKey : "",
    resendWebhookSecret:
      typeof email.resendWebhookSecret === "string" ? email.resendWebhookSecret : "",
    channel: typeof email.channel === "string" ? email.channel : "",
    supportAddress: typeof email.supportAddress === "string" ? email.supportAddress : "",
  };
}

function normalizeEmailDraft(draft: ChatEmailDraft): ChatEmailDraft {
  return {
    resendApiKey: draft.resendApiKey.trim(),
    resendWebhookSecret: draft.resendWebhookSecret.trim(),
    channel: draft.channel.trim(),
    supportAddress: draft.supportAddress.trim(),
  };
}

function repositoryFromConfig(config: MutableDaemonConfig | null): ChatRepositoryDraft {
  const repository = config?.chat.repository as Partial<ChatRepositoryDraft> | undefined;
  return {
    projectId: typeof repository?.projectId === "string" ? repository.projectId : "",
    projectRootPath:
      typeof repository?.projectRootPath === "string" ? repository.projectRootPath : "",
    projectDisplayName:
      typeof repository?.projectDisplayName === "string" ? repository.projectDisplayName : "",
  };
}

function normalizeRepositoryDraft(draft: ChatRepositoryDraft): ChatRepositoryDraft {
  return {
    projectId: draft.projectId.trim(),
    projectRootPath: draft.projectRootPath.trim(),
    projectDisplayName: draft.projectDisplayName.trim(),
  };
}

function projectWorkspaceCountLabel(count: number): string {
  return count === 1 ? "1 workspace" : `${count} workspaces`;
}

function getProjectRootForHost(project: WorkspaceStructureProject, serverId: string): string {
  return (
    project.hosts.find((host) => host.serverId === serverId)?.iconWorkingDir.trim() ??
    project.iconWorkingDir.trim()
  );
}

function ChatRepositoryRow({
  serverId,
  config,
  patchConfig,
}: {
  serverId: string;
  config: MutableDaemonConfig | null;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<unknown>;
}) {
  const structure = useWorkspaceStructure(useMemo(() => [serverId], [serverId]));
  const [savingProjectKey, setSavingProjectKey] = useState<string | null>(null);
  const repository = useMemo(
    () => normalizeRepositoryDraft(repositoryFromConfig(config)),
    [config],
  );
  const projects = useMemo(
    () =>
      structure.projects.filter((project) => getProjectRootForHost(project, serverId).length > 0),
    [structure.projects, serverId],
  );
  const selectedProject = projects.find((project) => project.projectKey === repository.projectId);
  const selectedLabel =
    selectedProject?.projectName || repository.projectDisplayName || "Select project";

  const handleSelect = useCallback(
    async (projectKey: string) => {
      const project = projects.find((candidate) => candidate.projectKey === projectKey);
      if (!project) return;
      const projectRootPath = getProjectRootForHost(project, serverId);
      if (!projectRootPath) return;
      setSavingProjectKey(project.projectKey);
      try {
        await patchConfig({
          chat: {
            repository: {
              projectId: project.projectKey,
              projectRootPath,
              projectDisplayName: project.projectName,
            },
          },
        });
      } finally {
        setSavingProjectKey(null);
      }
    },
    [patchConfig, projects, serverId],
  );

  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Main chat project</Text>
        <Text style={settingsStyles.rowHint}>
          Each new Slack or email thread creates a workspace from the selected project repo root.
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger style={triggerStyle} accessibilityLabel="Select main chat project">
          <Text style={styles.triggerText} numberOfLines={1}>
            {savingProjectKey ? "Saving..." : selectedLabel}
          </Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={320}>
          {projects.length === 0 ? (
            <DropdownMenuItem disabled>No projects</DropdownMenuItem>
          ) : (
            projects.map((project) => (
              <ProjectMenuItem
                key={project.projectKey}
                project={project}
                selectedProjectKey={repository.projectId || selectedProject?.projectKey || null}
                onSelect={handleSelect}
              />
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function ProjectMenuItem({
  project,
  selectedProjectKey,
  onSelect,
}: {
  project: WorkspaceStructureProject;
  selectedProjectKey: string | null;
  onSelect: (projectKey: string) => Promise<void>;
}) {
  const handleSelect = useCallback(() => {
    void onSelect(project.projectKey);
  }, [onSelect, project.projectKey]);
  return (
    <DropdownMenuItem selected={selectedProjectKey === project.projectKey} onSelect={handleSelect}>
      {`${project.projectName} · ${projectWorkspaceCountLabel(project.workspaceKeys.length)}`}
    </DropdownMenuItem>
  );
}

function ProviderRow({
  draft,
  setDraft,
  providers,
}: {
  draft: ChatDefaultsDraft;
  setDraft: (draft: ChatDefaultsDraft) => void;
  providers: ProviderSnapshotEntry[];
}) {
  const label =
    providers.find((entry) => entry.provider === draft.provider)?.label ??
    (draft.provider || "Provider");
  return (
    <View style={ROW_WITH_BORDER_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Default provider</Text>
        <Text style={settingsStyles.rowHint}>
          Provider used when Slack starts a new office chat.
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger style={triggerStyle} accessibilityLabel="Select chat provider">
          <Text style={styles.triggerText}>{label}</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={220}>
          {providers.map((provider) => (
            <ProviderMenuItem
              key={provider.provider}
              provider={provider}
              selected={draft.provider === provider.provider}
              draft={draft}
              setDraft={setDraft}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function ProviderMenuItem({
  provider,
  selected,
  draft,
  setDraft,
}: {
  provider: ProviderSnapshotEntry;
  selected: boolean;
  draft: ChatDefaultsDraft;
  setDraft: (draft: ChatDefaultsDraft) => void;
}) {
  const handleSelect = useCallback(() => {
    const model = resolveDefaultModel(provider.models ?? []);
    setDraft({
      ...draft,
      provider: provider.provider,
      model: model?.id ?? "",
      modeId: provider.defaultModeId ?? provider.modes?.[0]?.id ?? "",
      thinkingOptionId: model?.defaultThinkingOptionId ?? model?.thinkingOptions?.[0]?.id ?? "",
    });
  }, [draft, provider, setDraft]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {provider.label ?? provider.provider}
    </DropdownMenuItem>
  );
}

function resolveDefaultModel(models: readonly AgentModelDefinition[]): AgentModelDefinition | null {
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

function includeCurrentOption(
  options: ChatDefaultOption[],
  currentId: string,
): ChatDefaultOption[] {
  if (!currentId || options.some((option) => option.id === currentId)) {
    return options;
  }
  return [...options, { id: currentId, label: currentId }];
}

function SelectSettingRow({
  label,
  hint,
  value,
  options,
  onSelect,
}: {
  label: string;
  hint: string;
  value: string;
  options: ChatDefaultOption[];
  onSelect: (value: string) => void;
}) {
  const selectedLabel = options.find((option) => option.id === value)?.label ?? value;
  return (
    <View style={ROW_WITH_BORDER_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={triggerStyle}
          accessibilityLabel={`Select ${label.toLowerCase()}`}
        >
          <Text style={styles.triggerText} numberOfLines={1}>
            {selectedLabel}
          </Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={280}>
          {options.map((option) => (
            <SelectSettingMenuItem
              key={option.id || "__default__"}
              option={option}
              selected={value === option.id}
              onSelect={onSelect}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function SelectSettingMenuItem({
  option,
  selected,
  onSelect,
}: {
  option: ChatDefaultOption;
  selected: boolean;
  onSelect: (value: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {option.label}
    </DropdownMenuItem>
  );
}

function TextSettingRow({
  label,
  hint,
  value,
  placeholder,
  onChangeText,
  border = true,
  secureTextEntry = false,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChangeText: (value: string) => void;
  border?: boolean;
  secureTextEntry?: boolean;
}) {
  const { theme } = useUnistyles();
  const rowStyle = useMemo(() => (border ? ROW_WITH_BORDER_STYLE : settingsStyles.row), [border]);
  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <TextInput
        value={value}
        placeholder={placeholder}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.colors.foregroundMuted}
        secureTextEntry={secureTextEntry}
        style={styles.input}
      />
    </View>
  );
}

function EmailIntakeSection({
  config,
  patchConfig,
}: {
  config: MutableDaemonConfig | null;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<ChatEmailDraft>(() => emailFromConfig(config));
  const [saving, setSaving] = useState(false);
  const committedDraft = useMemo(() => emailFromConfig(config), [config]);
  const normalizedDraft = useMemo(() => normalizeEmailDraft(draft), [draft]);
  const hasChanges = JSON.stringify(normalizedDraft) !== JSON.stringify(committedDraft);

  useEffect(() => {
    setDraft(emailFromConfig(config));
  }, [config]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await patchConfig({ chat: { email: normalizedDraft } });
    } finally {
      setSaving(false);
    }
  }, [normalizedDraft, patchConfig]);
  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);
  const handleApiKeyChange = useCallback(
    (resendApiKey: string) => setDraft((current) => ({ ...current, resendApiKey })),
    [],
  );
  const handleWebhookSecretChange = useCallback(
    (resendWebhookSecret: string) => setDraft((current) => ({ ...current, resendWebhookSecret })),
    [],
  );
  const handleChannelChange = useCallback(
    (channel: string) => setDraft((current) => ({ ...current, channel })),
    [],
  );
  const handleSupportAddressChange = useCallback(
    (supportAddress: string) => setDraft((current) => ({ ...current, supportAddress })),
    [],
  );
  const saveButton = useMemo(
    () => (
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasChanges || saving}
        onPress={handleSavePress}
      >
        {saving ? "Saving" : "Save"}
      </Button>
    ),
    [handleSavePress, hasChanges, saving],
  );

  return (
    <SettingsSection title="Email intake" trailing={saveButton}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Support email triage</Text>
            <Text style={settingsStyles.rowHint}>
              Inbound Resend emails start office agents and announce in a Slack channel. Point the
              Resend webhook at /support-email/resend on the bridge host.
            </Text>
          </View>
        </View>
        <TextSettingRow
          label="Resend API key"
          hint="Used to fetch full messages and attachments."
          value={draft.resendApiKey}
          placeholder="re_..."
          onChangeText={handleApiKeyChange}
          secureTextEntry
        />
        <TextSettingRow
          label="Resend webhook secret"
          hint="Svix signing secret from the Resend webhook."
          value={draft.resendWebhookSecret}
          placeholder="whsec_..."
          onChangeText={handleWebhookSecretChange}
          secureTextEntry
        />
        <TextSettingRow
          label="Slack channel"
          hint="Channel name or ID where each email gets an announce thread."
          value={draft.channel}
          placeholder="support-emails"
          onChangeText={handleChannelChange}
        />
        <TextSettingRow
          label="Support address"
          hint="Optional. Excluded from thread matching; its domain marks internal senders."
          value={draft.supportAddress}
          placeholder="support@example.com"
          onChangeText={handleSupportAddressChange}
        />
      </View>
    </SettingsSection>
  );
}

export function ChatOfficePage({ serverId }: ChatOfficePageProps) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const providersSnapshot = useProvidersSnapshot(serverId, { cwd: null });
  const providers = useMemo(
    () =>
      (providersSnapshot.entries ?? []).filter(
        (entry) => entry.enabled && entry.status !== "unavailable",
      ),
    [providersSnapshot.entries],
  );
  const [draft, setDraft] = useState<ChatDefaultsDraft>(() => defaultsFromConfig(config));
  const [saving, setSaving] = useState(false);
  const committedDraft = useMemo(() => defaultsFromConfig(config), [config]);
  const normalizedDraft = useMemo(() => normalizeDraft(draft), [draft]);
  const hasChanges = JSON.stringify(normalizedDraft) !== JSON.stringify(committedDraft);
  const selectedProvider = providers.find((entry) => entry.provider === draft.provider) ?? null;
  const modelOptions = useMemo(
    () =>
      includeCurrentOption(
        [
          { id: "", label: "Provider default" },
          ...(selectedProvider?.models ?? []).map((model) => ({
            id: model.id,
            label: model.label,
          })),
        ],
        draft.model,
      ),
    [draft.model, selectedProvider?.models],
  );
  const modeOptions = useMemo(
    () =>
      includeCurrentOption(
        [
          { id: "", label: "Provider default" },
          ...(selectedProvider?.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
        ],
        draft.modeId,
      ),
    [draft.modeId, selectedProvider?.modes],
  );
  const effectiveModel =
    selectedProvider?.models?.find((model) => model.id === draft.model) ??
    resolveDefaultModel(selectedProvider?.models ?? []);
  const thinkingOptions = useMemo(
    () =>
      includeCurrentOption(
        [
          { id: "", label: "Model default" },
          ...(effectiveModel?.thinkingOptions ?? []).map((option) => ({
            id: option.id,
            label: option.label,
          })),
        ],
        draft.thinkingOptionId,
      ),
    [draft.thinkingOptionId, effectiveModel?.thinkingOptions],
  );

  useEffect(() => {
    setDraft(defaultsFromConfig(config));
  }, [config]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await patchConfig({ chat: { defaults: normalizedDraft } });
    } finally {
      setSaving(false);
    }
  }, [normalizedDraft, patchConfig]);
  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);
  const handleModelChange = useCallback(
    (model: string) => {
      const selectedModel = selectedProvider?.models?.find((entry) => entry.id === model) ?? null;
      setDraft((current) => ({
        ...current,
        model,
        thinkingOptionId:
          selectedModel?.defaultThinkingOptionId ?? selectedModel?.thinkingOptions?.[0]?.id ?? "",
      }));
    },
    [selectedProvider?.models],
  );
  const handleModeIdChange = useCallback(
    (modeId: string) => setDraft((current) => ({ ...current, modeId })),
    [],
  );
  const handleThinkingOptionIdChange = useCallback(
    (thinkingOptionId: string) => setDraft((current) => ({ ...current, thinkingOptionId })),
    [],
  );
  const saveButton = useMemo(
    () => (
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasChanges || saving}
        onPress={handleSavePress}
      >
        {saving ? "Saving" : "Save"}
      </Button>
    ),
    [handleSavePress, hasChanges, saving],
  );

  return (
    <View>
      <SettingsSection title="Office chat" trailing={saveButton}>
        <View style={settingsStyles.card}>
          <ChatRepositoryRow serverId={serverId} config={config} patchConfig={patchConfig} />
          <ProviderRow draft={draft} setDraft={setDraft} providers={providers} />
          <SelectSettingRow
            label="Default model"
            hint="Model used for new office chats."
            value={draft.model}
            options={modelOptions}
            onSelect={handleModelChange}
          />
          <SelectSettingRow
            label="Default mode"
            hint="Changes the agent workflow and tool behavior, such as plan versus code."
            value={draft.modeId}
            options={modeOptions}
            onSelect={handleModeIdChange}
          />
          <SelectSettingRow
            label="Thinking"
            hint="Controls the selected model's reasoning effort; higher levels can be slower."
            value={draft.thinkingOptionId}
            options={thinkingOptions}
            onSelect={handleThinkingOptionIdChange}
          />
        </View>
      </SettingsSection>
      <EmailIntakeSection config={config} patchConfig={patchConfig} />
      <SettingsSection title="Runtime">
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Bridge config source</Text>
              <Text style={settingsStyles.rowHint}>
                The chat bridge reads these values from $PASEO_HOME/config.json on startup.
              </Text>
            </View>
            <View style={styles.runtimeBadge}>
              <MessageSquare size={14} color="#a1a1aa" />
              <Text style={styles.runtimeBadgeText}>config.json</Text>
            </View>
          </View>
          <View style={ROW_WITH_BORDER_STYLE}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Restart required</Text>
              <Text style={settingsStyles.rowHint}>
                Restart the deployed Paseo service after changing defaults.
              </Text>
            </View>
            <Check size={16} color="#22c55e" />
          </View>
        </View>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    alignItems: "center",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "center",
    maxWidth: 260,
    minHeight: 36,
    paddingHorizontal: theme.spacing[3],
  },
  triggerPressed: {
    opacity: 0.82,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    minHeight: 36,
    minWidth: 220,
    paddingHorizontal: theme.spacing[3],
  },
  runtimeBadge: {
    alignItems: "center",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  runtimeBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
