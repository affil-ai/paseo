import Svg, { Path } from "react-native-svg";

interface SlackIconProps {
  size?: number;
}

/** Slack's full-color brand mark, kept independent of the active app theme. */
export function SlackIcon({ size = 16 }: SlackIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 127 127">
      <Path
        fill="#E01E5A"
        d="M27.2 80c0 7.5-6.1 13.6-13.6 13.6S0 87.5 0 80s6.1-13.6 13.6-13.6h13.6V80Zm6.9 0c0-7.5 6.1-13.6 13.6-13.6S61.3 72.5 61.3 80v34.1c0 7.5-6.1 13.6-13.6 13.6s-13.6-6.1-13.6-13.6V80Z"
      />
      <Path
        fill="#36C5F0"
        d="M47.7 27.2c-7.5 0-13.6-6.1-13.6-13.6S40.2 0 47.7 0s13.6 6.1 13.6 13.6v13.6H47.7Zm0 6.9c7.5 0 13.6 6.1 13.6 13.6s-6.1 13.6-13.6 13.6H13.6C6.1 61.3 0 55.2 0 47.7s6.1-13.6 13.6-13.6h34.1Z"
      />
      <Path
        fill="#2EB67D"
        d="M99.9 47.7c0-7.5 6.1-13.6 13.6-13.6s13.6 6.1 13.6 13.6-6.1 13.6-13.6 13.6H99.9V47.7Zm-6.8 0c0 7.5-6.1 13.6-13.6 13.6s-13.6-6.1-13.6-13.6V13.6C65.9 6.1 72 0 79.5 0s13.6 6.1 13.6 13.6v34.1Z"
      />
      <Path
        fill="#ECB22E"
        d="M79.5 99.9c7.5 0 13.6 6.1 13.6 13.6s-6.1 13.6-13.6 13.6-13.6-6.1-13.6-13.6V99.9h13.6Zm0-6.8c-7.5 0-13.6-6.1-13.6-13.6s6.1-13.6 13.6-13.6h34.1c7.5 0 13.6 6.1 13.6 13.6s-6.1 13.6-13.6 13.6H79.5Z"
      />
    </Svg>
  );
}
