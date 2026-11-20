import { createSignal, onCleanup, onMount } from "solid-js";
import { parseDashboardView, type DashboardView } from "~/lib/dashboard-view";
import { publishLocationSearchParams, readLocationSearchParam, subscribeLocationSearch } from "~/lib/location-search-param";

export function useDashboardRouteParam() {
  const [dashboardView, setDashboardView] = createSignal<DashboardView | null>(null);

  onMount(() => {
    const syncDashboardView = () => setDashboardView(parseDashboardView(readLocationSearchParam("dashboard")));
    syncDashboardView();
    onCleanup(subscribeLocationSearch(syncDashboardView));
  });

  const setDashboardParam = (view: DashboardView | null) => {
    publishLocationSearchParams([{ name: "dashboard", value: view }]);
    setDashboardView(view);
  };

  return { dashboardView, setDashboardParam };
}
