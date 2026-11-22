import { createSignal, onSettled } from "solid-js";
import { parseDashboardView, type DashboardView } from "~/lib/dashboard-view";
import { publishLocationSearchParams, readLocationSearchParam, subscribeLocationSearch } from "~/lib/location-search-param";

export function useDashboardRouteParam() {
  const [dashboardView, setDashboardView] = createSignal<DashboardView | null>(null);

  onSettled(() => {
    const syncDashboardView = () => setDashboardView(parseDashboardView(readLocationSearchParam("dashboard")));
    syncDashboardView();

    return subscribeLocationSearch(syncDashboardView);
  });

  const setDashboardParam = (view: DashboardView | null) => {
    publishLocationSearchParams([{ name: "dashboard", value: view }]);
    setDashboardView(view);
  };

  return { dashboardView, setDashboardParam };
}
