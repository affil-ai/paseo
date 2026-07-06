import { useCallback } from "react";
import { useHostChooser } from "@/hosts/host-chooser";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useProjectPickerStore } from "@/stores/project-picker-store";

export function useOpenProjectPicker(): () => void {
  const chooseHost = useHostChooser();
  const openProjectPicker = useProjectPickerStore((state) => state.open);
  const routeServerId = useHostRouteServerId();

  return useCallback(() => {
    if (routeServerId) {
      openProjectPicker(routeServerId);
      return;
    }
    chooseHost({
      title: "Choose host",
      onChooseHost: openProjectPicker,
    });
  }, [chooseHost, openProjectPicker, routeServerId]);
}
