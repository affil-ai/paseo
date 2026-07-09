import { Text, type StyleProp, type TextStyle } from "react-native";
import { useRelativeTimeClock } from "@/hooks/use-relative-time-clock";
import { formatCompactTimeAgo } from "@/utils/time";

export function WorkspaceRecencyLabel({
  timestampMs,
  style,
}: {
  timestampMs: number;
  style?: StyleProp<TextStyle>;
}) {
  useRelativeTimeClock();
  const now = new Date();
  return (
    <Text style={style} numberOfLines={1}>
      {formatCompactTimeAgo(new Date(timestampMs), now)}
    </Text>
  );
}
