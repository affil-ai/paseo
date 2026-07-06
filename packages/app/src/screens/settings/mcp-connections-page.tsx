import { useCallback, useMemo, useState } from "react";
import { Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

type RemoteMcpType = "http" | "sse";
type MutableMcpConnectionConfig = MutableDaemonConfig["mcpConnections"]["servers"][string];

interface McpConnectionEntry {
  name: string;
  enabled: boolean;
  type: string;
  url: string;
  authorization: string;
  raw: MutableMcpConnectionConfig;
}

interface McpConnectionDraft {
  name: string;
  type: RemoteMcpType;
  url: string;
  authorization: string;
}

const EMPTY_DRAFT: McpConnectionDraft = {
  name: "",
  type: "http",
  url: "",
  authorization: "",
};

const ROW_WITH_BORDER_STYLE = [settingsStyles.row, settingsStyles.rowBorder];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function triggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

function readConnections(config: MutableDaemonConfig | null): McpConnectionEntry[] {
  const servers = config?.mcpConnections.servers ?? {};
  return Object.entries(servers)
    .flatMap(([name, value]) => {
      if (!isRecord(value) || !isRecord(value.server)) {
        return [];
      }
      const server = value.server;
      const headers = isRecord(server.headers) ? server.headers : {};
      const authorization = typeof headers.Authorization === "string" ? headers.Authorization : "";
      return [
        {
          name,
          enabled: value.enabled !== false,
          type: typeof server.type === "string" ? server.type : "unknown",
          url: typeof server.url === "string" ? server.url : "",
          authorization,
          raw: value,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildServersPatch(entries: McpConnectionEntry[]): MutableDaemonConfigPatch {
  return {
    mcpConnections: {
      servers: Object.fromEntries(entries.map((entry) => [entry.name, entry.raw])),
    },
  };
}

function draftToEntry(draft: McpConnectionDraft): McpConnectionEntry {
  const name = draft.name.trim();
  const authorization = draft.authorization.trim();
  const server = {
    type: draft.type,
    url: draft.url.trim(),
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
  } as const;
  const raw: MutableMcpConnectionConfig = {
    enabled: true,
    server,
  };
  return {
    name,
    enabled: true,
    type: draft.type,
    url: draft.url.trim(),
    authorization,
    raw,
  };
}

function draftFromEntry(entry: McpConnectionEntry): McpConnectionDraft {
  return {
    name: entry.name,
    type: entry.type === "sse" ? "sse" : "http",
    url: entry.url,
    authorization: entry.authorization,
  };
}

function isDraftValid(draft: McpConnectionDraft): boolean {
  return draft.name.trim().length > 0 && draft.url.trim().length > 0;
}

function TypeMenuItem({
  type,
  selected,
  onSelect,
}: {
  type: RemoteMcpType;
  selected: boolean;
  onSelect: (type: RemoteMcpType) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(type);
  }, [onSelect, type]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {type.toUpperCase()}
    </DropdownMenuItem>
  );
}

function TypePicker({
  value,
  onChange,
}: {
  value: RemoteMcpType;
  onChange: (type: RemoteMcpType) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger style={triggerStyle} accessibilityLabel="Select MCP transport">
        <Text style={styles.triggerText}>{value.toUpperCase()}</Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" width={160}>
        <TypeMenuItem type="http" selected={value === "http"} onSelect={onChange} />
        <TypeMenuItem type="sse" selected={value === "sse"} onSelect={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TextRow({
  label,
  hint,
  value,
  placeholder,
  onChangeText,
  secureTextEntry = false,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={ROW_WITH_BORDER_STYLE}>
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

function ConnectionRow({
  entry,
  onEdit,
  onToggle,
  onRemove,
}: {
  entry: McpConnectionEntry;
  onEdit: (name: string) => void;
  onToggle: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const handleEdit = useCallback(() => {
    onEdit(entry.name);
  }, [entry.name, onEdit]);
  const handleToggle = useCallback(() => {
    onToggle(entry.name);
  }, [entry.name, onToggle]);
  const handleRemove = useCallback(() => {
    onRemove(entry.name);
  }, [entry.name, onRemove]);
  return (
    <View style={ROW_WITH_BORDER_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{entry.name}</Text>
        <Text style={settingsStyles.rowHint}>
          {entry.type.toUpperCase()} · {entry.url || "No URL"} ·{" "}
          {entry.enabled ? "Enabled" : "Disabled"}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button size="sm" variant="ghost" onPress={handleEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onPress={handleToggle}>
          {entry.enabled ? "Disable" : "Enable"}
        </Button>
        <Button size="sm" variant="ghost" onPress={handleRemove}>
          Remove
        </Button>
      </View>
    </View>
  );
}

export function McpConnectionsPage({ serverId }: { serverId: string }) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const connections = useMemo(() => readConnections(config), [config]);
  const [draft, setDraft] = useState<McpConnectionDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const handleTypeChange = useCallback((type: RemoteMcpType) => {
    setDraft((current) => ({ ...current, type }));
  }, []);
  const handleNameChange = useCallback((name: string) => {
    setDraft((current) => ({ ...current, name }));
  }, []);
  const handleUrlChange = useCallback((url: string) => {
    setDraft((current) => ({ ...current, url }));
  }, []);
  const handleAuthorizationChange = useCallback((authorization: string) => {
    setDraft((current) => ({ ...current, authorization }));
  }, []);
  const handleReset = useCallback(() => {
    setDraft(EMPTY_DRAFT);
  }, []);
  const handleEdit = useCallback(
    (name: string) => {
      const entry = connections.find((connection) => connection.name === name);
      if (entry) {
        setDraft(draftFromEntry(entry));
      }
    },
    [connections],
  );
  const saveEntries = useCallback(
    async (entries: McpConnectionEntry[]) => {
      setSaving(true);
      try {
        await patchConfig(buildServersPatch(entries));
      } finally {
        setSaving(false);
      }
    },
    [patchConfig],
  );
  const handleSave = useCallback(async () => {
    if (!isDraftValid(draft)) {
      return;
    }
    const nextEntry = draftToEntry(draft);
    const remaining = connections.filter((entry) => entry.name !== nextEntry.name);
    await saveEntries([...remaining, nextEntry]);
    setDraft(EMPTY_DRAFT);
  }, [connections, draft, saveEntries]);
  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);
  const handleToggle = useCallback(
    (name: string) => {
      const next = connections.map((entry) =>
        entry.name === name
          ? {
              ...entry,
              enabled: !entry.enabled,
              raw: { ...entry.raw, enabled: !entry.enabled },
            }
          : entry,
      );
      void saveEntries(next);
    },
    [connections, saveEntries],
  );
  const handleRemove = useCallback(
    (name: string) => {
      void saveEntries(connections.filter((entry) => entry.name !== name));
    },
    [connections, saveEntries],
  );

  return (
    <View>
      <SettingsSection title="MCP connections">
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Transport</Text>
              <Text style={settingsStyles.rowHint}>
                Global connections are injected into new provider sessions.
              </Text>
            </View>
            <TypePicker value={draft.type} onChange={handleTypeChange} />
          </View>
          <TextRow
            label="Name"
            hint="Stable id used in provider MCP config."
            value={draft.name}
            placeholder="executor"
            onChangeText={handleNameChange}
          />
          <TextRow
            label="URL"
            hint="Remote MCP endpoint."
            value={draft.url}
            placeholder="https://example.com/mcp"
            onChangeText={handleUrlChange}
          />
          <TextRow
            label="Authorization"
            hint="Optional full Authorization header value."
            value={draft.authorization}
            placeholder="Bearer ..."
            onChangeText={handleAuthorizationChange}
            secureTextEntry
          />
          <View style={ROW_WITH_BORDER_STYLE}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Save connection</Text>
              <Text style={settingsStyles.rowHint}>
                Existing connections with the same name are replaced.
              </Text>
            </View>
            <View style={styles.actions}>
              <Button size="sm" variant="ghost" onPress={handleReset}>
                Clear
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!isDraftValid(draft) || saving}
                onPress={handleSavePress}
              >
                {saving ? "Saving" : "Save"}
              </Button>
            </View>
          </View>
        </View>
      </SettingsSection>
      <SettingsSection title="Configured">
        <View style={settingsStyles.card}>
          {connections.length === 0 ? (
            <View style={settingsStyles.row}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>No MCP connections</Text>
                <Text style={settingsStyles.rowHint}>
                  Add a connection above to make it available to providers.
                </Text>
              </View>
            </View>
          ) : (
            connections.map((entry) => (
              <ConnectionRow
                key={entry.name}
                entry={entry}
                onEdit={handleEdit}
                onToggle={handleToggle}
                onRemove={handleRemove}
              />
            ))
          )}
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
    minWidth: 280,
    paddingHorizontal: theme.spacing[3],
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
