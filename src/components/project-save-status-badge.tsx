import type { JSX } from "solid-js";
import { getProjectSaveStatus, type ProjectSaveStatusInput } from "~/lib/project-save-status";
import { cn } from "~/lib/utils";

type ProjectSaveStatusBadgeProps = ProjectSaveStatusInput & {
  label: "short" | "compact";
  class?: string;
};

export function ProjectSaveStatusBadge(props: ProjectSaveStatusBadgeProps): JSX.Element {
  const status = () => getProjectSaveStatus(props);
  const label = () => props.label === "compact" ? status().compactLabel : status().shortLabel;

  return (
    <span class={cn("border px-2 py-1 text-[11px] font-medium", status().class, props.class)}>
      {label()}
    </span>
  );
}
