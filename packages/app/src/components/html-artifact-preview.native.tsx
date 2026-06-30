import { useMemo } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { StyleSheet } from "react-native-unistyles";

interface HtmlArtifactPreviewProps {
  html: string;
  filePath: string;
}

const ORIGIN_WHITELIST = ["about:blank"];

export function HtmlArtifactPreview({ html, filePath }: HtmlArtifactPreviewProps) {
  const source = useMemo(() => ({ html, baseUrl: "about:blank" }), [html]);

  return (
    <View style={styles.container}>
      <WebView
        testID="html-artifact-preview"
        source={source}
        originWhitelist={ORIGIN_WHITELIST}
        style={styles.webView}
        javaScriptEnabled
        domStorageEnabled={false}
        allowsBackForwardNavigationGestures={false}
        automaticallyAdjustContentInsets={false}
        setSupportMultipleWindows={false}
        allowingReadAccessToURL="about:blank"
        accessibilityLabel={filePath}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  webView: {
    flex: 1,
  },
}));
