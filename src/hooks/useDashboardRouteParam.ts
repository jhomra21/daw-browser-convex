import { createSignal, onCleanup, onMount } from "solid-js";
import { parseDashboardView, type DashboardView } from "~/components/dashboard/types";
import { readLocationSearchParam, writeLocationSearchParam } from "~/lib/location-search-param";

const writeDashboardRouteParam = (view: DashboardView | null) => {
  writeLocationSearchParam("dashboard", view);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export function useDashboardRouteParam() {
  const [dashboardView, setDashboardView] = createSignal<DashboardView | null>(null);

  onMount(() => {
    const syncDashboardView = () => setDashboardView(parseDashboardView(readLocationSearchParam("dashboard")));
    syncDashboardView();
    window.addEventListener("popstate", syncDashboardView);
    onCleanup(() => window.removeEventListener("popstate", syncDashboardView));
  });

  const setDashboardParam = (view: DashboardView | null) => {
    writeDashboardRouteParam(view);
    setDashboardView(view);
  };

  return { dashboardView, setDashboardParam };
}
