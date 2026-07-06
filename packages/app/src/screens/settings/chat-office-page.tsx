import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, MessageSquare } from "lucide-react-native";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";

interface ChatOfficePageProps {
  serverId: string;
}

interface ChatDefaultsDraft {
  provider: string;
  model: string;
  modeId: string;
  thinkingOptionId: string;
}

const ROW_WITH_BORDER_STYLE = [settingsStyles.row, settingsStyles.rowBorder];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function triggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

function defaultsFromConfig(config: MutableDaemonConfig | null): ChatDefaultsDraft {
  const chat = isRecord(config?.chat) ? config.chat : {};
  const defaults = isRecord(chat.defaults) ? chat.defaults : {};
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

function workspaceLabel(workspace: WorkspaceDescriptor): string {
  return (
    workspace.title ??
    workspace.projectCustomName ??
    workspace.projectDisplayName ??
    workspace.name ??
    workspace.workspaceDirectory
  );
}

function useHostWorkspaces(serverId: string): WorkspaceDescriptor[] {
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  return useMemo(
    () =>
      Array.from(workspaces?.values() ?? []).sort((a, b) =>
        workspaceLabel(a).localeCompare(workspaceLabel(b)),
      ),
    [workspaces],
  );
}

function ChatRepositoryRow({ serverId }: { serverId: string }) {
  const workspaces = useHostWorkspaces(serverId);
  const [savingWorkspaceId, setSavingWorkspaceId] = useState<string | null>(null);
  const selectedWorkspace = workspaces.find((workspace) => workspace.chatRepository);
  const selectedLabel = selectedWorkspace ? workspaceLabel(selectedWorkspace) : "Select repo";

  const handleSelect = useCallback(
    async (workspaceId: string) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) return;
      setSavingWorkspaceId(workspaceId);
      try {
        await client.setWorkspaceChatRepository(workspaceId, true);
      } finally {
        setSavingWorkspaceId(null);
      }
    },
    [serverId],
  );

  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Main chat repo</Text>
        <Text style={settingsStyles.rowHint}>
          Office chats create workspaces from this repository.
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger style={triggerStyle} accessibilityLabel="Select main chat repo">
          <Text style={styles.triggerText} numberOfLines={1}>
            {savingWorkspaceId ? "Saving..." : selectedLabel}
          </Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={320}>
          {workspaces.length === 0 ? (
            <DropdownMenuItem disabled>No workspaces</DropdownMenuItem>
          ) : (
            workspaces.map((workspace) => (
              <WorkspaceMenuItem key={workspace.id} workspace={workspace} onSelect={handleSelect} />
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function WorkspaceMenuItem({
  workspace,
  onSelect,
}: {
  workspace: WorkspaceDescriptor;
  onSelect: (workspaceId: string) => Promise<void>;
}) {
  const handleSelect = useCallback(() => {
    void onSelect(workspace.id);
  }, [onSelect, workspace.id]);
  return (
    <DropdownMenuItem selected={workspace.chatRepository === true} onSelect={handleSelect}>
      {workspaceLabel(workspace)}
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
  providers: AgentProvider[];
}) {
  const label = draft.provider || "Provider";
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
              key={provider}
              provider={provider}
              selected={draft.provider === provider}
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
  provider: AgentProvider;
  selected: boolean;
  draft: ChatDefaultsDraft;
  setDraft: (draft: ChatDefaultsDraft) => void;
}) {
  const handleSelect = useCallback(() => {
    setDraft({ ...draft, provider });
  }, [draft, provider, setDraft]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {provider}
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
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChangeText: (value: string) => void;
  border?: boolean;
}) {
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
        style={styles.input}
      />
    </View>
  );
}

export function ChatOfficePage({ serverId }: ChatOfficePageProps) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const providersSnapshot = useProvidersSnapshot(serverId, { cwd: null });
  const providerIds = useMemo(
    () =>
      (providersSnapshot.entries ?? [])
        .filter((entry) => entry.status !== "unavailable")
        .map((entry) => entry.provider),
    [providersSnapshot.entries],
  );
  const [draft, setDraft] = useState<ChatDefaultsDraft>(() => defaultsFromConfig(config));
  const [saving, setSaving] = useState(false);
  const committedDraft = useMemo(() => defaultsFromConfig(config), [config]);
  const normalizedDraft = useMemo(() => normalizeDraft(draft), [draft]);
  const hasChanges = JSON.stringify(normalizedDraft) !== JSON.stringify(committedDraft);

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
    (model: string) => setDraft((current) => ({ ...current, model })),
    [],
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
          <ChatRepositoryRow serverId={serverId} />
          <ProviderRow draft={draft} setDraft={setDraft} providers={providerIds} />
          <TextSettingRow
            label="Default model"
            hint="Exact model id passed to the provider."
            value={draft.model}
            placeholder="openai-codex/gpt-5.5"
            onChangeText={handleModelChange}
          />
          <TextSettingRow
            label="Default mode"
            hint="Provider mode id for new office chat sessions."
            value={draft.modeId}
            placeholder="medium"
            onChangeText={handleModeIdChange}
          />
          <TextSettingRow
            label="Thinking"
            hint="Optional thinking or reasoning level."
            value={draft.thinkingOptionId}
            placeholder="default"
            onChangeText={handleThinkingOptionIdChange}
          />
        </View>
      </SettingsSection>
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
