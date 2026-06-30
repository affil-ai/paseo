import { useMemo, type CSSProperties } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface HtmlArtifactPreviewProps {
  html: string;
  filePath: string;
}

const IFRAME_STYLE: CSSProperties = {
  border: 0,
  width: "100%",
  height: "100%",
};

export function HtmlArtifactPreview({ html, filePath }: HtmlArtifactPreviewProps) {
  const title = useMemo(() => `Rendered ${filePath}`, [filePath]);

  return (
    <View style={styles.container}>
      <iframe
        title={title}
        srcDoc={html}
        sandbox="allow-forms allow-modals allow-popups allow-scripts"
        referrerPolicy="no-referrer"
        style={IFRAME_STYLE}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
}));
