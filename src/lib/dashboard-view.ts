export type DashboardView = "general" | "audio" | "account" | "projects" | "files" | "samples" | "timeline" | "keyboard" | "export" | "plugins";

const dashboardViews: readonly DashboardView[] = ["general", "audio", "account", "projects", "files", "samples", "timeline", "keyboard", "export", "plugins"];

export const parseDashboardView = (value: string | null): DashboardView | null => {
  if (!value) return null;

  return dashboardViews.find((view) => view === value) ?? null;
};
