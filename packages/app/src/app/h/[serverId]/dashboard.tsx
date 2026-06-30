import { Redirect } from "expo-router";
import { buildDashboardRoute } from "@/utils/host-routes";

export default function HostDashboardRoute() {
  return <Redirect href={buildDashboardRoute()} />;
}
